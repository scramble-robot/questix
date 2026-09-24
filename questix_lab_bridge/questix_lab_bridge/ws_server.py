"""WebSocket fan-out used by the QUESTiX LAB bridge node.

The server runs an asyncio loop on its own thread. ROS callbacks hand payloads over
with :meth:`LabWebSocketServer.publish` (every browser) or :meth:`publish_to` (one);
each client keeps only the newest payload per stream, so a slow browser drops frames
instead of building a backlog.

Each connection gets an integer id. Text a browser sends is handed to ``on_message(id,
text)`` on the server thread, and ``on_disconnect(id)`` runs when it goes away; without
those callbacks everything a browser sends is discarded. The bridge node decides what,
if anything, a message may do (drive.py): this module never drives the robot itself.

Plain HTTP requests on the same port (a browser opening ``http://<robot>:8897/``) are
answered with the QUESTiX LAB static site instead of failing the WebSocket handshake.
"""

import asyncio
import http
from pathlib import Path
import threading

import websockets

from .static_site import static_response

try:
    # websockets >= 13: process_request(connection, request) -> Response | None
    from websockets.asyncio.server import serve as _serve
    from websockets.datastructures import Headers
    from websockets.http11 import Response
    _LEGACY_API = False
except ImportError:
    # websockets 10-12 (python3-websockets on Ubuntu 24.04):
    # process_request(path, request_headers) -> (status, headers, body) | None
    _serve = websockets.serve
    _LEGACY_API = True

# Browsers only send short drive/stop requests, so keep their frames tiny.
_MAX_INCOMING_BYTES = 1024


def _is_websocket_upgrade(headers):
    return headers.get('Upgrade', '').lower() == 'websocket'


class _Client:
    def __init__(self, client_id):
        self.id = client_id
        self.slots = {}
        self.event = asyncio.Event()


class LabWebSocketServer:

    def __init__(self, host, port, hello_text, max_clients=8, logger=None, site_dir=None,
                 greeting=None, on_message=None, on_disconnect=None):
        """``greeting(id)`` returns text frames sent right after ``hello`` to that client."""
        self._greeting = greeting
        self._on_message = on_message
        self._on_disconnect = on_disconnect
        self._next_id = 1
        self._site_dir = None if site_dir is None else Path(site_dir).resolve()
        self._host = host
        self._port = port
        self._hello_text = hello_text
        self._max_clients = max_clients
        self._logger = logger
        self._clients = set()
        self._loop = None
        self._stop = None
        self._thread = None
        self._ready = threading.Event()
        self._error = None
        self.port = None

    @property
    def client_count(self):
        return len(self._clients)

    def start(self, timeout=5.0):
        """Start serving; raise if the socket cannot be bound."""
        self._thread = threading.Thread(target=self._run, name='lab_bridge_ws', daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout):
            raise RuntimeError('WebSocket server did not start in time')
        if self._error is not None:
            raise self._error

    def stop(self, timeout=5.0):
        if self._loop is not None and self._stop is not None:
            self._loop.call_soon_threadsafe(self._stop.set)
        if self._thread is not None:
            self._thread.join(timeout)

    def publish(self, stream, payload):
        """Offer the newest payload (str = JSON text, bytes = camera image) of a stream."""
        if self._loop is None or not self._clients:
            return
        self._loop.call_soon_threadsafe(self._offer, stream, payload)

    def publish_to(self, client_id, stream, payload):
        """Offer a payload to one client only (e.g. the answer to its own request)."""
        if self._loop is None:
            return
        self._loop.call_soon_threadsafe(self._offer, stream, payload, client_id)

    def _offer(self, stream, payload, client_id=None):
        for client in self._clients:
            if client_id is not None and client.id != client_id:
                continue
            client.slots[stream] = payload
            client.event.set()

    def _run(self):
        self._loop = asyncio.new_event_loop()
        try:
            self._loop.run_until_complete(self._main())
        except Exception as error:  # noqa: B902 - reported to start() instead of lost
            self._error = error
            self._ready.set()
        finally:
            self._loop.close()

    async def _main(self):
        self._stop = asyncio.Event()
        process_request = self._http_legacy if _LEGACY_API else self._http
        async with _serve(
                self._handler, self._host, self._port, max_size=_MAX_INCOMING_BYTES,
                process_request=process_request) as server:
            self.port = server.sockets[0].getsockname()[1]
            self._ready.set()
            await self._stop.wait()

    async def _http(self, connection, request):
        if _is_websocket_upgrade(request.headers):
            return None
        status, headers, body = static_response(self._site_dir, request.path)
        return Response(status, http.HTTPStatus(status).phrase, Headers(headers), body)

    async def _http_legacy(self, path, request_headers):
        if _is_websocket_upgrade(request_headers):
            return None
        status, headers, body = static_response(self._site_dir, path)
        return http.HTTPStatus(status), headers, body

    async def _handler(self, websocket):
        if len(self._clients) >= self._max_clients:
            await websocket.close(1013, 'too many clients')
            return
        client = _Client(self._next_id)
        self._next_id += 1
        self._clients.add(client)
        self._log('client %d connected (%d)' % (client.id, len(self._clients)))
        sender = None
        try:
            # hello always precedes stream data, so the page knows the geometry first.
            await websocket.send(self._hello_text)
            for text in self._greeting(client.id) if self._greeting else ():
                await websocket.send(text)
            client.slots.clear()
            sender = asyncio.ensure_future(self._sender(websocket, client))
            async for message in websocket:
                if self._on_message is not None and isinstance(message, str):
                    self._call(self._on_message, client.id, message)
        except websockets.ConnectionClosed:
            pass
        finally:
            if sender is not None:
                sender.cancel()
            self._clients.discard(client)
            if self._on_disconnect is not None:
                self._call(self._on_disconnect, client.id)
            self._log('client %d disconnected (%d)' % (client.id, len(self._clients)))

    def _call(self, callback, *args):
        # A failing callback must not take the connection (or the robot's stop path) down.
        try:
            callback(*args)
        except Exception as error:  # noqa: B902 - logged, the connection stays up
            if self._logger is not None:
                self._logger.error('WebSocket callback failed: %r' % (error,))

    async def _sender(self, websocket, client):
        try:
            while True:
                await client.event.wait()
                client.event.clear()
                while client.slots:
                    stream = next(iter(client.slots))
                    await websocket.send(client.slots.pop(stream))
        except websockets.ConnectionClosed:
            pass

    def _log(self, text):
        if self._logger is not None:
            self._logger.info(text)
