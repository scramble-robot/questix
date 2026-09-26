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

Control policy (the same as QUESTiX LAB's driving experiments): **one operator
at a time, the others are refused, anyone can stop.**

* A page connecting with ``claim=1`` (the default) becomes the operator only
  while nobody else is; otherwise it stays a *viewer*: it sees the status,
  the camera and who operates, but its joy frames are ignored. It may ask the
  operator to hand over (``request``) or claim once the operator lets go.
* The operator lets go with ``release`` (optionally handing over ``to`` a
  viewer that asked), by closing the page, or by losing the connection: the
  WebSocket keepalive (``ping_interval_sec`` + ``ping_timeout_sec``) closes a
  silent connection, and the role is free from then on. The robot itself is
  neutral much sooner (``on_release`` at once on close, and the node's
  ``message_timeout_sec`` watchdog while frames are missing).
* The same page (``cid``, kept per browser tab) reconnecting after a Wi-Fi drop
  replaces its own stale connection instead of being refused by it.
* Any connected page may send ``stop``: the held command drops to neutral and
  the operator's frames are ignored until its page sends an all-zero frame
  (it lets go of everything), so a stop from a viewer is not undone by frames
  already in flight.
* A wrong or missing ``token`` is accepted at the HTTP level and then closed
  with code 4401, so the page can tell an authentication error from a lost
  connection (a refused handshake only shows up as 1006 in a browser).
"""

import asyncio
import json
import logging
import re
import threading
import time
from http import HTTPStatus
from typing import Any, Callable, Dict, Optional, Set
from urllib.parse import parse_qs, urlsplit

from .joy_frame import FrameError, is_neutral_frame

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
CLOSE_REPLACED = 4000  # the same page reconnected; its stale connection is retired
CLOSE_AUTH_FAILED = 4401  # wrong or missing token (the page shows its auth screen)
MAX_FRAME_BYTES = 4096  # client -> server only; camera frames go the other way
REQUEST_INTERVAL_SEC = 5.0  # a viewer may ask the operator to hand over this often
REQUEST_VALID_SEC = 60.0  # a hand-over to a viewer is honoured this long after it asked
_CID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

FrameCallback = Callable[[Dict[str, Any]], None]
ReleaseCallback = Callable[[], None]
StatusProvider = Callable[[], Dict[str, Any]]


def device_label(user_agent: str, touch: bool = False) -> str:
    """Return a short device name ("iPhone", "Android", ...) for ``user_agent``.

    iPadOS Safari reports itself as a Mac; ``touch`` (the page saw a touch
    screen) turns such a "Mac" into "iPad".
    """
    ua = user_agent or ""
    if "iPhone" in ua or "iPod" in ua:
        return "iPhone"
    if "iPad" in ua:
        return "iPad"
    if "Android" in ua:
        return "Android"
    if "CrOS" in ua:
        return "Chromebook"
    if "Macintosh" in ua or "Mac OS X" in ua:
        return "iPad" if touch else "Mac"
    if "Windows" in ua:
        return "Windows"
    if "Linux" in ua:
        return "Linux"
    return "ブラウザ"


class _Client:
    """Book-keeping for one accepted WebSocket connection."""

    def __init__(self, cid: int, page_id: Optional[str], label: str, address: str) -> None:
        self.id = cid
        self.page_id = page_id
        self.label = label
        self.address = address
        self.requested_at: Optional[float] = None  # last hand-over request (monotonic)

    def public(self) -> Dict[str, Any]:
        return {"id": self.id, "label": self.label, "address": self.address}


class JoyWebSocketServer:
    """Serve the controller page and relay the operator's joy frames to ``on_frame``."""

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
        welcome_info: Optional[Dict[str, Any]] = None,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        """Configure the server; call ``start`` to run it on a thread.

        ``camera_max_fps`` caps how often ``push_camera_frame`` data is
        forwarded to browsers (``<= 0`` forwards every frame).
        ``welcome_info`` is merged into the ``welcome`` message (robot name,
        lab bridge port, ...).
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
        self._welcome_info = dict(welcome_info or {})
        self._log = logger or logging.getLogger(__name__)

        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._stop_event: Optional[asyncio.Event] = None
        self._thread: Optional[threading.Thread] = None
        self._started = threading.Event()
        self._start_error: Optional[BaseException] = None
        self._bound_port: Optional[int] = None
        # Accepted (authenticated) connections. Only touched on the loop thread.
        self._clients: Dict[Any, _Client] = {}
        self._next_id = 1
        self._owner: Optional[Any] = None
        self._owner_since = 0.0
        # Set by a stop: the operator's frames are ignored until an all-zero frame.
        self._stop_latched = False
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
            for ws in list(self._clients):
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
            # stall a hand-over or shutdown for the library default of 10 s.
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
                for ws in list(self._clients):
                    try:
                        await ws.close()
                    except Exception:  # noqa: BLE001
                        pass

    # ------------------------------------------------------------------
    # HTTP handling (both websockets APIs)
    # ------------------------------------------------------------------
    @staticmethod
    def _route(path: str, upgrade_header: str):
        """Return ``None`` to accept a WebSocket upgrade or ``(status, ctype, body)``.

        The token is checked after the upgrade (see ``_handler``) so a browser
        sees close code 4401 instead of an opaque failed handshake.
        """
        parts = urlsplit(path)
        is_upgrade = upgrade_header.lower() == "websocket"
        if parts.path == WS_PATH:
            if not is_upgrade:
                return HTTPStatus.UPGRADE_REQUIRED, "text/plain", b"websocket upgrade required\n"
            return None
        if parts.path in INDEX_PATHS:
            return HTTPStatus.OK, "text/html; charset=utf-8", None
        return HTTPStatus.NOT_FOUND, "text/plain", b"not found\n"

    async def _process_request(self, *args):
        if _LEGACY_API:
            path, headers = args
            routed = self._route(path, headers.get("Upgrade", ""))
            if routed is None:
                return None
            status, ctype, body = routed
            body = self._index_html if body is None else body
            return status, [("Content-Type", ctype), ("Cache-Control", "no-store")], body
        connection, request = args
        routed = self._route(request.path, request.headers.get("Upgrade", ""))
        if routed is None:
            return None
        status, ctype, body = routed
        body = self._index_html if body is None else body
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
    def _address(ws: Any) -> str:
        addr = getattr(ws, "remote_address", None)
        if isinstance(addr, tuple) and addr:
            return str(addr[0])
        return str(addr)

    @staticmethod
    def _request(ws: Any):
        """Return ``(path, headers)`` of the upgrade request on either API."""
        request = getattr(ws, "request", None)
        if request is not None and hasattr(request, "path"):
            return request.path, request.headers
        return getattr(ws, "path", ""), getattr(ws, "request_headers", {})

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

    def _send_soon(self, ws: Any, payload: Dict[str, Any]) -> None:
        """Send without waiting (never lets one slow peer stall the handler)."""
        asyncio.ensure_future(self._send_json(ws, payload, timeout=self._close_timeout))

    async def _close(self, ws: Any, code: int, reason: str) -> None:
        try:
            await asyncio.wait_for(ws.close(code, reason), self._close_timeout * 2)
        except Exception:  # noqa: BLE001
            pass

    async def _retire(self, ws: Any) -> None:
        """Close a page's stale connection after the same page reconnected."""
        await self._send_json(ws, {"type": "released", "reason": "replaced"},
                              timeout=self._close_timeout)
        await self._close(ws, CLOSE_REPLACED, "replaced by a newer connection of the same page")

    def _owner_info(self) -> Optional[Dict[str, Any]]:
        client = self._clients.get(self._owner) if self._owner is not None else None
        if client is None:
            return None
        info = client.public()
        info["since_sec"] = round(max(0.0, time.monotonic() - self._owner_since), 1)
        return info

    def _set_owner(self, ws: Optional[Any], why: str) -> None:
        """Hand the operator role to ``ws`` (``None`` frees it); the robot goes neutral."""
        previous = self._owner
        self._owner = ws
        self._owner_since = time.monotonic()
        self._stop_latched = False
        self._on_release()  # never carry one operator's command over to the next
        client = self._clients.get(ws) if ws is not None else None
        if client is not None:
            self._log.info("operator: %s %s (#%d) [%s]", client.label, client.address,
                           client.id, why)
        elif previous is not None:
            self._log.info("operator role is free [%s]", why)

    def _claim(self, ws: Any) -> bool:
        """Make ``ws`` the operator if the role is free (or held by its own stale connection)."""
        client = self._clients[ws]
        owner = self._owner
        if owner is ws:
            return True
        if owner is not None:
            holder = self._clients.get(owner)
            if holder is None or not (client.page_id and holder.page_id == client.page_id):
                return False
            # The same page reconnected (Wi-Fi drop) before its old socket timed out.
            self._set_owner(ws, "reconnected")
            asyncio.ensure_future(self._retire(owner))
            return True
        self._set_owner(ws, "claimed")
        return True

    async def _handler(self, ws: Any, *_ignored: Any) -> None:
        path, headers = self._request(ws)
        query = parse_qs(urlsplit(path or "").query)
        address = self._address(ws)
        if self._token and query.get("token", [""])[0] != self._token:
            self._log.warning("refused %s: wrong or missing token", address)
            await self._close(ws, CLOSE_AUTH_FAILED, "invalid token")
            return
        page_id = query.get("cid", [""])[0]
        touch = query.get("touch", ["0"])[0] == "1"
        try:
            user_agent = headers.get("User-Agent", "") or ""
        except Exception:  # noqa: BLE001 - unusual header container
            user_agent = ""
        client = _Client(self._next_id, page_id if _CID_RE.match(page_id) else None,
                         device_label(user_agent, touch), address)
        self._next_id += 1
        self._clients[ws] = client
        if query.get("claim", ["1"])[0] != "0":
            self._claim(ws)
        if self._owner is not ws:
            self._log.info("viewer connected: %s %s (#%d)", client.label, address, client.id)
        welcome = dict(self._welcome_info)
        welcome.update({"type": "welcome", "controller": self._owner is ws,
                        "you": client.public(), "owner": self._owner_info()})
        await self._send_json(ws, welcome)
        self._status_soon()
        try:
            async for message in ws:
                if isinstance(message, bytes):
                    self._reject_frame("binary frame")
                    continue
                try:
                    payload = json.loads(message)
                except ValueError:
                    self._reject_frame("invalid JSON")
                    continue
                if not isinstance(payload, dict):
                    self._reject_frame("frame is not an object")
                    continue
                await self._dispatch(ws, client, payload)
        except ConnectionClosed:
            pass
        finally:
            self._clients.pop(ws, None)
            self._camera_busy.discard(ws)
            if self._owner is ws:
                self._set_owner(None, "disconnected: %s %s" % (client.label, address))
                self._status_soon()
            else:
                self._log.info("client left: %s %s (#%d)", client.label, address, client.id)

    async def _dispatch(self, ws: Any, client: _Client, payload: Dict[str, Any]) -> None:
        kind = payload.get("type")
        if kind == "joy":
            if ws is not self._owner:
                return  # viewers' frames never reach the robot
            if self._stop_latched:
                if not is_neutral_frame(payload):
                    return  # stopped: wait until the page lets go of everything
                self._stop_latched = False
            try:
                self._on_frame(payload)
            except FrameError as exc:
                self._reject_frame(str(exc))
        elif kind == "stop":
            self._stop(ws, client)
            self._status_soon()
        elif kind == "claim":
            if not self._claim(ws):
                self._send_soon(ws, {"type": "refused", "reason": "busy",
                                     "owner": self._owner_info()})
            self._status_soon()
        elif kind == "release":
            if ws is self._owner:
                self._release(client, payload.get("to"))
                self._status_soon()
        elif kind == "request":
            self._request_handover(ws, client)
        else:
            self._reject_frame("unsupported frame type %r" % (kind,))

    def _stop(self, ws: Any, client: _Client) -> None:
        """Honour a stop from any page: neutral now, the operator must let go first."""
        self._on_release()
        by_operator = ws is self._owner
        if self._owner is not None:
            self._stop_latched = True
        self._log.warning("stop pressed on %s %s (#%d)%s", client.label, client.address,
                          client.id, "" if by_operator else " (not the operator)")
        notice = {"type": "stopped", "by": client.public(), "by_operator": by_operator}
        for other in list(self._clients):
            self._send_soon(other, notice)

    def _release(self, client: _Client, to: Any) -> None:
        target = None
        if isinstance(to, int) and not isinstance(to, bool):
            now = time.monotonic()
            for other, info in self._clients.items():
                if info.id == to and info.requested_at is not None \
                        and now - info.requested_at <= REQUEST_VALID_SEC:
                    target = other
                    info.requested_at = None
                    break
        if target is not None:
            self._set_owner(target, "handed over by %s %s" % (client.label, client.address))
        else:
            self._set_owner(None, "released by %s %s" % (client.label, client.address))

    def _request_handover(self, ws: Any, client: _Client) -> None:
        if self._owner is None:
            self._claim(ws)
            self._status_soon()
            return
        if ws is self._owner:
            return
        now = time.monotonic()
        if client.requested_at is not None and now - client.requested_at < REQUEST_INTERVAL_SEC:
            self._send_soon(ws, {"type": "request_sent", "owner": self._owner_info(),
                                 "repeat": True})
            return
        client.requested_at = now
        self._send_soon(self._owner, {"type": "handover_request", "from": client.public()})
        self._send_soon(ws, {"type": "request_sent", "owner": self._owner_info()})

    def _reject_frame(self, reason: str) -> None:
        self._rejected_frames += 1
        # Log the first few and then every 100th to avoid flooding.
        if self._rejected_frames <= 5 or self._rejected_frames % 100 == 0:
            self._log.warning("ignored frame (%s), total %d", reason, self._rejected_frames)

    def _status_soon(self) -> None:
        """Push a status to every page right after a change (without waiting for it)."""
        asyncio.ensure_future(self._push_status())

    async def _push_status(self) -> None:
        if not self._clients:
            return
        try:
            status = dict(self._status_provider())
        except Exception as exc:  # noqa: BLE001
            self._log.warning("status provider failed: %s", exc)
            return
        status["type"] = "status"
        status["clients"] = len(self._clients)
        status["owner"] = self._owner_info()
        status["stopped"] = self._stop_latched
        sends = []
        for ws in list(self._clients):
            payload = dict(status)
            payload["controller"] = ws is self._owner
            sends.append(self._send_json(ws, payload, timeout=self._status_period))
        await asyncio.gather(*sends)

    async def _status_loop(self) -> None:
        while True:
            await asyncio.sleep(self._status_period)
            await self._push_status()
