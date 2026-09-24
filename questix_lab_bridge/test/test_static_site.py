import gzip

from questix_lab_bridge.static_site import static_response


def site(tmp_path):
    (tmp_path / 'index.html').write_text('<!doctype html><title>lab</title>' + 'x' * 2000)
    (tmp_path / 'js').mkdir()
    (tmp_path / 'js' / 'main.js').write_text('export const answer = 42;\n' * 200)
    (tmp_path / 'logo.png').write_bytes(b'\x89PNG\r\n\x1a\n' + b'\0' * 100)
    return tmp_path


def header(headers, name):
    return next((value for key, value in headers if key == name), None)


def test_every_file_has_an_etag_and_a_repeat_request_gets_304(tmp_path):
    root = site(tmp_path)
    status, headers, body = static_response(root, '/js/main.js')
    assert status == 200 and body.startswith(b'export')
    etag = header(headers, 'ETag')
    assert etag and header(headers, 'Cache-Control') == 'no-cache'
    status, headers, body = static_response(root, '/js/main.js', {'If-None-Match': etag})
    assert status == 304 and body == b'' and header(headers, 'ETag') == etag


def test_a_changed_file_gets_a_new_etag(tmp_path):
    root = site(tmp_path)
    etag = header(static_response(root, '/js/main.js')[1], 'ETag')
    (root / 'js' / 'main.js').write_text('export const answer = 43;\n')
    status, headers, _ = static_response(root, '/js/main.js', {'If-None-Match': etag})
    assert status == 200 and header(headers, 'ETag') != etag


def test_text_is_gzipped_for_browsers_that_accept_it(tmp_path):
    root = site(tmp_path)
    plain = static_response(root, '/js/main.js')[2]
    status, headers, body = static_response(
        root, '/js/main.js', {'Accept-Encoding': 'gzip, deflate, br'})
    assert status == 200
    assert header(headers, 'Content-Encoding') == 'gzip'
    assert header(headers, 'Vary') == 'Accept-Encoding'
    assert gzip.decompress(body) == plain and len(body) < len(plain) / 4


def test_images_and_old_browsers_get_the_file_as_it_is(tmp_path):
    root = site(tmp_path)
    _, headers, body = static_response(root, '/logo.png', {'Accept-Encoding': 'gzip'})
    assert header(headers, 'Content-Encoding') is None and body.startswith(b'\x89PNG')
    _, headers, _ = static_response(root, '/index.html', {})
    assert header(headers, 'Content-Encoding') is None


def test_paths_outside_the_site_are_not_served(tmp_path):
    root = site(tmp_path / 'lab') if (tmp_path / 'lab').mkdir() is None else None
    (tmp_path / 'secret.txt').write_text('no')
    assert static_response(root, '/../secret.txt')[0] == 404
    assert static_response(root, '/%2e%2e/secret.txt')[0] == 404
    assert static_response(None, '/index.html')[0] == 404
