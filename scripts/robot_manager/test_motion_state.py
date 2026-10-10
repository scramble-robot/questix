"""Why the robot does not move: the one-shot reader, tested without ROS."""

import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
import pytest

from robot_manager import motion_state, read_motion_state

STATE = {
    "emergency_stop": {"active": False, "source": "operation_manager", "reason": "released"},
    "motion_permission": {"mode": "lesson", "drive_allowed": False, "launcher_allowed": True,
                          "drive_blockers": ["teacher:off"], "launcher_blockers": []},
}


@pytest.fixture
def config(monkeypatch, tmp_path):
    monkeypatch.setattr(motion_state.control_runtime, '_ros_paths', lambda config: (
        tmp_path / 'ros/setup.bash', tmp_path / 'ws with spaces/install/setup.bash'))
    return {'ROS_DOMAIN_ID': '71'}


def test_reads_once_in_the_robots_domain_with_quoted_paths(config):
    def run(command, **kwargs):
        assert command[:4] == ['/bin/bash', '--noprofile', '--norc', '-c']
        assert 'source "$1"' in command[4] and 'source "$2"' in command[4]
        assert Path(command[-2]).name == 'read_motion_state.py'
        assert command[-1] == '71' and kwargs['env']['ROS_DOMAIN_ID'] == '71'
        assert kwargs['timeout'] == 8
        return SimpleNamespace(returncode=0, stdout=json.dumps(STATE))

    with patch.object(motion_state.subprocess, 'run', side_effect=run):
        state = motion_state.read_state(config)
    assert state['motion_permission']['drive_blockers'] == ['teacher:off']
    assert state['emergency_stop']['active'] is False
    assert state['domain_id'] == 71 and state['captured_at']


def test_missing_topics_are_null_not_an_error(config):
    empty = {"emergency_stop": None, "motion_permission": None}
    with patch.object(motion_state.subprocess, 'run',
                      return_value=SimpleNamespace(returncode=0, stdout=json.dumps(empty))):
        state = motion_state.read_state(config)
    assert state['emergency_stop'] is None and state['motion_permission'] is None


@pytest.mark.parametrize('stdout', [
    'not json',
    json.dumps({"emergency_stop": None}),
    json.dumps(dict(STATE, emergency_stop={"active": "yes", "source": "", "reason": ""})),
    json.dumps(dict(STATE, motion_permission=dict(STATE["motion_permission"],
                                                  drive_blockers=[1]))),
    json.dumps(dict(STATE, motion_permission=dict(STATE["motion_permission"],
                                                  drive_blockers=["x" * 500]))),
])
def test_an_unexpected_answer_is_refused(config, stdout):
    with patch.object(motion_state.subprocess, 'run',
                      return_value=SimpleNamespace(returncode=0, stdout=stdout)):
        with pytest.raises(HTTPException) as raised:
            motion_state.read_state(config)
    assert raised.value.status_code == 502


@pytest.mark.parametrize('failure,status', [
    (subprocess.TimeoutExpired('reader', 8), 504),
    (OSError('cannot spawn'), 503),
])
def test_failures_release_the_lock(config, failure, status):
    with patch.object(motion_state.subprocess, 'run', side_effect=failure):
        with pytest.raises(HTTPException) as raised:
            motion_state.read_state(config)
    assert raised.value.status_code == status
    with patch.object(motion_state.subprocess, 'run',
                      return_value=SimpleNamespace(returncode=0, stdout=json.dumps(STATE))):
        assert motion_state.read_state(config)['emergency_stop']['reason'] == 'released'


def test_an_invalid_domain_is_refused_before_anything_runs(config):
    with patch.object(motion_state.subprocess, 'run') as run:
        with pytest.raises(HTTPException) as raised:
            motion_state.read_state({'ROS_DOMAIN_ID': '150'})
    assert raised.value.status_code == 422 and not run.called


def test_the_worker_waits_for_both_and_stops_at_the_deadline():
    clock = {'now': 0.0}

    def spin_once(node, timeout_sec):
        clock['now'] += 0.05
        if clock['now'] >= 0.5:
            state['emergency_stop'] = {'active': True, 'source': 'x', 'reason': 'pressed'}

    state = {'emergency_stop': None, 'motion_permission': None}
    read_motion_state.collect(spin_once, None, state, deadline_sec=1.0, now=lambda: clock['now'])
    assert state['emergency_stop'] is not None and state['motion_permission'] is None
    assert clock['now'] == pytest.approx(1.0, abs=0.06)


def test_the_worker_copies_the_message_fields():
    estop = SimpleNamespace(active=True, source='operation_manager', reason='pin 5 timeout; ')
    assert read_motion_state.estop_dict(estop) == {
        'active': True, 'source': 'operation_manager', 'reason': 'pin 5 timeout; '}
    permission = SimpleNamespace(mode='competition', drive_allowed=False, launcher_allowed=False,
                                 drive_blockers=['referee:off'], launcher_blockers=['referee:off'])
    assert motion_state._validate({'emergency_stop': None,
                                   'motion_permission': read_motion_state.permission_dict(
                                       permission)})
