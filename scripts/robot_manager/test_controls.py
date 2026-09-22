"""Control profile API regression tests; no ROS, systemd or hardware calls."""

from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

import json
import socket
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import uvicorn
import pytest
import yaml

from robot_manager import app as backend, controls


class HttpClient:
    """Exercise real HTTP validation using only the manager's installed dependencies."""

    def __init__(self, base):
        """Keep the randomly allocated local server address."""
        self.base = base

    def get(self, path):
        """Issue a GET request."""
        return self.request('GET', path)

    def put(self, path, json):
        """Issue a JSON PUT request."""
        return self.request('PUT', path, json)

    def request(self, method, path, payload=None):
        """Capture both successful responses and HTTP validation errors."""
        request = Request(self.base + path, method=method,
                          data=None if payload is None else json.dumps(payload).encode(),
                          headers={'Content-Type': 'application/json'})
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            return HttpResponse(response.status, response.read().decode())


class HttpResponse:
    """Expose status and JSON for assertions."""

    def __init__(self, status, text):
        """Store the HTTP response."""
        self.status_code = status
        self.text = text

    def json(self):
        """Decode the JSON response."""
        return json.loads(self.text)


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Keep every configuration write inside the test directory."""
    monkeypatch.setattr(backend, 'CONFIG_DIR', tmp_path)
    monkeypatch.setattr(backend, '_read_env', lambda: {})
    monkeypatch.delenv('ROBOT_WS', raising=False)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        server = uvicorn.Server(uvicorn.Config(backend.app, log_level='error'))
        thread = threading.Thread(target=server.run, kwargs={'sockets': [sock]}, daemon=True)
        with patch('subprocess.run', side_effect=AssertionError('No external commands allowed')):
            thread.start()
            try:
                deadline = time.monotonic() + 5
                while not server.started:
                    assert thread.is_alive() and time.monotonic() < deadline
                    time.sleep(0.01)
                yield HttpClient(f'http://127.0.0.1:{sock.getsockname()[1]}')
            finally:
                server.should_exit = True
                thread.join(timeout=5)
                assert not thread.is_alive()


def profile(client, controller='uart'):
    """Read a profile and verify the API is available."""
    response = client.get(f'/api/control-config/{controller}')
    assert response.status_code == 200, response.text
    return response.json()


def test_save_reload_and_profile_isolation(client, tmp_path):
    """Persist keys and speed together without touching the other controller."""
    before = profile(client)
    values = deepcopy(before['values'])
    values['joy_controller']['angular_input_ratio'] = -3  # normalized to ROS double
    values['shot_component']['fire_button'] = 2
    values['drive_component']['max_motor_rpm'] = 120
    response = client.put('/api/control-config/uart', json={
        'revision': before['revision'], 'values': values})
    assert response.status_code == 200, response.text
    assert profile(client)['values'] == values
    assert profile(client)['revision'] != before['revision']
    assert profile(client, 'dualshock')['values'] == before['values']
    saved = yaml.safe_load((tmp_path / 'controls.uart.yaml').read_text())
    assert type(saved['joy_controller']['ros__parameters']['angular_input_ratio']) is float
    assert response.json()['apply_on_restart'] is True
    assert not (tmp_path / 'launch.env').exists()


@pytest.mark.parametrize('node,key,value', [
    ('joy_controller', 'linear_x_axis', -1),
    ('joy_controller', 'linear_x_axis', 1.5),
    ('joy_controller', 'linear_x_axis', True),
    ('joy_controller', 'angular_input_ratio', 'NaN'),
    ('drive_component', 'max_motor_rpm', 476),
    ('drive_component', 'max_motor_rpm', 5),  # deadband would swallow all motion
    ('joy_axis_drive', 'invert_left_axis', 1),
    ('shot_component', 'tilt_axis', -2),
    ('esc_motor_control', 'full_speed_value', 1.1),
    ('uart_joy_driver', 'deadzone', 1.0),
    ('shot_component', 'port', '/dev/other'),
])
def test_invalid_values_do_not_write(client, tmp_path, node, key, value):
    """Reject malformed or hardware-only values before creating a saved profile."""
    before = profile(client)
    before['values'][node][key] = value
    response = client.put('/api/control-config/uart', json={
        'revision': before['revision'], 'values': before['values']})
    assert response.status_code == 422
    assert not (tmp_path / 'controls.uart.yaml').exists()


@pytest.mark.parametrize('number', [float('nan'), float('inf'), -float('inf')])
def test_nonfinite_numbers(number):
    """Nonfinite values must never reach ROS even through non-JSON callers."""
    defaults = controls._decode((Path(__file__).resolve().parents[2]
                                / 'questix_control_config/config/controls.uart.yaml').read_bytes())
    defaults['joy_controller']['angular_input_ratio'] = number
    with pytest.raises(ValueError):
        controls.validate(defaults)


def test_conflict_preserves_first_writer(client):
    """Two open editors cannot silently overwrite each other's changes."""
    before = profile(client)
    payload = {'revision': before['revision'], 'values': before['values']}
    assert client.put('/api/control-config/uart', json=payload).status_code == 200
    payload['values']['shot_component']['fire_button'] = 1
    assert client.put('/api/control-config/uart', json=payload).status_code == 409
    assert profile(client)['values']['shot_component']['fire_button'] == 5


def test_failed_atomic_replace_preserves_existing_profile(client, tmp_path):
    """A write failure leaves the last good YAML intact and cleans the temporary file."""
    before = profile(client)
    payload = {'revision': before['revision'], 'values': before['values']}
    assert client.put('/api/control-config/uart', json=payload).status_code == 200
    original = (tmp_path / 'controls.uart.yaml').read_bytes()
    payload['revision'] = profile(client)['revision']
    with patch.object(controls.os, 'replace', side_effect=OSError('disk error')):
        assert client.put('/api/control-config/uart', json=payload).status_code == 500
    assert (tmp_path / 'controls.uart.yaml').read_bytes() == original
    assert not list(tmp_path.glob('.controls-*'))


def test_corrupt_saved_profile_is_reported(client, tmp_path):
    """Do not hide malformed operator settings by falling back to defaults."""
    (tmp_path / 'controls.uart.yaml').write_text('bad: [')
    assert client.get('/api/control-config/uart').status_code == 503


def test_explicit_missing_workspace_does_not_fall_back(client, monkeypatch):
    """The manager must not show a checkout's defaults for a different robot workspace."""
    monkeypatch.setattr(backend, '_read_env', lambda: {'ROBOT_WS': '/nonexistent/robot_ws'})
    assert client.get('/api/control-config/uart').status_code == 503


@pytest.mark.parametrize('merged', [False, True])
def test_installed_workspace_resolution(tmp_path, merged):
    """Support both colcon isolated and merged install layouts without sourcing ROS."""
    base = tmp_path / 'install'
    if not merged:
        base /= 'questix_control_config'
    target = base / 'share/questix_control_config/config/controls.uart.yaml'
    target.parent.mkdir(parents=True)
    target.write_text('placeholder')
    assert controls._default_file('uart', {'ROBOT_WS': str(tmp_path)}) == target


def test_unknown_controller_and_incomplete_request(client):
    """Limit profile paths and require a full validated revisioned update."""
    assert client.get('/api/control-config/unknown').status_code == 422
    assert client.put('/api/control-config/uart', json={'values': {}}).status_code == 422


def test_runtime_api_uses_launch_environment_without_configuration_writes(client, monkeypatch):
    """Expose the read-only snapshot without applying or saving settings."""
    expected = {'nodes': {}, 'domain_id': 42, 'captured_at': '2026-01-01T00:00:00+00:00'}
    calls = []

    def read_snapshot(config):
        calls.append(config)
        return expected

    monkeypatch.setattr(backend.control_runtime, 'read_snapshot', read_snapshot)
    response = client.get('/api/control-runtime')
    assert response.status_code == 200
    assert response.json() == expected
    assert calls == [{}]
