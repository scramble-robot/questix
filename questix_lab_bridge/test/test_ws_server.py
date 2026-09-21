import asyncio
import json

import pytest

websockets = pytest.importorskip('websockets')

from questix_lab_bridge.ws_server import LabWebSocketServer  # noqa: E402


@pytest.fixture
def server():
    instance = LabWebSocketServer('127.0.0.1', 0, json.dumps({'type': 'hello'}), max_clients=1)
    instance.start()
    yield instance
    instance.stop()


async def _wait_for_clients(server, count):
    for _ in range(100):
        if server.client_count == count:
            return
        await asyncio.sleep(0.01)
    raise AssertionError('client count never reached %d' % count)


def test_hello_then_latest_payload_per_stream(server):
    async def scenario():
        async with websockets.connect('ws://127.0.0.1:%d' % server.port) as client:
            assert json.loads(await client.recv()) == {'type': 'hello'}
            await _wait_for_clients(server, 1)
            # Browser input is ignored and must not break the stream.
            await client.send('{"type":"cmd_vel","linear":1}')
            server.publish('scan', 'old')
            server.publish('scan', 'new')
            server.publish('camera', b'\xff\xd8\xff')
            received = []
            while b'\xff\xd8\xff' not in received or 'new' not in received:
                received.append(await asyncio.wait_for(client.recv(), 2))
            # A stale payload may be dropped, but is never delivered after a newer one.
            assert 'old' not in received or received.index('old') < received.index('new')
            assert len(received) <= 3
    asyncio.run(scenario())


def test_rejects_clients_over_the_limit(server):
    async def scenario():
        async with websockets.connect('ws://127.0.0.1:%d' % server.port) as first:
            await first.recv()
            await _wait_for_clients(server, 1)
            async with websockets.connect('ws://127.0.0.1:%d' % server.port) as second:
                with pytest.raises(websockets.ConnectionClosed):
                    await asyncio.wait_for(second.recv(), 2)
    asyncio.run(scenario())


def test_bind_failure_is_reported(server):
    clash = LabWebSocketServer('127.0.0.1', server.port, '{}')
    with pytest.raises(OSError):
        clash.start()


def _http_get(port, path):
    import urllib.error
    import urllib.request
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d%s' % (port, path), timeout=5) as reply:
            return reply.status, reply.headers.get('Content-Type'), reply.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get('Content-Type'), error.read()


def test_plain_http_serves_the_site_and_websocket_still_works(tmp_path):
    (tmp_path / 'js').mkdir()
    (tmp_path / 'index.html').write_text('<!doctype html>lab')
    (tmp_path / 'js' / 'main.js').write_bytes(b'x' * 600000)
    (tmp_path.parent / 'secret.txt').write_text('no')
    instance = LabWebSocketServer('127.0.0.1', 0, '{"type":"hello"}', site_dir=tmp_path)
    instance.start()
    try:
        assert _http_get(instance.port, '/') == (200, 'text/html; charset=utf-8',
                                                 b'<!doctype html>lab')
        status, content_type, body = _http_get(instance.port, '/js/main.js?v=1')
        assert (status, content_type, len(body)) == (200, 'text/javascript; charset=utf-8',
                                                     600000)
        assert _http_get(instance.port, '/../secret.txt')[0] == 404
        assert _http_get(instance.port, '/%2e%2e/secret.txt')[0] == 404

        async def scenario():
            async with websockets.connect('ws://127.0.0.1:%d' % instance.port) as client:
                assert json.loads(await client.recv()) == {'type': 'hello'}
        asyncio.run(scenario())
    finally:
        instance.stop()


def test_plain_http_without_a_site_explains_itself(server):
    status, content_type, body = _http_get(server.port, '/')
    assert status == 404 and content_type.startswith('text/plain')
    assert b'lab_dir' in body
