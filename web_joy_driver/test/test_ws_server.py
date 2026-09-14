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
from web_joy_driver.ws_server import CLOSE_TAKEN_OVER, JoyWebSocketServer

INDEX = b"<html><body>hello joy</body></html>"


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
        close_timeout_sec=0.3,
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


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_ws_rejects_bad_token(server):
    srv, _ = server

    async def go():
        with pytest.raises(Exception):  # InvalidStatus / InvalidStatusCode depending on version
            async with websockets.connect(f"ws://127.0.0.1:{srv.bound_port}/ws?token=wrong"):
                pass

    _run(go())


def test_ws_frames_reach_callback_and_release_on_close(server):
    srv, sink = server

    async def go():
        async with websockets.connect(f"ws://127.0.0.1:{srv.bound_port}/ws?token=secret") as ws:
            welcome = json.loads(await ws.recv())
            assert welcome["type"] == "welcome" and welcome["controller"] is True
            await ws.send(json.dumps({"type": "joy", "axes": [1.0], "buttons": [0, 1]}))
            await ws.send("not json")
            await ws.send(json.dumps({"type": "joy", "bad": True}))
            # Wait for a status push that proves the server loop is alive.
            for _ in range(50):
                msg = json.loads(await ws.recv())
                if msg["type"] == "status":
                    assert msg["controller"] is True and msg["estop"] is False
                    break
            else:
                pytest.fail("no status message")

    _run(go())
    assert sink.event.wait(2.0)
    assert sink.frames == [{"type": "joy", "axes": [1.0], "buttons": [0, 1]}]
    for _ in range(50):
        if sink.releases:
            break
        threading.Event().wait(0.05)
    assert sink.releases == 1


def test_ws_latest_client_takes_over(server):
    srv, sink = server
    url = f"ws://127.0.0.1:{srv.bound_port}/ws?token=secret"

    async def go():
        first = await websockets.connect(url)
        assert json.loads(await first.recv())["type"] == "welcome"
        second = await websockets.connect(url)
        assert json.loads(await second.recv())["type"] == "welcome"
        # The first client is told it lost control and then gets closed.
        code = None
        for _ in range(50):
            try:
                msg = json.loads(await asyncio.wait_for(first.recv(), 1.0))
            except websockets.exceptions.ConnectionClosed as exc:
                code = getattr(exc, "code", None) or getattr(getattr(exc, "rcvd", None), "code", None)
                break
            if msg["type"] == "released":
                assert msg["reason"] == "taken_over"
        else:
            pytest.fail("first client was not released")
        assert code == CLOSE_TAKEN_OVER
        # Frames from the second client are accepted.
        await second.send(json.dumps({"type": "joy", "axes": [0.5]}))
        await second.close()

    _run(go())
    assert sink.event.wait(2.0)
    assert sink.frames[-1]["axes"] == [0.5]


def test_takeover_is_not_stalled_by_a_client_that_stopped_reading(server):
    """A backgrounded browser stops reading; the next controller must still get through fast."""
    srv, sink = server
    url = f"ws://127.0.0.1:{srv.bound_port}/ws?token=secret"

    async def go():
        stuck = await websockets.connect(url, max_queue=2)
        assert json.loads(await stuck.recv())["type"] == "welcome"
        # Never read again: status pushes every 10 ms fill its queue and apply back pressure.
        await asyncio.sleep(1.0)
        t0 = time.monotonic()
        second = await websockets.connect(url)
        assert json.loads(await second.recv())["type"] == "welcome"
        await second.send(json.dumps({"type": "joy", "axes": [0.25]}))
        for _ in range(200):
            if sink.frames and sink.frames[-1]["axes"] == [0.25]:
                break
            await asyncio.sleep(0.01)
        elapsed = time.monotonic() - t0
        assert sink.frames[-1]["axes"] == [0.25]
        assert elapsed < 2.0, f"takeover took {elapsed:.2f}s"
        await second.close()
        try:
            await asyncio.wait_for(stuck.close(), 3.0)
        except Exception:  # noqa: BLE001
            pass

    _run(go())
