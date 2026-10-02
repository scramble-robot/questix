"""Integration tests for JoyWebSocketServer against the installed websockets library.

These run on both the legacy (10.x) and asyncio (13+) ``websockets`` APIs.
"""

import asyncio
import json
import threading
import time
import urllib.error
import urllib.request

import pytest
import websockets

from web_joy_driver.joy_frame import FrameError
from web_joy_driver.ws_server import (
    CLOSE_AUTH_FAILED,
    CLOSE_REPLACED,
    JoyWebSocketServer,
    device_label,
)

INDEX = b"<html><body>hello joy</body></html>"
IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"


class _Sink:
    def __init__(self):
        self.frames = []
        self.releases = 0
        self.event = threading.Event()

    def on_frame(self, payload):
        if payload.get("bad"):
            raise FrameError("bad frame")
        self.frames.append(payload)
        self.event.set()

    def on_release(self):
        self.releases += 1

    def status(self):
        return {"hold": "active", "estop": False}


@pytest.fixture
def server():
    sink = _Sink()
    srv = JoyWebSocketServer(
        host="127.0.0.1", port=0, index_html=INDEX, on_frame=sink.on_frame,
        on_release=sink.on_release, status_provider=sink.status, token="secret",
        ping_interval_sec=0.2, ping_timeout_sec=0.5, status_period_sec=0.01,
        close_timeout_sec=0.3, welcome_info={"robot": {"name": "questix-test"},
                                             "lab_bridge_port": 8897},
    )
    srv.start()
    try:
        yield srv, sink
    finally:
        srv.stop()


def _http_get(port, path):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=3) as resp:
            return resp.status, resp.headers.get("Content-Type", ""), resp.read()
    except urllib.error.HTTPError as err:
        return err.code, err.headers.get("Content-Type", ""), err.read()


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _url(srv, query="token=secret"):
    return f"ws://127.0.0.1:{srv.bound_port}/ws?{query}"


def _connect(url, **kwargs):
    """Open a client with a User-Agent on either websockets API."""
    user_agent = kwargs.pop("user_agent", None)
    if user_agent:
        # websockets.connect is the new asyncio client from 14 on, the legacy one before.
        new_client = int(websockets.__version__.split(".")[0]) >= 14
        key = "additional_headers" if new_client else "extra_headers"
        kwargs[key] = {"User-Agent": user_agent}
    return websockets.connect(url, **kwargs)


def _close_code(exc):
    return getattr(getattr(exc, "rcvd", None), "code", None) or getattr(exc, "code", None)


async def _recv_type(ws, kind, timeout=2.0, where=None):
    """Return the next text message of ``kind`` (optionally matching ``where``)."""
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            pytest.fail(f"no {kind!r} message")
        msg = await asyncio.wait_for(ws.recv(), remaining)
        if isinstance(msg, bytes):
            continue
        data = json.loads(msg)
        if data.get("type") == kind and (where is None or where(data)):
            return data


async def _wait(cond, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        await asyncio.sleep(0.01)
    return cond()


def _joy(*axes):
    return json.dumps({"type": "joy", "axes": list(axes), "buttons": []})


def test_device_label():
    assert device_label(IPHONE) == "iPhone"
    assert device_label("Mozilla/5.0 (Linux; Android 14; Pixel 8)") == "Android"
    assert device_label(MAC) == "Mac"
    assert device_label(MAC, touch=True) == "iPad"  # iPadOS Safari reports a Mac
    assert device_label("Mozilla/5.0 (Windows NT 10.0; Win64; x64)") == "Windows"
    assert device_label("") == "ブラウザ"


def test_http_serves_index_and_404(server):
    srv, _ = server
    status, ctype, body = _http_get(srv.bound_port, "/")
    assert status == 200 and ctype.startswith("text/html") and body == INDEX
    status, _, _ = _http_get(srv.bound_port, "/index.html")
    assert status == 200
    status, _, _ = _http_get(srv.bound_port, "/nope")
    assert status == 404
    status, _, _ = _http_get(srv.bound_port, "/ws")
    assert status == 426


@pytest.mark.parametrize("query", ["token=wrong", "", "cid=abc"])
def test_ws_bad_token_is_closed_with_4401(server, query):
    """The page must be able to tell an auth error (4401) from a lost connection (1006)."""
    srv, sink = server

    async def go():
        async with websockets.connect(_url(srv, query)) as ws:
            with pytest.raises(websockets.exceptions.ConnectionClosed) as info:
                await asyncio.wait_for(ws.recv(), 2.0)
            assert _close_code(info.value) == CLOSE_AUTH_FAILED

    _run(go())
    assert sink.releases == 0 and sink.frames == []


def test_ws_frames_reach_callback_and_release_on_close(server):
    srv, sink = server

    async def go():
        async with _connect(_url(srv), user_agent=IPHONE) as ws:
            welcome = json.loads(await ws.recv())
            assert welcome["type"] == "welcome" and welcome["controller"] is True
            assert welcome["robot"] == {"name": "questix-test"}
            assert welcome["lab_bridge_port"] == 8897
            assert welcome["you"]["label"] == "iPhone"
            assert welcome["you"]["address"] == "127.0.0.1"
            assert welcome["owner"]["id"] == welcome["you"]["id"]
            await ws.send(json.dumps({"type": "joy", "axes": [1.0], "buttons": [0, 1]}))
            await ws.send("not json")
            await ws.send(json.dumps({"type": "joy", "bad": True}))
            msg = await _recv_type(ws, "status")
            assert msg["controller"] is True and msg["estop"] is False
            assert msg["owner"]["label"] == "iPhone" and msg["clients"] == 1

    _run(go())
    assert sink.event.wait(2.0)
    assert sink.frames == [{"type": "joy", "axes": [1.0], "buttons": [0, 1]}]
    releases = sink.releases
    for _ in range(50):
        if sink.releases > releases or sink.releases >= 2:
            break
        threading.Event().wait(0.05)
    assert sink.releases >= 2  # neutral when the role was taken and again on disconnect


def test_second_device_is_refused_not_a_takeover(server):
    """One operator at a time: a later device only views, its frames never reach the robot."""
    srv, sink = server

    async def go():
        first = await _connect(_url(srv, "token=secret&cid=first"), user_agent=IPHONE)
        me = json.loads(await first.recv())["you"]
        second = await _connect(_url(srv, "token=secret&cid=second"), user_agent=MAC)
        welcome = json.loads(await second.recv())
        assert welcome["controller"] is False
        assert welcome["owner"]["id"] == me["id"] and welcome["owner"]["label"] == "iPhone"
        msg = await _recv_type(second, "status")
        assert msg["controller"] is False and msg["owner"]["id"] == me["id"]
        assert msg["clients"] == 2
        await second.send(_joy(0.9))
        # Claiming while someone operates is refused and names the operator.
        await second.send(json.dumps({"type": "claim"}))
        refused = await _recv_type(second, "refused")
        assert refused["reason"] == "busy" and refused["owner"]["id"] == me["id"]
        await first.send(_joy(0.25))
        assert await _wait(lambda: sink.frames and sink.frames[-1]["axes"] == [0.25])
        # The first page keeps operating: it was not closed or told it lost control.
        msg = await _recv_type(first, "status")
        assert msg["controller"] is True
        await second.close()
        await first.close()

    _run(go())
    assert all(frame["axes"] != [0.9] for frame in sink.frames)


def test_stop_from_a_viewer_is_honoured(server):
    """Anyone may stop: neutral at once, and the operator must let go before driving again."""
    srv, sink = server

    async def go():
        op = await _connect(_url(srv, "token=secret&cid=op"))
        await op.recv()
        viewer = await _connect(_url(srv, "token=secret&cid=viewer"))
        viewer_me = json.loads(await viewer.recv())["you"]
        await op.send(_joy(1.0))
        assert await _wait(lambda: sink.frames and sink.frames[-1]["axes"] == [1.0])
        before = sink.releases
        await viewer.send(json.dumps({"type": "stop"}))
        stopped = await _recv_type(op, "stopped")
        assert stopped["by"]["id"] == viewer_me["id"] and stopped["by_operator"] is False
        assert await _wait(lambda: sink.releases > before)
        # Frames still in flight from the operator's held stick are ignored ...
        count = len(sink.frames)
        await op.send(_joy(1.0))
        await op.send(_joy(0.5))
        status = await _recv_type(op, "status", where=lambda m: m["stopped"])
        assert status["controller"] is True
        await asyncio.sleep(0.1)
        assert len(sink.frames) == count
        # ... until the page lets go of everything; then it drives again.
        await op.send(_joy(0.0))
        await op.send(_joy(0.3))
        assert await _wait(lambda: sink.frames[-1]["axes"] == [0.3])
        await viewer.close()
        await op.close()

    _run(go())


def test_release_request_and_handover(server):
    srv, sink = server

    async def go():
        op = await _connect(_url(srv, "token=secret&cid=op"))
        await op.recv()
        viewer = await _connect(_url(srv, "token=secret&cid=viewer"), user_agent=IPHONE)
        viewer_me = json.loads(await viewer.recv())["you"]
        # The viewer asks; the operator is told who.
        await viewer.send(json.dumps({"type": "request"}))
        request = await _recv_type(op, "handover_request")
        assert request["from"]["id"] == viewer_me["id"] and request["from"]["label"] == "iPhone"
        sent = await _recv_type(viewer, "request_sent")
        assert "repeat" not in sent
        await viewer.send(json.dumps({"type": "request"}))
        assert (await _recv_type(viewer, "request_sent"))["repeat"] is True  # rate limited
        # 譲る: the operator releases to the asking viewer.
        await op.send(json.dumps({"type": "release", "to": viewer_me["id"]}))
        await _recv_type(viewer, "status", where=lambda m: m["controller"])
        await viewer.send(_joy(0.7))
        assert await _wait(lambda: sink.frames and sink.frames[-1]["axes"] == [0.7])
        await op.send(_joy(0.1))  # the former operator is a viewer now
        # 操作をやめる without a target frees the role; anyone may claim it.
        await viewer.send(json.dumps({"type": "release"}))
        await _recv_type(op, "status", where=lambda m: m["owner"] is None)
        await op.send(json.dumps({"type": "claim"}))
        await _recv_type(op, "status", where=lambda m: m["controller"])
        await viewer.close()
        await op.close()

    _run(go())
    assert all(frame["axes"] != [0.1] for frame in sink.frames)


def test_operator_disconnect_frees_the_role_and_claim0_only_views(server):
    srv, sink = server

    async def go():
        op = await _connect(_url(srv, "token=secret&cid=op"))
        await op.recv()
        viewer = await _connect(_url(srv, "token=secret&cid=viewer"))
        await viewer.recv()
        await op.close()
        status = await _recv_type(viewer, "status", where=lambda m: m["owner"] is None)
        assert status["controller"] is False  # nobody is promoted automatically
        # claim=0 (a page that let go before a reconnect) stays a viewer even when free.
        late = await _connect(_url(srv, "token=secret&cid=late&claim=0"))
        assert json.loads(await late.recv())["controller"] is False
        await viewer.send(json.dumps({"type": "claim"}))
        await _recv_type(viewer, "status", where=lambda m: m["controller"])
        await late.close()
        await viewer.close()

    _run(go())


def test_same_page_reconnect_replaces_its_stale_connection_fast(server):
    """A Wi-Fi drop: the same page (cid) comes back before its old socket timed out."""
    srv, sink = server

    async def go():
        stuck = await websockets.connect(_url(srv, "token=secret&cid=phone"), max_queue=2)
        assert json.loads(await stuck.recv())["controller"] is True
        # Never read again: status pushes every 10 ms fill its queue and apply back pressure.
        await asyncio.sleep(1.0)
        t0 = time.monotonic()
        again = await websockets.connect(_url(srv, "token=secret&cid=phone"))
        assert json.loads(await again.recv())["controller"] is True
        await again.send(_joy(0.25))
        assert await _wait(lambda: sink.frames and sink.frames[-1]["axes"] == [0.25])
        elapsed = time.monotonic() - t0
        assert elapsed < 2.0, f"reconnect took {elapsed:.2f}s"
        # Another page with a different cid is still refused.
        other = await websockets.connect(_url(srv, "token=secret&cid=other"))
        assert json.loads(await other.recv())["controller"] is False
        await other.close()
        await again.close()
        code = None
        try:
            while True:
                await asyncio.wait_for(stuck.recv(), 3.0)
        except websockets.exceptions.ConnectionClosed as exc:
            code = _close_code(exc)
        except Exception:  # noqa: BLE001 - timed out: closed without a readable code
            pass
        # Retired (4000) or dropped by the keepalive (1011) because it never read.
        assert code in (CLOSE_REPLACED, 1011, 1006, None)

    _run(go())


JPEG_HEAD = b"\xff\xd8\xff\xe0"


def test_camera_frames_are_relayed_as_binary_and_only_the_latest_survives(server):
    """Camera images reach every client as binary frames; a burst collapses to the newest."""
    srv, _ = server

    async def go():
        async with websockets.connect(_url(srv)) as ws:
            assert json.loads(await ws.recv())["type"] == "welcome"
            srv.push_camera_frame(JPEG_HEAD + b"first")
            received = []
            for _ in range(100):
                msg = await asyncio.wait_for(ws.recv(), 2.0)
                if isinstance(msg, bytes):
                    received.append(msg)
                    break
            assert received == [JPEG_HEAD + b"first"]
            # 50 frames within a few ms: throttled to camera_max_fps (default 15),
            # so far fewer messages arrive and the last one is the newest frame.
            for i in range(50):
                srv.push_camera_frame(JPEG_HEAD + b"burst%02d" % i)
            deadline = time.monotonic() + 3.0
            burst = []
            while time.monotonic() < deadline:
                msg = await asyncio.wait_for(ws.recv(), 2.0)
                if isinstance(msg, bytes):
                    burst.append(msg)
                    if msg == JPEG_HEAD + b"burst49":
                        break
            assert burst[-1] == JPEG_HEAD + b"burst49"
            assert len(burst) < 50
            # Text traffic keeps flowing alongside the images.
            msg = json.loads(await asyncio.wait_for(ws.recv(), 2.0))
            assert msg["type"] == "status"

    _run(go())
    assert srv.camera_stats["sent"] >= 2
    assert srv.camera_stats["dropped"] > 0
