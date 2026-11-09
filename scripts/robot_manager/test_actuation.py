"""Tests for the teacher's runtime actuation authority (no ROS: the heartbeat is a fake process)."""

import importlib
import io
import json
import os
import subprocess
import types

import pytest
from fastapi import HTTPException


class _FakeStdin(io.StringIO):
    def __init__(self):
        super().__init__()
        self.lines = []
        self.closed_by_parent = False

    def write(self, text):
        self.lines.append(json.loads(text))
        return len(text)

    def flush(self):
        pass

    def close(self):
        self.closed_by_parent = True


class _FakeHeartbeat:
    """What subprocess.Popen returns for the heartbeat: running until stdin closes or it 'dies'."""

    def __init__(self, command, **kwargs):
        self.command = command
        self.kwargs = kwargs
        self.stdin = _FakeStdin()
        self.returncode = None
        self.pid = 4242

    def poll(self):
        if self.stdin.closed_by_parent and self.returncode is None:
            self.returncode = 0
        return self.returncode

    def wait(self, timeout=None):
        self.returncode = 0 if self.returncode is None else self.returncode
        return self.returncode

    def kill(self):
        self.returncode = -9


def _line(drive, launcher, lab_drive=False, lab_launcher=False):
    """One state line as the heartbeat reads it."""
    return {"drive": drive, "launcher": launcher, "lab_drive": lab_drive,
            "lab_launcher": lab_launcher}


@pytest.fixture
def actuation(tmp_path, monkeypatch):
    monkeypatch.setenv("QUESTIX_CONFIG_DIR", str(tmp_path))
    # The teacher's permission exists in lesson mode only (modes.uses_teacher_permission).
    (tmp_path / "mode").write_text("lesson\n")
    from robot_manager import actuation as module
    module = importlib.reload(module)
    ros = tmp_path / "ros.bash"
    workspace = tmp_path / "ws.bash"
    ros.write_text("")
    workspace.write_text("")
    monkeypatch.setattr(module.control_runtime, "_ros_paths", lambda config: (ros, workspace))
    started = []

    def popen(command, **kwargs):
        proc = _FakeHeartbeat(command, **kwargs)
        started.append(proc)
        return proc

    # Only this module's Popen: the real subprocess module stays untouched for everyone else.
    fake = types.SimpleNamespace(Popen=popen, PIPE=subprocess.PIPE, DEVNULL=subprocess.DEVNULL,
                                 TimeoutExpired=subprocess.TimeoutExpired)
    monkeypatch.setattr(module, "subprocess", fake)
    monkeypatch.setattr(module, "START_GRACE_SEC", 0.0)
    # The robot runs a lesson launch (app.py's real source asks systemd and last-launch).
    module.running = {"mode": "lesson"}
    monkeypatch.setattr(module, "_running_mode_source", lambda: module.running["mode"])
    module.started = started
    return module


def test_everything_starts_off_and_nothing_is_published(actuation):
    status = actuation.status()
    assert status["drive"] is False and status["launcher"] is False
    assert status["running"] is False and status["transient"] is True
    assert actuation.started == []


def test_switching_on_starts_the_heartbeat_in_the_robots_domain(actuation, tmp_path):
    (tmp_path / "launch.env").write_text("ROBOT_WS=/home/ubuntu/robot_ws\nROS_DOMAIN_ID=17\n")
    status = actuation.set_authority("drive", True)
    assert status["drive"] is True and status["launcher"] is False and status["running"] is True
    (proc,) = actuation.started
    script = proc.command[4]
    assert "export ROS_DOMAIN_ID=17; " in script and 'exec /usr/bin/python3 "$3"' in script
    assert proc.command[-1].endswith("actuation_heartbeat.py")  # a positional argument
    assert "ROS_DOMAIN_ID" not in proc.kwargs["env"]
    assert proc.stdin.lines == [_line(True, False)]


def test_the_two_switches_share_one_heartbeat_and_off_is_sent_at_once(actuation):
    actuation.set_authority("drive", True)
    actuation.set_authority("launcher", True)
    actuation.set_authority("drive", False)
    (proc,) = actuation.started
    assert proc.stdin.lines == [_line(True, False), _line(True, True), _line(False, True)]
    assert not proc.stdin.closed_by_parent
    actuation.set_authority("launcher", False)
    assert proc.stdin.closed_by_parent  # the heartbeat publishes all off and exits
    assert actuation.status()["running"] is False


def test_no_authority_in_competition_mode(actuation, tmp_path):
    (tmp_path / "mode").write_text("competition\n")
    with pytest.raises(HTTPException) as error:
        actuation.set_authority("drive", True)
    assert error.value.status_code == 409
    assert actuation.started == []
    actuation.set_authority("drive", False)  # switching off is always possible


def test_a_heartbeat_that_cannot_start_leaves_everything_off(actuation, monkeypatch):
    def missing(config):
        raise HTTPException(503, "ROS 環境が見つかりません。")

    monkeypatch.setattr(actuation.control_runtime, "_ros_paths", missing)
    with pytest.raises(HTTPException):
        actuation.set_authority("launcher", True)
    status = actuation.status()
    assert status["launcher"] is False and "ROS" in status["error"]


def test_a_heartbeat_that_exits_at_once_is_refused(actuation, monkeypatch):
    class _Dead(_FakeHeartbeat):
        def poll(self):
            self.returncode = 1
            return 1

    monkeypatch.setattr(actuation.subprocess, "Popen", lambda command, **kw: _Dead(command))
    # (actuation.subprocess is the fixture's stand-in, so this changes nothing else.)
    with pytest.raises(HTTPException) as error:
        actuation.set_authority("drive", True)
    assert error.value.status_code == 503
    assert actuation.status()["drive"] is False


def test_a_heartbeat_that_dies_switches_everything_off(actuation):
    actuation.set_authority("drive", True)
    actuation.set_authority("launcher", True)
    actuation.set_lab("drive", True)
    actuation.started[0].returncode = 1  # crashed; the robot already stopped when its lease ran out
    status = actuation.status()
    assert status["drive"] is False and status["launcher"] is False
    assert status["lab_drive"] is False and status["lab_launcher"] is False
    assert status["last_off_reason"] == "heartbeat_exited" and status["error"]
    # Nothing restarts it by itself.
    assert len(actuation.started) == 1


def test_revoke_all_ends_the_heartbeat_and_the_lesson_permissions(actuation):
    actuation.set_authority("drive", True)
    actuation.set_lab("drive", True)
    result = actuation.revoke_all("stop_all")
    assert result["revoked"] == ["drive"] and result["drive"] is False
    assert result["lab_drive"] is False
    assert actuation.started[0].stdin.closed_by_parent


# ---- QUESTiX LAB's lesson permissions (/lab_permission) ----

def test_a_lesson_permission_needs_the_switch_of_its_kind(actuation):
    with pytest.raises(HTTPException) as error:
        actuation.set_lab("drive", True)
    assert error.value.status_code == 409 and "ロボットの走行制御" in error.value.detail
    actuation.set_authority("drive", True)
    with pytest.raises(HTTPException) as error:
        actuation.set_lab("launcher", True)
    assert "発射機構の操作" in error.value.detail
    # Switching the switch on never switches a lesson permission on.
    assert actuation.lab_permissions() == {"drive": False, "launcher": False}
    assert actuation.set_lab("drive", True) == {"drive": True, "launcher": False}
    (proc,) = actuation.started
    assert proc.stdin.lines[-1] == _line(True, False, lab_drive=True)


def test_the_switch_going_off_takes_its_lesson_permission_in_the_same_line(actuation):
    actuation.set_authority("drive", True)
    actuation.set_authority("launcher", True)
    actuation.set_lab("drive", True)
    actuation.set_lab("launcher", True)
    actuation.set_authority("drive", False)
    (proc,) = actuation.started
    # One line: /lab_permission never says yes while the teacher's switch says no.
    assert proc.stdin.lines[-1] == _line(False, True, lab_launcher=True)
    assert actuation.lab_permissions() == {"drive": False, "launcher": True}
    actuation.set_authority("drive", True)  # back on: the lesson permission stays off
    assert actuation.lab_permissions() == {"drive": False, "launcher": True}


def test_a_lesson_permission_off_and_revoke_lab_never_raise(actuation):
    assert actuation.set_lab("drive", False) == {"drive": False, "launcher": False}
    assert actuation.revoke_lab() is False
    actuation.set_authority("launcher", True)
    actuation.set_lab("launcher", True)
    assert actuation.revoke_lab() is True
    (proc,) = actuation.started
    assert proc.stdin.lines[-1] == _line(False, True)
    assert actuation.status()["launcher"] is True  # the teacher's switch stays


def test_a_failed_write_for_a_lesson_permission_switches_everything_off(actuation):
    actuation.set_authority("drive", True)
    (proc,) = actuation.started
    _break_heartbeat_stdin(proc)
    with pytest.raises(HTTPException) as error:
        actuation.set_lab("drive", True)
    assert error.value.status_code == 503
    status = actuation.status()
    assert status["drive"] is False and status["lab_drive"] is False
    assert status["running"] is False and status["last_off_reason"] == "heartbeat_write_failed"


# ---- the heartbeat process (actuation_heartbeat.run, ROS-free) ----

class _Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


def _heartbeat_run(lines, steps, parent_alive=lambda: True):
    """Run the loop over scripted stdin lines; each step either waits for a period or reads."""
    from robot_manager import actuation_heartbeat as heartbeat
    heartbeat = importlib.reload(heartbeat)
    clock = _Clock()
    published = []
    plan = list(steps)

    def wait(timeout):
        step = plan.pop(0) if plan else "read"
        if step == "idle":
            clock.now += timeout
            return False
        return True

    read_fd, write_fd = os.pipe()
    with os.fdopen(read_fd, 'rb') as stdin, os.fdopen(write_fd, 'wb', buffering=0) as writer:
        writer.write("".join(lines).encode())
        writer.close()
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(heartbeat.time, 'sleep', lambda _seconds: None)
            heartbeat.run(stdin.fileno(), lambda *state: published.append(state),
                          now=clock, wait=wait, parent_alive=parent_alive)
    return heartbeat, published


OFF = (False, False, False, False)


def test_heartbeat_repeats_the_latest_state_and_ends_with_explicit_offs():
    heartbeat, published = _heartbeat_run(
        ['{"drive": true, "launcher": false, "lab_drive": true}\n'],
        ["read", "idle", "idle", "read"])
    # Initial off, the change at once, two periods of the new state, then EOF: explicit offs.
    assert published[0] == OFF
    assert published[1] == (True, False, True, False)
    assert published[2:4] == [(True, False, True, False)] * 2
    assert published[-heartbeat.FINAL_OFF_COUNT:] == [OFF] * heartbeat.FINAL_OFF_COUNT


def test_heartbeat_treats_anything_unexpected_as_off():
    from robot_manager import actuation_heartbeat as heartbeat
    assert heartbeat.parse_state(
        '{"drive": true, "launcher": true, "lab_drive": true, "lab_launcher": true}') == (
        True, True, True, True)
    assert heartbeat.parse_state('{"drive": "true", "launcher": 1, "lab_drive": true}') == OFF
    assert heartbeat.parse_state("not json") == OFF
    assert heartbeat.parse_state("[true, true]") == OFF


def test_heartbeat_never_publishes_a_lesson_permission_without_its_switch():
    from robot_manager import actuation_heartbeat as heartbeat
    assert heartbeat.parse_state(
        '{"drive": false, "launcher": true, "lab_drive": true, "lab_launcher": true}') == (
        False, True, False, True)


def test_heartbeat_stops_when_the_manager_is_gone():
    alive = iter([True, False])
    heartbeat, published = _heartbeat_run(
        ['{"drive": true, "launcher": true}\n'], ["read", "idle", "idle", "idle"],
        parent_alive=lambda: next(alive, False))
    assert (True, True, False, False) in published
    assert published[-heartbeat.FINAL_OFF_COUNT:] == [OFF] * heartbeat.FINAL_OFF_COUNT


def test_heartbeat_uses_volatile_qos_never_transient_local():
    from pathlib import Path
    text = Path(__file__).with_name("actuation_heartbeat.py").read_text(encoding="utf-8")
    assert "DurabilityPolicy.VOLATILE" in text
    assert "TRANSIENT_LOCAL" not in text
    assert 'TOPIC = "/actuation_authority"' in text
    assert 'LAB_TOPIC = "/lab_permission"' in text


# ---- how the rest of the manager uses it ----

@pytest.fixture
def lab(actuation, tmp_path, monkeypatch):
    from robot_manager import lab as module
    module = importlib.reload(module)
    monkeypatch.setattr(module, "_bridge_state", lambda: None)
    monkeypatch.setattr(module, "_port_in_use", lambda: False)
    monkeypatch.setattr(module, "_lan_addresses", lambda: [])
    monkeypatch.setattr(module, "LOG_FILE", tmp_path / "cache" / "lab-bridge.log")
    monkeypatch.setattr(module.recorder, "ROSBAG_ENV_FILE", tmp_path / "rosbag.env")
    monkeypatch.setattr(module, "actuation", actuation)
    return module


def test_a_lesson_permission_needs_the_teachers_authority(lab, actuation):
    with pytest.raises(HTTPException) as error:
        lab.set_drive(lab.DriveRequest(allow=True))
    assert error.value.status_code == 409 and "ロボットの走行制御" in error.value.detail
    with pytest.raises(HTTPException) as error:
        lab.set_shoot(lab.DriveRequest(allow=True))
    assert "発射機構の操作" in error.value.detail
    # Switching the authority on never switches a lesson permission on.
    actuation.set_authority("drive", True)
    status = lab.get_status()
    assert status["drive_authority"] is True and status["drive_allowed"] is False
    assert lab.set_drive(lab.DriveRequest(allow=True))["drive_allowed"] is True


def test_the_authority_going_off_takes_the_lesson_permission_with_it(lab, actuation):
    actuation.set_authority("drive", True)
    actuation.set_authority("launcher", True)
    lab.set_drive(lab.DriveRequest(allow=True))
    lab.set_shoot(lab.DriveRequest(allow=True))
    actuation.set_authority("drive", False)
    status = lab.get_status()
    assert status["drive_allowed"] is False and status["shoot_allowed"] is True
    actuation.started[0].returncode = 1  # the heartbeat died
    actuation.status()
    assert lab.get_status()["shoot_allowed"] is False


@pytest.mark.parametrize("switched_off", ["drive", "launcher"])
def test_a_teacher_off_after_an_unnoticed_heartbeat_exit_revokes_both_lesson_permissions(
        lab, actuation, switched_off):
    actuation.set_authority("drive", True)
    actuation.set_authority("launcher", True)
    lab.set_drive(lab.DriveRequest(allow=True))
    lab.set_shoot(lab.DriveRequest(allow=True))
    actuation.started[0].returncode = 1  # the heartbeat died; no status() poll noticed it yet
    actuation.set_authority(switched_off, False)
    with actuation._lock:
        assert actuation._authority == {"drive": False, "launcher": False}
    status = lab.get_status()
    assert status["drive_allowed"] is False and status["shoot_allowed"] is False


def test_revoke_all_after_an_unnoticed_heartbeat_exit_reports_what_was_on(actuation):
    actuation.set_authority("drive", True)
    actuation.started[0].returncode = 1
    result = actuation.revoke_all("stop_all")
    assert result["revoked"] == ["drive"]


def test_a_failed_switch_on_still_switches_off_what_the_reap_found(actuation, monkeypatch):
    actuation.set_authority("drive", True)
    actuation.started[0].returncode = 1

    def missing(config):
        raise HTTPException(503, "ROS 環境が見つかりません。")

    monkeypatch.setattr(actuation.control_runtime, "_ros_paths", missing)
    with pytest.raises(HTTPException):
        actuation.set_authority("launcher", True)
    assert actuation.status()["drive"] is False


def _break_heartbeat_stdin(proc):
    """Make every later write to the (still running) heartbeat fail, as a broken pipe would."""
    def write(text):
        raise OSError(32, "Broken pipe")

    proc.stdin.write = write


def _assert_no_switch_without_heartbeat(actuation):
    status = actuation.status()
    if not status["running"]:
        assert status["drive"] is False and status["launcher"] is False
    return status


@pytest.mark.parametrize("already_on, switched_on, lesson",
                         [("launcher", "drive", "set_shoot"), ("drive", "launcher", "set_drive")])
def test_a_failed_write_while_the_other_switch_is_on_switches_both_off(
        lab, actuation, already_on, switched_on, lesson):
    actuation.set_authority(already_on, True)
    getattr(lab, lesson)(lab.DriveRequest(allow=True))
    (proc,) = actuation.started
    assert proc.poll() is None  # the heartbeat is still running; only the write fails
    _break_heartbeat_stdin(proc)
    with pytest.raises(HTTPException) as error:
        actuation.set_authority(switched_on, True)
    assert error.value.status_code == 503
    status = _assert_no_switch_without_heartbeat(actuation)
    assert status["drive"] is False and status["launcher"] is False and status["running"] is False
    assert status["last_off_reason"] == "heartbeat_write_failed" and status["error"]
    assert proc.stdin.closed_by_parent  # stopped, not left behind
    lab_status = lab.get_status()
    assert lab_status["drive_allowed"] is False and lab_status["shoot_allowed"] is False


def test_a_failed_write_for_the_first_switch_leaves_nothing_on(lab, actuation, monkeypatch):
    class _Unwritable(_FakeHeartbeat):
        def __init__(self, command, **kwargs):
            super().__init__(command, **kwargs)
            _break_heartbeat_stdin(self)

    monkeypatch.setattr(actuation.subprocess, "Popen", lambda command, **kw: _Unwritable(command))
    with pytest.raises(HTTPException) as error:
        actuation.set_authority("drive", True)
    assert error.value.status_code == 503
    status = _assert_no_switch_without_heartbeat(actuation)
    assert status["drive"] is False and status["launcher"] is False and status["running"] is False
    lab_status = lab.get_status()
    assert lab_status["drive_allowed"] is False and lab_status["shoot_allowed"] is False


def test_a_failed_write_on_a_teacher_off_takes_the_other_switch_with_it(lab, actuation):
    actuation.set_authority("drive", True)
    actuation.set_authority("launcher", True)
    lab.set_drive(lab.DriveRequest(allow=True))
    lab.set_shoot(lab.DriveRequest(allow=True))
    _break_heartbeat_stdin(actuation.started[0])
    status = actuation.set_authority("drive", False)
    assert status["drive"] is False and status["launcher"] is False and status["running"] is False
    assert status["last_off_reason"] == "heartbeat_write_failed"
    _assert_no_switch_without_heartbeat(actuation)
    lab_status = lab.get_status()
    assert lab_status["drive_allowed"] is False and lab_status["shoot_allowed"] is False


@pytest.fixture
def app_module(lab, actuation, monkeypatch):
    from robot_manager import app as module
    module = importlib.reload(module)
    monkeypatch.setattr(module, "actuation", actuation)
    monkeypatch.setattr(module, "lab", lab)
    # Importing app installs its own running-mode source (systemd); keep the test's lesson launch.
    monkeypatch.setattr(actuation, "_running_mode_source", lambda: actuation.running["mode"])
    return module


def test_every_mode_switch_and_service_action_switches_the_authority_off(app_module, actuation,
                                                                         monkeypatch):
    monkeypatch.setattr(app_module, "_service_status", lambda: "inactive")
    monkeypatch.setattr(app_module, "_systemctl", lambda action: None)
    monkeypatch.setattr(app_module, "_start_result", lambda action, mode, at: {"ok": True})
    monkeypatch.setattr(app_module, "_stop_service",
                        lambda: {"ok": True, "state": "inactive", "detail": "", "message": ""})
    monkeypatch.setattr(app_module.lab, "disable_outside_lessons", lambda: None)
    monkeypatch.setattr(app_module.lab, "enable_for_lessons", lambda: None)
    for call in (lambda: app_module.set_mode(app_module.ModeRequest(mode="lesson")),
                 lambda: app_module.control_service("start"),
                 lambda: app_module.control_service("restart"),
                 lambda: app_module.control_service("stop")):
        actuation.set_authority("drive", True)
        call()
        assert actuation.status()["drive"] is False
    for other in ("practice", "competition"):
        app_module.set_mode(app_module.ModeRequest(mode="lesson"))
        actuation.set_authority("launcher", True)
        app_module.set_mode(app_module.ModeRequest(mode=other))
        assert actuation.status()["launcher"] is False


@pytest.mark.parametrize("mode", ["practice", "competition"])
def test_the_switches_are_refused_outside_lesson_mode(actuation, tmp_path, mode):
    # Practice (the controller alone) and competition never use the teacher's permission.
    (tmp_path / "mode").write_text(mode + "\n")
    for kind in ("drive", "launcher"):
        with pytest.raises(HTTPException) as error:
            actuation.set_authority(kind, True)
        assert error.value.status_code == 409 and "教材モードだけ" in error.value.detail
    status = actuation.status()
    assert status["available"] is False and status["mode"] == mode
    assert status["drive"] is False and status["launcher"] is False


def test_a_missing_mode_file_means_practice(actuation, tmp_path):
    (tmp_path / "mode").unlink()
    with pytest.raises(HTTPException):
        actuation.set_authority("drive", True)
    assert actuation.status()["mode"] == "practice"


def test_stop_all_switches_the_authority_off_before_anything_else(app_module, actuation, lab,
                                                                  monkeypatch):
    calls = []
    real_revoke = actuation.revoke_all
    monkeypatch.setattr(app_module.actuation, "revoke_all",
                        lambda reason: calls.append("authority") or real_revoke(reason))
    monkeypatch.setattr(lab, "stop_lesson_motion",
                        lambda: calls.append("lesson") or {"ok": True, "message": ""})
    monkeypatch.setattr(app_module, "_stop_service",
                        lambda: calls.append("service") or {"ok": True, "state": "inactive",
                                                            "message": ""})
    actuation.set_authority("drive", True)
    answer = app_module.stop_all()
    assert calls == ["authority", "lesson", "service"]
    assert answer["actuation"]["drive"] is False and answer["actuation"]["revoked"] == ["drive"]


def test_manager_shutdown_ends_the_heartbeat(app_module, actuation, monkeypatch):
    import asyncio
    monkeypatch.setattr(app_module.lab, "autostart", lambda: None)
    monkeypatch.setattr(app_module.lab, "shutdown", lambda: None)
    actuation.set_authority("launcher", True)

    async def run():
        async with app_module.lifespan(app_module.app):
            assert actuation.status()["launcher"] is True

    asyncio.run(run())
    assert actuation.status()["launcher"] is False
    assert actuation.started[0].stdin.closed_by_parent


@pytest.mark.parametrize("running", [None, "practice", "competition", "unknown"])
def test_switching_on_needs_a_running_lesson_launch(actuation, running):
    # Saved lesson mode, but the robot runs another launch (or none): refused, nothing started.
    actuation.running["mode"] = running
    with pytest.raises(HTTPException) as error:
        actuation.set_authority("drive", True)
    assert error.value.status_code == 409
    assert "教材モードで起動" in error.value.detail
    assert actuation.started == []
    status = actuation.status()
    assert status["available"] is False and status["running_mode"] == running
    assert status["mode"] == "lesson"


def test_a_running_lesson_launch_with_another_saved_mode_is_not_usable(actuation, tmp_path):
    # The teacher saved practice for the next start: the switches stay off until then.
    (tmp_path / "mode").write_text("practice\n")
    with pytest.raises(HTTPException):
        actuation.set_authority("launcher", True)
    assert actuation.status()["available"] is False


# ---- Three choices: no real systemd, heartbeat, listener or bridge process ----

def _choice(module, kind, choice, snapshot=None):
    state = snapshot or module.status()
    return module.set_choice(kind, module.ChoiceRequest(
        choice=choice, instance=state["instance"], revision=state["revision"]))


@pytest.mark.parametrize("kind", ["drive", "launcher"])
def test_choices_send_the_complete_pair_without_an_intermediate_lab_only_state(actuation, kind):
    from robot_manager.actuation_heartbeat import parse_state
    assert _choice(actuation, kind, "none")["choices"][kind] == "none"
    other = "launcher" if kind == "drive" else "drive"
    _choice(actuation, other, "controller")  # keep heartbeat alive when this kind goes off
    for choice, bits in [("controller", (True, False)), ("controller_and_lab", (True, True)),
                         ("controller", (True, False)), ("none", (False, False))]:
        before = actuation.status()["revision"]
        state = _choice(actuation, kind, choice)
        assert state["revision"] > before
        assert state["choices"][kind] == choice
        line = actuation.started[0].stdin.lines[-1]
        assert (line[kind], line[f"lab_{kind}"]) == bits
        for authority, lab_bit in zip(parse_state(json.dumps(line))[:2],
                                      parse_state(json.dumps(line))[2:]):
            assert not lab_bit or authority
    # No intermediate writes for OFF -> both ON; authority -> lab happens in the unchanged
    # heartbeat publish function, not through two competing HTTP requests.
    lines = actuation.started[0].stdin.lines
    assert len(lines) == 5


@pytest.mark.parametrize("kind", ["drive", "launcher"])
def test_stale_reductions_succeed_but_stale_grants_never_change_state(actuation, kind):
    stale = actuation.status()
    _choice(actuation, kind, "controller_and_lab")
    assert _choice(actuation, kind, "controller", stale)["choices"][kind] == "controller"
    current = actuation.status()
    with pytest.raises(HTTPException) as error:
        _choice(actuation, kind, "controller_and_lab", stale)
    assert error.value.status_code == 409
    assert error.value.detail["reason"] == "stale_revision"
    assert error.value.detail["state"] == current
    # Even a different Manager instance may lower permission.
    stale = {"instance": "previous-manager", "revision": 99999}
    assert _choice(actuation, kind, "none", stale)["choices"][kind] == "none"
    assert actuation.started[0].stdin.closed_by_parent  # unchanged final all-off protocol
    assert _choice(actuation, kind, "none", stale)["choices"][kind] == "none"
    with pytest.raises(HTTPException) as error:
        _choice(actuation, kind, "controller", stale)
    assert error.value.status_code == 409
    assert actuation.status()[kind] is False


@pytest.mark.parametrize("running", [None, "unknown", "practice", "competition"])
def test_new_choices_cannot_grant_outside_a_running_lesson(actuation, running):
    actuation.running["mode"] = running
    with pytest.raises(HTTPException) as error:
        _choice(actuation, "drive", "controller_and_lab")
    assert error.value.status_code == 409
    assert error.value.detail["reason"] == "unavailable"
    assert actuation.started == []
    assert _choice(actuation, "drive", "none")["drive"] is False


def test_new_choices_keep_revocations_and_never_restore_after_failure(actuation, lab):
    _choice(actuation, "drive", "controller_and_lab")
    _choice(actuation, "launcher", "controller_and_lab")
    before = actuation.status()
    actuation.revoke_lab()
    assert actuation.status()["choices"] == {"drive": "controller", "launcher": "controller"}
    assert actuation.status()["revision"] > before["revision"]
    for reason in ["mode_practice", "service_start", "service_restart", "service_stop", "stop_all",
                   "manager_shutdown"]:
        before = actuation.status()
        state = actuation.revoke_all(reason)
        assert state["revision"] > before["revision"]
        assert state["choices"] == {"drive": "none", "launcher": "none"}
        with pytest.raises(HTTPException):
            _choice(actuation, "drive", "controller", before)
    _choice(actuation, "drive", "controller_and_lab")
    actuation.started[-1].returncode = 1
    state = actuation.status()
    assert state["choices"] == {"drive": "none", "launcher": "none"}
    count = len(actuation.started)
    assert actuation.status()["choices"] == state["choices"]
    assert len(actuation.started) == count


def test_choice_write_failure_returns_confirmed_all_off(actuation, monkeypatch):
    _choice(actuation, "drive", "controller")
    monkeypatch.setattr(actuation, "_send_locked", lambda: False)
    with pytest.raises(HTTPException) as error:
        _choice(actuation, "launcher", "controller_and_lab")
    assert error.value.status_code == 503
    assert error.value.detail["state"]["choices"] == {"drive": "none", "launcher": "none"}
    assert actuation.status()["last_off_reason"] == actuation.WRITE_FAILED


def test_old_and_new_setters_share_one_version_and_preserve_both_kinds(actuation):
    from concurrent.futures import ThreadPoolExecutor
    _choice(actuation, "drive", "controller_and_lab")
    _choice(actuation, "launcher", "controller_and_lab")
    previous = actuation.status()["revision"]
    # Deterministic interleaving and concurrent old/new reductions (no live child processes).
    for _ in range(10):
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(fn) for fn in (
                lambda: _choice(actuation, "drive", "none", {"instance": "old", "revision": 0}),
                lambda: actuation.set_authority("launcher", False),
                lambda: actuation.set_lab("drive", False),
                lambda: actuation.revoke_lab())]
            for future in futures:
                future.result()
        state = actuation.status()
        assert state["revision"] > previous
        previous = state["revision"]
        _choice(actuation, "drive", "controller_and_lab")
        actuation.set_authority("launcher", True)
        actuation.set_lab("launcher", True)
    for proc in actuation.started:
        for line in proc.stdin.lines:
            assert all(not line[f"lab_{kind}"] or line[kind] for kind in actuation.KINDS)


@pytest.fixture
def permission_client(actuation, lab, monkeypatch):
    """Exercise the real routes with startup functions replaced before any request."""
    from robot_manager.test_wifi_ap import asgi

    def forbidden(*args, **kwargs):
        pytest.fail("a permission HTTP test attempted a real process or robot action")

    # These are not the actuation module's local fake Popen. The real entry points are forbidden.
    monkeypatch.setattr(subprocess, "Popen", forbidden)
    monkeypatch.setattr(subprocess, "run", forbidden)
    from robot_manager import app, estop_monitor
    monkeypatch.setattr(app, "_systemctl", forbidden)
    monkeypatch.setattr(actuation, "_running_mode_source", lambda: "lesson")
    monkeypatch.setattr(lab, "autostart", forbidden)
    monkeypatch.setattr(lab, "start_bridge", forbidden)
    monkeypatch.setattr(estop_monitor, "_start_locked", forbidden)
    encode, decode = json.dumps, json.loads

    class Client:
        def request(self, method, path, json=None, content=None, headers=None):
            hdr = {"host": "127.0.0.1:8888", "content-type": "application/json"}
            hdr.update({key.lower(): value for key, value in (headers or {}).items()})
            body = content.encode() if content is not None else encode(json).encode()
            code, raw = asgi(app.app, method, path, hdr, body if method == "POST" else b"")
            return types.SimpleNamespace(status_code=code, json=lambda: decode(raw))

        def get(self, path):
            return self.request("GET", path)

        def post(self, path, **kwargs):
            return self.request("POST", path, **kwargs)

    # Existing ASGI helper exercises the full app/middleware without httpx or lifespan startup.
    return Client()


def test_all_permission_http_routes_share_the_browser_guard(permission_client, actuation):
    client = permission_client
    choice = {"choice": "controller_and_lab", **{key: actuation.status()[key]
                                               for key in ("instance", "revision")}}
    for route, body in [("/api/actuation/choice/drive", choice),
                        ("/api/actuation/drive", {"allow": True}),
                        ("/api/actuation/launcher", {"allow": True}),
                        ("/api/lab/drive", {"allow": True}), ("/api/lab/shoot", {"allow": True})]:
        for headers, code in [({"Origin": "https://outside.invalid"}, 403),
                              ({"Sec-Fetch-Site": "cross-site"}, 403),
                              ({"Content-Type": "text/plain"}, 415)]:
            assert client.post(route, json=body, headers=headers).status_code == code
    assert client.post("/api/actuation/choice/drive", json=choice,
                       headers={"Host": "outside.invalid"}).status_code == 400
    assert actuation.started == []
    assert client.post("/api/actuation/choice/drive", json={**choice, "unknown": 1}).status_code == 422
    assert client.post("/api/actuation/choice/drive", content="{", headers={
        "Content-Type": "application/json"}).status_code == 422


def test_new_and_compatibility_http_routes_return_monotonic_versions(permission_client, actuation):
    client = permission_client
    state = client.get("/api/actuation/status").json()
    old = state
    for route, body in [
        ("/api/actuation/drive", {"allow": True}),
        ("/api/lab/drive", {"allow": True}),
        ("/api/actuation/choice/drive", {"choice": "controller", "instance": "old", "revision": 0}),
        ("/api/actuation/launcher", {"allow": True}),
        ("/api/lab/shoot", {"allow": True}),
    ]:
        assert client.post(route, json=body).status_code == 200
        after = client.get("/api/actuation/status").json()
        assert after["revision"] > state["revision"]
        assert all(not after[f"lab_{kind}"] or after[kind] for kind in actuation.KINDS)
        state = after
    denied = client.post("/api/actuation/choice/drive", json={
        "choice": "controller_and_lab", "instance": old["instance"], "revision": old["revision"]})
    assert denied.status_code == 409
    assert denied.json()["detail"]["state"]["revision"] == state["revision"]


def test_concurrent_new_and_legacy_http_writes_cannot_create_lab_only(permission_client, actuation):
    from concurrent.futures import ThreadPoolExecutor
    client = permission_client
    for _ in range(8):
        before = actuation.status()
        grant = {"choice": "controller_and_lab", "instance": before["instance"],
                 "revision": before["revision"]}
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(client.post, route, json=body) for route, body in (
                ("/api/actuation/choice/drive", grant),
                ("/api/actuation/drive", {"allow": False}),
                ("/api/lab/drive", {"allow": True}))]
            assert all(future.result().status_code in (200, 409) for future in futures)
        after = actuation.status()
        assert after["revision"] > before["revision"]
        assert not after["lab_drive"] or after["drive"]
    for proc in actuation.started:
        assert all(not line["lab_drive"] or line["drive"] for line in proc.stdin.lines)


def test_stop_all_http_response_includes_the_confirmed_pair_and_version(
        permission_client, actuation, lab, monkeypatch):
    from robot_manager import app
    _choice(actuation, "drive", "controller_and_lab")
    _choice(actuation, "launcher", "controller_and_lab")
    before = actuation.status()
    monkeypatch.setattr(lab, "stop_lesson_motion", lambda: {"ok": True})
    monkeypatch.setattr(app, "_stop_service", lambda: {"ok": True, "state": "inactive",
                                                     "message": "DEMO"})
    response = permission_client.post("/api/stop-all")
    assert response.status_code == 200
    confirmed = response.json()["actuation"]
    assert confirmed["instance"] == before["instance"]
    assert confirmed["revision"] > before["revision"]
    assert confirmed["choices"] == {"drive": "none", "launcher": "none"}
    assert confirmed["lab_drive"] is False and confirmed["lab_launcher"] is False


def test_new_choice_start_failure_reports_unchanged_confirmed_state(actuation, monkeypatch):
    def failed():
        raise HTTPException(503, "DEMO heartbeat unavailable")
    monkeypatch.setattr(actuation, "_start_heartbeat_locked", failed)
    before = actuation.status()
    with pytest.raises(HTTPException) as error:
        _choice(actuation, "drive", "controller_and_lab")
    assert error.value.status_code == 503
    assert error.value.detail["reason"] == "heartbeat_start_failed"
    assert error.value.detail["state"] == before
    assert actuation.started == []
