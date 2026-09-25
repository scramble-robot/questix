"""WebSocket/HTTP server that feeds browser joy frames into a callback.

The server runs an asyncio loop on a private thread so it can coexist with
``rclpy.spin``. It works with both the legacy ``websockets`` API shipped on
Ubuntu 24.04 (``python3-websockets`` 10.x) and the ``websockets.asyncio``
API (13+).

Endpoints:

* ``GET /`` and ``GET /index.html``: the controller page (single HTML file).
* ``GET /ws`` (WebSocket upgrade): joy frame stream, JSON text messages.
  Server → client additionally carries *binary* messages: one encoded camera
  image (JPEG/PNG bytes, see ``push_camera_frame``) per message.

Control policy: the most recently connected client becomes the *active*
controller; the previous one receives ``{"type": "released"}`` and is closed.
Frames from non-active connections are ignored. This makes reconnecting after
a Wi-Fi drop painless while never mixing two operators.
"""

import asyncio
import json
import logging
import threading
from http import HTTPStatus
from typing import Any, Callable, Dict, Optional, Set
from urllib.parse import parse_qs, urlsplit

from .joy_frame import FrameError

try:  # websockets >= 13
    from websockets.asyncio.server import serve as _serve

    _LEGACY_API = False
except ImportError:  # websockets 10.x (Ubuntu 24.04 python3-websockets)
    from websockets.server import serve as _serve

    _LEGACY_API = True

try:
    from websockets.exceptions import ConnectionClosed
except ImportError:  # pragma: no cover - very old websockets
    ConnectionClosed = Exception  # type: ignore[misc,assignment]

WS_PATH = "/ws"
INDEX_PATHS = ("/", "/index.html")
CLOSE_TAKEN_OVER = 4000  # application close code sent to the replaced controller
MAX_FRAME_BYTES = 4096  # client -> server only; camera frames go the other way

FrameCallback = Callable[[Dict[str, Any]], None]
ReleaseCallback = Callable[[], None]
StatusProvider = Callable[[], Dict[str, Any]]


class JoyWebSocketServer:
    """Serve the controller page and relay joy frames to ``on_frame``."""

    def __init__(
        self,
        host: str,
        port: int,
        index_html: bytes,
        on_frame: FrameCallback,
        on_release: ReleaseCallback,
        status_provider: StatusProvider,
        token: str = "",
        ping_interval_sec: float = 1.0,
        ping_timeout_sec: float = 2.0,
        status_period_sec: float = 0.2,
        close_timeout_sec: float = 1.0,
        camera_max_fps: float = 15.0,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        """Configure the server; call ``start`` to run it on a thread.

        ``camera_max_fps`` caps how often ``push_camera_frame`` data is
        forwarded to browsers (``<= 0`` forwards every frame).
        """
        self._host = host
        self._port = port
        self._index_html = index_html
        self._on_frame = on_frame
        self._on_release = on_release
        self._status_provider = status_provider
        self._token = token
        self._ping_interval = ping_interval_sec
        self._ping_timeout = ping_timeout_sec
        self._status_period = status_period_sec
        self._close_timeout = close_timeout_sec
        self._camera_min_interval = 1.0 / camera_max_fps if camera_max_fps > 0.0 else 0.0
        self._log = logger or logging.getLogger(__name__)

        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._stop_event: Optional[asyncio.Event] = None
        self._thread: Optional[threading.Thread] = None
        self._started = threading.Event()
        self._start_error: Optional[BaseException] = None
        self._bound_port: Optional[int] = None
        self._connections: Set[Any] = set()
        self._active: Optional[Any] = None
        self._rejected_frames = 0
        # Latest camera frame, replaced (never queued) so a slow link shows the
        # newest image instead of a growing backlog. Only touched on the loop.
        self._camera_frame: Optional[bytes] = None
        self._camera_event: Optional[asyncio.Event] = None
        self._camera_busy: Set[Any] = set()  # connections with a camera send in flight
        self._camera_sent = 0
        self._camera_dropped = 0

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    @property
    def bound_port(self) -> Optional[int]:
        """Return the TCP port actually bound (useful when ``port`` is 0)."""
        return self._bound_port

    @property
    def legacy_api(self) -> bool:
        """Return ``True`` when running on the legacy ``websockets`` API."""
        return _LEGACY_API

    def start(self, timeout_sec: float = 5.0) -> None:
        """Start the server thread and block until it is listening."""
        self._thread = threading.Thread(target=self._run, name="web_joy_ws", daemon=True)
        self._thread.start()
        if not self._started.wait(timeout_sec):
            raise RuntimeError("WebSocket server did not start in time")
        if self._start_error is not None:
            raise self._start_error

    def stop(self, timeout_sec: float = 5.0) -> None:
        """Stop the server thread and wait for it to exit."""
        if self._loop is not None and self._stop_event is not None:
            self._loop.call_soon_threadsafe(self._stop_event.set)
        if self._thread is not None:
            self._thread.join(timeout_sec)

    def _run(self) -> None:
        try:
            asyncio.run(self._main())
        except BaseException as exc:  # noqa: BLE001 - surface startup failures to start()
            self._start_error = exc
            self._started.set()

    # ------------------------------------------------------------------
    # Camera relay (called from any thread)
    # ------------------------------------------------------------------
    def push_camera_frame(self, data: bytes) -> None:
        """Queue one encoded image (JPEG/PNG bytes) for delivery to every client.

        Safe to call from the ROS executor thread. Frames arriving faster than
        ``camera_max_fps`` or faster than a client can read are dropped, so
        this never blocks and never grows a backlog.
        """
        loop = self._loop
        if loop is None or self._stop_event is None or self._stop_event.is_set():
            return
        try:
            loop.call_soon_threadsafe(self._set_camera_frame, bytes(data))
        except RuntimeError:  # loop already closed during shutdown
            pass

    @property
    def camera_stats(self) -> Dict[str, int]:
        """Return counters of camera frames sent to / dropped for clients."""
        return {"sent": self._camera_sent, "dropped": self._camera_dropped}

    def _set_camera_frame(self, data: bytes) -> None:
        if self._camera_frame is not None and self._camera_event is not None \
                and self._camera_event.is_set():
            self._camera_dropped += 1  # previous frame was never picked up
        self._camera_frame = data
        if self._camera_event is not None:
            self._camera_event.set()

    async def _camera_loop(self) -> None:
        loop = asyncio.get_running_loop()
        last_sent = -1e9
        while True:
            assert self._camera_event is not None
            await self._camera_event.wait()
            wait = self._camera_min_interval - (loop.time() - last_sent)
            if wait > 0.0:
                await asyncio.sleep(wait)  # the latest frame is taken after the wait
            self._camera_event.clear()
            frame = self._camera_frame
            if frame is None:
                continue
            last_sent = loop.time()
            for ws in list(self._connections):
                if ws in self._camera_busy:
                    self._camera_dropped += 1  # client still reading the previous image
                    continue
                self._camera_busy.add(ws)
                asyncio.ensure_future(self._send_camera(ws, frame))

    async def _send_camera(self, ws: Any, frame: bytes) -> None:
        try:
            await asyncio.wait_for(ws.send(frame), self._close_timeout)
            self._camera_sent += 1
        except Exception:  # noqa: BLE001 - peer gone or not reading; keepalive drops it
            self._camera_dropped += 1
        finally:
            self._camera_busy.discard(ws)

    async def _main(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._stop_event = asyncio.Event()
        self._camera_event = asyncio.Event()
        kwargs: Dict[str, Any] = dict(
            process_request=self._process_request,
            ping_interval=self._ping_interval,
            ping_timeout=self._ping_timeout,
            # Bound the closing handshake: a peer that stopped reading must not
            # stall takeover or shutdown for the library default of 10 s.
            close_timeout=self._close_timeout,
            max_size=MAX_FRAME_BYTES,
        )
        async with _serve(self._handler, self._host, self._port, **kwargs) as server:
            sockets = getattr(server, "sockets", None) or []
            for sock in sockets:
                self._bound_port = sock.getsockname()[1]
                break
            status_task = asyncio.ensure_future(self._status_loop())
            camera_task = asyncio.ensure_future(self._camera_loop())
            self._started.set()
            try:
                await self._stop_event.wait()
            finally:
                status_task.cancel()
                camera_task.cancel()
                for ws in list(self._connections):
                    try:
                        await ws.close()
                    except Exception:  # noqa: BLE001
                        pass

    # ------------------------------------------------------------------
    # HTTP handling (both websockets APIs)
    # ------------------------------------------------------------------
    def _route(self, path: str, upgrade_header: str):
        """Return ``None`` to accept a WebSocket upgrade or ``(status, ctype, body)``."""
        parts = urlsplit(path)
        is_upgrade = upgrade_header.lower() == "websocket"
        if parts.path == WS_PATH:
            if not is_upgrade:
                return HTTPStatus.UPGRADE_REQUIRED, "text/plain", b"websocket upgrade required\n"
            if self._token:
                supplied = parse_qs(parts.query).get("token", [""])[0]
                if supplied != self._token:
                    return HTTPStatus.UNAUTHORIZED, "text/plain", b"invalid token\n"
            return None
        if parts.path in INDEX_PATHS:
            return HTTPStatus.OK, "text/html; charset=utf-8", self._index_html
        return HTTPStatus.NOT_FOUND, "text/plain", b"not found\n"

    async def _process_request(self, *args):
        if _LEGACY_API:
            path, headers = args
            routed = self._route(path, headers.get("Upgrade", ""))
            if routed is None:
                return None
            status, ctype, body = routed
            return status, [("Content-Type", ctype), ("Cache-Control", "no-store")], body
        connection, request = args
        routed = self._route(request.path, request.headers.get("Upgrade", ""))
        if routed is None:
            return None
        status, ctype, body = routed
        # respond() encodes the text and sets Content-Length; only the type needs fixing.
        response = connection.respond(status, body.decode("utf-8"))
        del response.headers["Content-Type"]
        response.headers["Content-Type"] = ctype
        response.headers["Cache-Control"] = "no-store"
        return response

    # ------------------------------------------------------------------
    # WebSocket handling
    # ------------------------------------------------------------------
    @staticmethod
    def _peer(ws: Any) -> str:
        addr = getattr(ws, "remote_address", None)
        if isinstance(addr, tuple) and len(addr) >= 2:
            return f"{addr[0]}:{addr[1]}"
        return str(addr)

    async def _send_json(self, ws: Any, payload: Dict[str, Any], timeout: Optional[float] = None) -> bool:
        """Send ``payload`` as JSON; return ``False`` if it failed or timed out.

        A peer that stopped reading (backgrounded browser) applies TCP back
        pressure; ``timeout`` keeps one such peer from stalling the caller.
        """
        try:
            await asyncio.wait_for(ws.send(json.dumps(payload, separators=(",", ":"))), timeout)
            return True
        except Exception:  # noqa: BLE001 - peer may already be gone / not reading
            return False

    async def _retire(self, ws: Any, reason: str) -> None:
        """Tell a replaced controller it lost control and close it (never blocks callers)."""
        await self._send_json(ws, {"type": "released", "reason": reason}, timeout=self._close_timeout)
        try:
            await asyncio.wait_for(ws.close(CLOSE_TAKEN_OVER, "taken over by another client"),
                                   self._close_timeout * 2)
        except Exception:  # noqa: BLE001
            pass

    async def _handler(self, ws: Any, *_ignored: Any) -> None:
        peer = self._peer(ws)
        self._connections.add(ws)
        previous = self._active
        self._active = ws
        if previous is not None and previous is not ws:
            self._log.warning("controller taken over: %s replaces %s", peer, self._peer(previous))
            # Retire the old client in the background so the new controller's
            # frames are processed immediately even if the old peer is stuck.
            asyncio.ensure_future(self._retire(previous, "taken_over"))
        else:
            self._log.info("controller connected: %s", peer)
        await self._send_json(ws, {"type": "welcome", "controller": True})
        try:
            async for message in ws:
                if ws is not self._active:
                    continue
                if isinstance(message, bytes):
                    self._reject_frame("binary frame")
                    continue
                try:
                    payload = json.loads(message)
                except ValueError:
                    self._reject_frame("invalid JSON")
                    continue
                try:
                    self._on_frame(payload)
                except FrameError as exc:
                    self._reject_frame(str(exc))
        except ConnectionClosed:
            pass
        finally:
            self._connections.discard(ws)
            if self._active is ws:
                self._active = None
                self._log.info("controller disconnected: %s", peer)
                self._on_release()

    def _reject_frame(self, reason: str) -> None:
        self._rejected_frames += 1
        # Log the first few and then every 100th to avoid flooding.
        if self._rejected_frames <= 5 or self._rejected_frames % 100 == 0:
            self._log.warning("ignored joy frame (%s), total %d", reason, self._rejected_frames)

    async def _status_loop(self) -> None:
        while True:
            await asyncio.sleep(self._status_period)
            if not self._connections:
                continue
            try:
                status = dict(self._status_provider())
            except Exception as exc:  # noqa: BLE001
                self._log.warning("status provider failed: %s", exc)
                continue
            status["type"] = "status"
            status["clients"] = len(self._connections)
            for ws in list(self._connections):
                status["controller"] = ws is self._active
                await self._send_json(ws, status, timeout=self._status_period)
