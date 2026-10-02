"""Read-only runtime queries tested without ROS discovery or hardware access."""

import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
import pytest

from robot_manager import control_runtime, read_control_parameters


@pytest.fixture
def runtime(monkeypatch, tmp_path):
    """Resolve harmless fake paths while every subprocess call is replaced in tests."""
    monkeypatch.setattr(control_runtime, '_ros_paths', lambda config: (
        tmp_path / 'ros/setup.bash', tmp_path / 'workspace with spaces/install/setup.bash'))
    return {'ROS_DOMAIN_ID': '71'}


def result_for_request(kwargs):
    """Produce a mixed available/unavailable snapshot matching the fixed query list."""
    requested = json.loads(kwargs['input'])
    reports = {node: {'status': 'unavailable', 'values': {}} for node in requested}
    reports['joy_controller'] = {'status': 'ok', 'values': {'angular_input_ratio': -3.0}}
    return SimpleNamespace(returncode=0, stdout=json.dumps(reports))


def test_read_only_command_uses_fixed_fields_domain_and_quoted_paths(runtime):
    """Only the GetParameters worker may run; workspace paths are passed as arguments."""
    def run(command, **kwargs):
        assert command[:4] == ['/bin/bash', '--noprofile', '--norc', '-c']
        assert 'source "$1"' in command[4] and 'source "$2"' in command[4]
        assert command[-1] == '71'
        assert Path(command[-2]).name == 'read_control_parameters.py'
        assert kwargs['timeout'] == 8
        assert kwargs['env']['ROS_DOMAIN_ID'] == '71'
        assert 'serial_port' not in kwargs['input']
        assert 'full_speed_button' in kwargs['input']
        return result_for_request(kwargs)

    with patch.object(control_runtime.subprocess, 'run', side_effect=run):
        snapshot = control_runtime.read_snapshot(runtime)
    assert snapshot['nodes']['joy_controller']['values']['angular_input_ratio'] == -3.0
    assert snapshot['nodes']['shot_component'] == {'status': 'unavailable', 'values': {}}
    assert snapshot['domain_id'] == 71
    assert snapshot['captured_at']


@pytest.mark.parametrize('failure,status', [
    (subprocess.TimeoutExpired('reader', 8), 504),
    (OSError('cannot spawn'), 503),
])
def test_subprocess_failure_releases_lock(runtime, failure, status):
    """Timeouts and startup failures must not prevent later attempts."""
    with patch.object(control_runtime.subprocess, 'run', side_effect=failure):
        with pytest.raises(HTTPException) as raised:
            control_runtime.read_snapshot(runtime)
        assert raised.value.status_code == status
    assert not control_runtime._lock.locked()


@pytest.mark.parametrize('stdout', ['not JSON', '{}', '{"joy_controller": []}'])
def test_malformed_worker_results_are_not_displayed(runtime, stdout):
    """Never substitute saved defaults or arbitrary output for live values."""
    with patch.object(control_runtime.subprocess, 'run', return_value=SimpleNamespace(
            returncode=0, stdout=stdout)):
        with pytest.raises(HTTPException) as raised:
            control_runtime.read_snapshot(runtime)
        assert raised.value.status_code == 502


def test_concurrent_query_is_rejected(runtime):
    """A busy reader cannot create unbounded subprocesses."""
    with control_runtime._lock:
        with patch.object(control_runtime.subprocess, 'run') as run:
            with pytest.raises(HTTPException) as raised:
                control_runtime.read_snapshot(runtime)
            assert raised.value.status_code == 409
            run.assert_not_called()


def test_invalid_environment_never_starts_process():
    """Reject invalid domain IDs and distribution paths before executing anything."""
    with patch.object(control_runtime.subprocess, 'run') as run:
        with pytest.raises(HTTPException):
            control_runtime.read_snapshot({'ROS_DOMAIN_ID': '233'})
        with pytest.raises(HTTPException):
            control_runtime._ros_paths({'ROS_DISTRO': '../../etc'})
        run.assert_not_called()


def test_worker_parallel_queries_share_deadline_and_destroy_clients(monkeypatch):
    """An absent or stalled node must not block values returned by healthy nodes."""
    now = [0.0]
    monkeypatch.setattr(read_control_parameters.time, 'monotonic', lambda: now[0])
    requested = {'ready': ['gain', 'missing'], 'absent': ['gain'], 'stalled': ['gain']}
    requests = []
    destroyed = []

    class Service:
        """Minimal GetParameters service type."""

        class Request:
            """Hold requested names."""

    class Client:
        """Simulate discovery and asynchronous responses."""

        def __init__(self, name):
            self.name = name

        def service_is_ready(self):
            return self.name != 'absent'

        def call_async(self, request):
            requests.append((self.name, request.names))
            return SimpleNamespace(done=lambda: self.name == 'ready',
                                   result=lambda: SimpleNamespace(values=[2.0, None]))

    def spin_once(node, timeout_sec):
        now[0] += timeout_sec

    node = SimpleNamespace(create_client=lambda service, path: Client(path.split('/')[1]),
                           destroy_client=lambda client: destroyed.append(client.name))
    result = read_control_parameters.collect(node, requested, spin_once, lambda value: value,
                                             Service, timeout=0.2)
    assert result['ready'] == {'status': 'ok', 'values': {'gain': 2.0}}
    assert result['absent'] == {'status': 'unavailable', 'values': {}}
    assert result['stalled'] == {'status': 'timeout', 'values': {}}
    assert len(requests) == 2
    assert sorted(destroyed) == ['absent', 'ready', 'stalled']
    assert now[0] == pytest.approx(0.2)
