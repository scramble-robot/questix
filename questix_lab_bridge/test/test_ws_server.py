import asyncio
import json
import threading

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


def test_client_ids_messages_and_disconnect_reach_the_callbacks():
    received = []
    left = []
    instance = LabWebSocketServer(
        '127.0.0.1', 0, json.dumps({'type': 'hello'}),
        greeting=lambda client: [json.dumps({'type': 'session', 'id': client})],
        on_message=lambda client, text: received.append((client, text)),
        on_disconnect=left.append)
    instance.start()

    async def scenario():
        url = 'ws://127.0.0.1:%d' % instance.port
        async with websockets.connect(url) as first, websockets.connect(url) as second:
            await first.recv()
            first_id = json.loads(await first.recv())['id']
            await second.recv()
            second_id = json.loads(await second.recv())['id']
            assert first_id != second_id
            await _wait_for_clients(instance, 2)
            await first.send('{"type":"stop"}')
            await first.send(b'binary frames are not handed on')
            # A reply meant for one page reaches only that page.
            instance.publish_to(second_id, 'drive_state', 'only-second')
            assert await asyncio.wait_for(second.recv(), 2) == 'only-second'
            for _ in range(100):
                if received:
                    break
                await asyncio.sleep(0.01)
            assert received == [(first_id, '{"type":"stop"}')]
        for _ in range(100):
            if len(left) == 2:
                break
            await asyncio.sleep(0.01)
        assert sorted(left) == sorted([first_id, second_id])
    try:
        asyncio.run(scenario())
    finally:
        instance.stop()


def test_state_endpoint_reports_the_bridge_and_counts_clients():
    threads = []

    def provider(clients, max_clients):
        threads.append(threading.current_thread().name)
        return {'read_only': False, 'clients': clients, 'max_clients': max_clients,
                'drive_state': {'blockers': [{'code': 'emergency_stop', 'nodes': None}]}}
    instance = LabWebSocketServer('127.0.0.1', 0, '{"type":"hello"}', max_clients=5,
                                  state_provider=provider)
    instance.start()
    try:
        status, content_type, body = _http_get(instance.port, '/api/state')
        assert (status, content_type) == (200, 'application/json')
        assert json.loads(body) == {
            'read_only': False, 'clients': 0, 'max_clients': 5,
            'drive_state': {'blockers': [{'code': 'emergency_stop', 'nodes': None}]}}

        async def scenario():
            async with websockets.connect('ws://127.0.0.1:%d' % instance.port) as client:
                assert json.loads(await client.recv()) == {'type': 'hello'}
                await _wait_for_clients(instance, 1)
                reply = await asyncio.get_running_loop().run_in_executor(
                    None, _http_get, instance.port, '/api/state?t=1')
                return json.loads(reply[2])
        assert asyncio.run(scenario())['clients'] == 1
        # Built on the server thread; the node takes its own lock inside the provider.
        assert threads and set(threads) == {'lab_bridge_ws'}
    finally:
        instance.stop()


def test_state_endpoint_without_a_provider_or_with_a_failing_one(server):
    status, content_type, body = _http_get(server.port, '/api/state')
    assert status == 200 and json.loads(body) == {'clients': 0, 'max_clients': 1}

    def explode(clients, max_clients):
        raise RuntimeError('boom')
    instance = LabWebSocketServer('127.0.0.1', 0, '{}', state_provider=explode)
    instance.start()
    try:
        status, content_type, body = _http_get(instance.port, '/api/state')
        assert status == 500 and 'boom' in json.loads(body)['error']
        # Everything else keeps working.
        assert _http_get(instance.port, '/')[0] == 404
    finally:
        instance.stop()


def test_a_failing_callback_keeps_the_connection():
    def explode(client, text):
        raise RuntimeError('boom')
    instance = LabWebSocketServer('127.0.0.1', 0, '{}', on_message=explode)
    instance.start()

    async def scenario():
        async with websockets.connect('ws://127.0.0.1:%d' % instance.port) as client:
            await client.recv()
            await _wait_for_clients(instance, 1)
            await client.send('{"type":"stop"}')
            instance.publish('status', 'still-here')
            assert await asyncio.wait_for(client.recv(), 2) == 'still-here'
    try:
        asyncio.run(scenario())
    finally:
        instance.stop()


def _records_server(tmp_path, **options):
    from questix_lab_bridge.records import RecordStore
    from questix_lab_bridge.records_api import RecordsApi
    store = RecordStore(tmp_path / 'records', 64 * 1024 * 1024, 0,
                        disk_free=lambda path: 1 << 40)
    store.prepare()
    api = RecordsApi(store, str(tmp_path / 'bags'), None, rosbags_available=False)
    received = []
    instance = LabWebSocketServer('127.0.0.1', 0, '{"type":"hello"}', records=api,
                                  on_message=lambda client, text: received.append(text),
                                  **options)
    instance.start()
    return instance, store, received


def _recording_frame(messages_count):
    drive = [{'type': 'drive', 'stamp': i * 0.05, 'v': 0.2, 'w': 0.0, 'left': {'rpm': 38}}
             for i in range(messages_count)]
    return json.dumps({'type': 'record_save', 'recording': {
        'format': 'questix-lab-recording', 'version': 1, 'source': 'live', 'name': 'run',
        'recordedAt': '2026-09-25T01:51:02.000Z',
        'config': {'wheel_radius': 0.1, 'wheel_separation': 0.5},
        'topics': {}, 'streams': {'drive': drive}, 'group': '3班'}})


def test_record_save_is_answered_to_the_sender_only(tmp_path):
    instance, store, received = _records_server(tmp_path)

    async def scenario():
        url = 'ws://127.0.0.1:%d' % instance.port
        async with websockets.connect(url) as saver, websockets.connect(url) as other:
            await saver.recv()
            await other.recv()
            await _wait_for_clients(instance, 2)
            big = _recording_frame(20000)  # about 1.5 MB, far above the old 1 kB frame limit
            assert len(big) > 1_000_000
            await saver.send(big)
            await saver.send(_recording_frame(1))  # a small one goes the same way
            await saver.send('{"type":"record_save","recording":{"format":"x"}}')
            await saver.send('{"type":"stop"}')  # other frames still reach the node
            replies = [json.loads(await asyncio.wait_for(saver.recv(), 10)) for _ in range(3)]
            assert [reply['type'] for reply in replies] == [
                'record_saved', 'record_saved', 'record_error']
            assert replies[0]['id'] != replies[1]['id']
            assert 'questix-lab-recording' in replies[2]['message']
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(other.recv(), 0.3)
            return replies
    try:
        replies = asyncio.run(scenario())
        assert received == ['{"type":"stop"}']
        status, content_type, body = _http_get(instance.port, '/api/records')
        assert status == 200 and content_type.startswith('application/json')
        listing = json.loads(body)
        assert {entry['id'] for entry in listing['records']} == {
            replies[0]['id'], replies[1]['id']}
        assert all(entry['group'] == '3班' for entry in listing['records'])
        status, _, body = _http_get(instance.port, '/api/records/' + replies[0]['id'])
        assert status == 200 and len(json.loads(body)['streams']['drive']) == 20000
    finally:
        instance.stop()


def test_record_endpoints_allow_other_origins(tmp_path):
    import urllib.error
    import urllib.request
    instance, _, _ = _records_server(tmp_path)
    try:
        for path in ('/api/records', '/api/rosbags', '/api/records/missing'):
            request = urllib.request.Request('http://127.0.0.1:%d%s' % (instance.port, path))
            try:
                reply = urllib.request.urlopen(request, timeout=5)
            except urllib.error.HTTPError as error:
                reply = error
            assert reply.headers['Access-Control-Allow-Origin'] == '*'
            assert reply.headers['Cache-Control'] == 'no-store'
        assert json.loads(_http_get(instance.port, '/api/rosbags')[2]) == {
            'bags': [], 'dir': str(tmp_path / 'bags')}
    finally:
        instance.stop()
