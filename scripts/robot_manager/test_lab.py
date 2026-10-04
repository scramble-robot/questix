"""Tests for the QUESTiX LAB console (no ROS needed: the bridge command is only built)."""

import getpass
import importlib
import os

import pytest
from fastapi import HTTPException


@pytest.fixture
def lab(tmp_path, monkeypatch):
    monkeypatch.setenv("QUESTIX_CONFIG_DIR", str(tmp_path))
    # QUESTiX LAB exists in lesson mode only (modes.uses_lab); tests of other modes write theirs.
    (tmp_path / "mode").write_text("lesson\n")
    from robot_manager import lab as module
    module = importlib.reload(module)
    # Never ask a bridge that happens to run on this machine, never write to the real ~/.cache.
    monkeypatch.setattr(module, "_bridge_state", lambda: None)
    monkeypatch.setattr(module, "LOG_FILE", tmp_path / "cache" / "lab-bridge.log")
    # The recorder's rosbag.env (OUTPUT_DIR is passed to the bridge): never the machine's own.
    monkeypatch.setattr(module.recorder, "ROSBAG_ENV_FILE", tmp_path / "rosbag.env")
    # The teacher has switched the robot's runtime authority on (操作 tab, actuation.py), which a
    # lesson permission needs; tests of that rule switch it off themselves.
    monkeypatch.setattr(module.actuation, "_authority", {"drive": True, "launcher": True})
    monkeypatch.setattr(module.actuation, "_proc", None)
    return module


def test_command_sources_ros_and_serves_the_managers_lab_dir(lab, tmp_path):
    (tmp_path / "launch.env").write_text('ROBOT_WS="/home/ubuntu/robot_ws"\nROS_DOMAIN_ID=42\n')
    script = lab._build_command({"CAMERA_TOPIC": ""}, {})
    assert 'source "/home/ubuntu/robot_ws/install/setup.bash"' in script
    assert "export ROS_DOMAIN_ID=42; exec ros2 run questix_lab_bridge lab_bridge_node" in script
    assert f'lab_dir:="{lab.LAB_DIR}"' in script and f"port:={lab.LAB_BRIDGE_PORT}" in script
    # An empty camera_topic override would be an rcl parse error.
    assert "camera_topic" not in script


def test_camera_topic_is_passed_only_when_valid(lab, tmp_path):
    script = lab._build_command({"CAMERA_TOPIC": "/image_raw/compressed"}, {})
    assert "-p camera_topic:=/image_raw/compressed" in script
    # Nothing configured: the domain the robot launcher then uses (${ROS_DOMAIN_ID:-42}).
    assert "export ROS_DOMAIN_ID=42; " in script
    with pytest.raises(HTTPException):
        lab._build_command({"CAMERA_TOPIC": "/cam; rm -rf /"}, {})


def test_invalid_workspace_is_rejected(lab, tmp_path):
    (tmp_path / "launch.env").write_text('ROBOT_WS="/home/x; reboot"\n')
    with pytest.raises(HTTPException):
        lab._build_command({"CAMERA_TOPIC": ""}, {})


def test_config_round_trip_and_validation(lab):
    assert lab.set_config(lab.LabConfig(CAMERA_TOPIC=" /cam/compressed ")) == {
        "CAMERA_TOPIC": "/cam/compressed", "AUTOSTART": "true"}
    # Settings only: the actuator permissions are not part of lab.env.
    assert lab._read_config() == {
        "CAMERA_TOPIC": "/cam/compressed", "AUTOSTART": "true", "RECORDS_DIR": ""}
    lab.set_config(lab.LabConfig(AUTOSTART=False))
    assert lab._read_config()["AUTOSTART"] == "false"
    with pytest.raises(ValueError):
        lab.LabConfig(CAMERA_TOPIC="relative/topic")


def test_status_when_idle(lab):
    status = lab.get_status()
    assert status["running"] is False and status["port"] == lab.LAB_BRIDGE_PORT
    assert all(url.endswith(f":{lab.LAB_BRIDGE_PORT}/") for url in status["urls"])


def test_autostart_only_when_enabled(lab, monkeypatch):
    started = []
    monkeypatch.setattr(lab, "start_bridge", lambda: started.append(True))
    monkeypatch.setattr(lab.threading, "Thread", _run_now)
    lab.autostart()
    assert started == [True]  # on by default, without any lab.env
    lab.set_config(lab.LabConfig(AUTOSTART=False))
    lab.autostart()
    assert started == [True]


def test_autostart_is_skipped_in_competition_mode(lab, monkeypatch, tmp_path):
    started = []
    monkeypatch.setattr(lab, "start_bridge", lambda: started.append(True))
    monkeypatch.setattr(lab.threading, "Thread", _run_now)
    (tmp_path / "mode").write_text("competition\n")  # changed by hand: lab.env still says true
    lab.autostart()
    assert started == []


def test_competition_mode_turns_autostart_off_and_stops_the_bridge(lab, monkeypatch, tmp_path):
    signals = []
    # Never signal a real process group from a test.
    monkeypatch.setattr(lab.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(lab.os, "killpg", lambda pgid, sig: signals.append((pgid, sig)))
    lab.set_config(lab.LabConfig(CAMERA_TOPIC="/cam/compressed", AUTOSTART=True))
    lab.set_drive(lab.DriveRequest(allow=True))
    lab.set_shoot(lab.DriveRequest(allow=True))
    lab._proc = _FakeProcess()
    (tmp_path / "mode").write_text("competition\n")  # app.py writes the mode, then calls this
    lab.disable_outside_lessons()
    assert signals == [(_FakeProcess.pid, lab.signal.SIGINT)]
    assert lab._read_config() == {
        "CAMERA_TOPIC": "/cam/compressed", "AUTOSTART": "false", "RECORDS_DIR": ""}
    # Driving and launching from the lessons are switched off with the stream.
    assert lab._runtime_permissions == {"ALLOW_DRIVE": False, "ALLOW_SHOOT": False}
    status = lab.get_status()
    assert status["running"] is False and status["last_stop_reason"] == "competition_mode"
    assert status["drive_allowed"] is False and status["shoot_allowed"] is False
    lab.disable_outside_lessons()  # nothing running, already off: no error


def test_autostart_failure_is_reported(lab, monkeypatch):
    def fail():
        raise HTTPException(status_code=500, detail="ROS missing")
    monkeypatch.setattr(lab, "start_bridge", fail)
    monkeypatch.setattr(lab.threading, "Thread", _run_now)
    lab.set_config(lab.LabConfig(AUTOSTART=True))
    lab.autostart()
    assert lab.get_status()["last_stop_reason"] == "autostart_failed"


class _run_now:
    """Stand-in for threading.Thread that runs the target at start()."""

    def __init__(self, target, **_kwargs):
        self._target = target

    def start(self):
        self._target()


class _FakeProcess:
    """A running bridge process as far as _stop_locked is concerned."""

    pid = 12345

    def poll(self):
        return None

    def wait(self, timeout=None):
        return 0


def test_practice_mode_turns_autostart_back_on_and_starts_the_bridge(lab, monkeypatch):
    started = []
    monkeypatch.setattr(lab, "start_bridge", lambda: started.append(True))
    monkeypatch.setattr(lab.threading, "Thread", _run_now)
    monkeypatch.setattr(lab, "_port_in_use", lambda: False)
    lab.set_config(lab.LabConfig(CAMERA_TOPIC="/cam/compressed", AUTOSTART=False))
    now = lab.enable_for_lessons()
    assert lab._read_config() == {
        "CAMERA_TOPIC": "/cam/compressed", "AUTOSTART": "true", "RECORDS_DIR": ""}
    # Driving and launching stay off: the teacher turns them on, never a mode switch.
    assert now["drive"] is False and now["shoot"] is False
    status = lab.get_status()
    assert status["drive_allowed"] is False and status["shoot_allowed"] is False
    assert started == [True]


def test_practice_mode_leaves_a_running_bridge_alone(lab, monkeypatch):
    started = []
    monkeypatch.setattr(lab, "start_bridge", lambda: started.append(True))
    monkeypatch.setattr(lab.threading, "Thread", _run_now)
    monkeypatch.setattr(lab, "_port_in_use", lambda: True)  # e.g. started by hand
    lab.enable_for_lessons()
    assert started == []
    assert lab.get_status()["last_stop_reason"] is None


def test_mode_switches_call_the_lab_console(lab, monkeypatch, tmp_path):
    from robot_manager import app as app_module
    app_module = importlib.reload(app_module)
    calls = []
    monkeypatch.setattr(app_module.lab, "disable_outside_lessons", lambda: calls.append("off"))
    monkeypatch.setattr(app_module.lab, "enable_for_lessons", lambda: calls.append("on"))
    app_module.set_mode(app_module.ModeRequest(mode="lesson"))
    assert calls == []  # lesson -> lesson: the teacher's own checkbox choice stays
    app_module.set_mode(app_module.ModeRequest(mode="practice"))
    assert calls == ["off"]  # QUESTiX LAB is for lessons only
    assert (tmp_path / "mode").read_text() == "practice\n"
    app_module.set_mode(app_module.ModeRequest(mode="competition"))
    assert calls == ["off", "off"]  # stays off (the lesson choice saved once is kept)
    app_module.set_mode(app_module.ModeRequest(mode="lesson"))
    assert calls == ["off", "off", "on"]


@pytest.mark.parametrize("mode", ["practice", "competition"])
def test_nothing_of_questix_lab_works_outside_lesson_mode(lab, tmp_path, monkeypatch, mode):
    (tmp_path / "mode").write_text(mode + "\n")
    with pytest.raises(HTTPException) as error:
        lab.start_bridge()
    assert error.value.status_code == 409 and "教材モードに切り替えると" in error.value.detail
    for setter in (lab.set_drive, lab.set_shoot):
        with pytest.raises(HTTPException) as error:
            setter(lab.DriveRequest(allow=True))
        assert error.value.status_code == 409
    started = []
    monkeypatch.setattr(lab.threading, "Thread", lambda **kwargs: started.append(kwargs))
    lab.set_config(lab.LabConfig(AUTOSTART=True))
    lab.autostart()  # lab.env may say true when the mode file was changed by hand
    assert started == []
    status = lab.get_status()
    assert status["available"] is False and status["mode"] == mode
    assert status["drive_allowed"] is False and status["shoot_allowed"] is False


def test_practice_mode_stops_the_bridge_with_its_own_reason(lab, monkeypatch, tmp_path):
    monkeypatch.setattr(lab.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(lab.os, "killpg", lambda pgid, sig: None)
    lab._proc = _FakeProcess()
    (tmp_path / "mode").write_text("practice\n")
    lab.disable_outside_lessons()
    assert lab.get_status()["last_stop_reason"] == "not_lesson_mode"


def test_manager_lifespan_starts_and_stops_the_lab_console(lab, monkeypatch):
    # Starlette 1.0 removed app.add_event_handler; the manager must use a lifespan.
    import asyncio
    from robot_manager import app as app_module
    app_module = importlib.reload(app_module)
    calls = []
    monkeypatch.setattr(app_module.lab, "autostart", lambda: calls.append("startup"))
    monkeypatch.setattr(app_module.lab, "shutdown", lambda: calls.append("shutdown"))

    async def run():
        async with app_module.app.router.lifespan_context(app_module.app):
            assert calls == ["startup"]

    asyncio.run(run())
    assert calls == ["startup", "shutdown"]


def test_drive_is_off_at_start_and_only_the_teacher_switches_it_on(lab):
    # No lab.env at all: the pages are served automatically, but nothing moves from them.
    assert lab._read_config()["AUTOSTART"] == "true"
    status = lab.get_status()
    assert status["drive_allowed"] is False and status["shoot_allowed"] is False
    assert status["permissions_transient"] is True
    assert "-p allow_drive:=false -p allow_shoot:=false" in lab._build_command(
        lab._read_config(), lab._permissions())
    status = lab.set_drive(lab.DriveRequest(allow=True))
    assert status["drive_allowed"] is True and status["shoot_allowed"] is False
    assert "-p allow_drive:=true -p allow_shoot:=false" in lab._build_command(
        lab._read_config(), lab._permissions())
    # The settings form does not touch it, and nothing about it is written to lab.env.
    lab.set_config(lab.LabConfig(CAMERA_TOPIC="/cam/compressed"))
    assert lab.get_status()["drive_allowed"] is True
    assert "ALLOW" not in lab.LAB_ENV_FILE.read_text()
    lab.set_drive(lab.DriveRequest(allow=False))
    assert lab.get_status()["drive_allowed"] is False


def test_drive_switch_restarts_our_bridge_and_keeps_the_permission(lab, monkeypatch):
    signals = []
    monkeypatch.setattr(lab.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(lab.os, "killpg", lambda pgid, sig: signals.append((pgid, sig)))
    started = []

    def fake_start():
        # What start_bridge would pass to the new bridge.
        permissions = lab._permissions()
        started.append(permissions["ALLOW_DRIVE"])
        lab._proc = _FakeProcess()
        lab._started_allow_drive = permissions["ALLOW_DRIVE"]
        lab._started_allow_shoot = permissions["ALLOW_SHOOT"]
    monkeypatch.setattr(lab, "start_bridge", fake_start)
    lab._proc = _FakeProcess()
    # The restart that applies the switch is ours: it must not take the permission back.
    status = lab.set_drive(lab.DriveRequest(allow=True))
    assert signals == [(_FakeProcess.pid, lab.signal.SIGINT)]
    assert started == [True]
    assert status["drive_allowed"] is True and status["drive_running"] is True
    assert status["shoot_allowed"] is False
    status = lab.set_drive(lab.DriveRequest(allow=False))
    assert started == [True, False]
    assert status["drive_allowed"] is False and status["drive_running"] is False


def test_drive_cannot_be_allowed_in_competition_mode(lab, tmp_path):
    (tmp_path / "mode").write_text("competition\n")
    with pytest.raises(HTTPException) as error:
        lab.set_drive(lab.DriveRequest(allow=True))
    assert error.value.status_code == 409
    assert lab.get_status()["drive_allowed"] is False
    lab.set_drive(lab.DriveRequest(allow=False))  # forbidding is always possible


def test_invalid_workspace_is_explained_in_japanese(lab, tmp_path):
    (tmp_path / "launch.env").write_text('ROBOT_WS="relative/ws"\n')
    with pytest.raises(HTTPException) as error:
        lab._build_command({"CAMERA_TOPIC": ""}, {})
    assert "ROBOT_WS が不正です" in error.value.detail


class _ExitingPopen:
    """Popen stand-in: prints to the log it was given, then has exited (start fails)."""

    calls = []

    def __init__(self, args, **kwargs):
        _ExitingPopen.calls.append(kwargs)
        stdout = kwargs["stdout"]
        if hasattr(stdout, "write"):
            stdout.write(b"".join(b"line %d\n" % n for n in range(30)))
            stdout.write(b"Package 'questix_lab_bridge' not found\n")
            stdout.flush()
        self.pid = 4242

    def poll(self):
        return 1


def test_bridge_output_goes_to_a_log_whose_tail_the_status_shows(lab, monkeypatch):
    monkeypatch.setattr(lab, "_port_in_use", lambda: False)
    monkeypatch.setattr(lab.subprocess, "Popen", _ExitingPopen)
    monkeypatch.setattr(lab, "_lan_addresses", lambda: [])  # subprocess.run uses Popen too
    lab.LOG_FILE.parent.mkdir(parents=True)
    lab.LOG_FILE.write_text("output of an older run\n")
    with pytest.raises(HTTPException) as error:
        lab.start_bridge()
    assert str(lab.LOG_FILE) in error.value.detail
    assert _ExitingPopen.calls[-1]["stderr"] == lab.subprocess.STDOUT
    status = lab.get_status()
    assert status["last_stop_reason"] == "start_failed"
    tail = status["log_tail"].splitlines()
    # Truncated on start; only the last lines are shown.
    assert "output of an older run" not in lab.LOG_FILE.read_text()
    assert len(tail) == lab.LOG_TAIL_LINES
    assert tail[-1] == "Package 'questix_lab_bridge' not found"


def test_bridge_output_is_discarded_when_the_log_cannot_be_written(lab, monkeypatch, tmp_path):
    monkeypatch.setattr(lab, "_port_in_use", lambda: False)
    monkeypatch.setattr(lab.subprocess, "Popen", _ExitingPopen)
    monkeypatch.setattr(lab, "_lan_addresses", lambda: [])  # subprocess.run uses Popen too
    (tmp_path / "not-a-dir").write_text("")
    monkeypatch.setattr(lab, "LOG_FILE", tmp_path / "not-a-dir" / "lab-bridge.log")
    with pytest.raises(HTTPException):
        lab.start_bridge()
    assert _ExitingPopen.calls[-1]["stdout"] == lab.subprocess.DEVNULL
    assert _ExitingPopen.calls[-1]["stderr"] == lab.subprocess.DEVNULL
    assert lab.get_status()["log_tail"] is None


def test_log_tail_is_left_out_while_our_bridge_runs_fine(lab):
    lab.LOG_FILE.parent.mkdir(parents=True)
    lab.LOG_FILE.write_text("[INFO] serving\n")
    assert lab.get_status()["log_tail"] == "[INFO] serving"
    lab._proc = _FakeProcess()
    assert lab.get_status()["log_tail"] is None


def test_status_carries_the_bridges_own_state(lab, monkeypatch):
    state = {"read_only": False, "clients": 2, "max_clients": 24,
             "drive_state": {"blockers": []}}
    monkeypatch.setattr(lab, "_bridge_state", lambda: state)
    monkeypatch.setattr(lab, "_port_in_use", lambda: True)  # started by hand
    status = lab.get_status()
    assert status["external"] is True and status["bridge"] == state
    assert status["drive_running"] is None
    monkeypatch.setattr(lab, "_port_in_use", lambda: False)
    assert lab.get_status()["bridge"] is None  # nothing to ask
    lab._proc = _FakeProcess()
    assert lab.get_status()["bridge"] == state  # ours


def test_bridge_state_reads_the_bridge_endpoint(lab, monkeypatch):
    import http.server
    import json
    import threading
    from robot_manager import lab as module
    fetch = importlib.reload(module)._bridge_state  # the real function, not the fixture's stub
    replies = {"/api/state": (200, json.dumps({"read_only": True, "clients": 0})),
               "/list": (200, "[1, 2]"), "/broken": (200, "{no json")}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            status, body = replies.get(self.path, (404, "Not found"))
            self.send_response(status)
            self.end_headers()
            self.wfile.write(body.encode())

        def log_message(self, *args):
            pass
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % server.server_address[1]
    try:
        for path, expected in (("/api/state", {"read_only": True, "clients": 0}),
                               ("/list", None), ("/broken", None), ("/old-bridge", None)):
            monkeypatch.setattr(module, "BRIDGE_STATE_URL", base + path)
            assert fetch() == expected
    finally:
        server.shutdown()
        server.server_close()
    monkeypatch.setattr(module, "BRIDGE_STATE_URL", base + "/api/state")
    assert fetch() is None  # nothing listens any more


def _writable_by_root():
    return os.geteuid() == 0


@pytest.fixture
def read_only_config_dir(tmp_path):
    if _writable_by_root():
        pytest.skip("root may write anywhere")
    tmp_path.chmod(0o500)
    yield tmp_path
    tmp_path.chmod(0o700)


@pytest.fixture
def read_only_lab_env(tmp_path):
    """lab.env (content written by the test first) that the manager cannot write."""
    if _writable_by_root():
        pytest.skip("root may write anywhere")
    path = tmp_path / "lab.env"

    def lock(text):
        path.write_text(text)
        path.chmod(0o400)
    yield lock
    if path.exists():
        path.chmod(0o600)


def test_permission_error_names_the_user_the_owner_and_the_fix(lab, read_only_config_dir):
    user = getpass.getuser()
    with pytest.raises(HTTPException) as error:
        lab.set_config(lab.LabConfig())
    detail = error.value.detail
    assert error.value.status_code == 403
    assert f"ユーザー {user}" in detail
    assert detail.endswith(f"sudo chown {user}:{user} {read_only_config_dir}")


def test_permission_error_includes_an_existing_lab_env(lab, tmp_path, read_only_lab_env):
    read_only_lab_env('AUTOSTART="true"\n')
    with pytest.raises(HTTPException) as error:
        lab.set_config(lab.LabConfig())
    assert error.value.detail.endswith(f"{tmp_path} {tmp_path / 'lab.env'}")
    assert "lab.env の所有者は" in error.value.detail


def test_competition_stops_the_bridge_even_if_lab_env_cannot_be_written(
        lab, monkeypatch, tmp_path, read_only_lab_env):
    signals = []
    monkeypatch.setattr(lab.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(lab.os, "killpg", lambda pgid, sig: signals.append((pgid, sig)))
    read_only_lab_env('AUTOSTART="true"\nALLOW_DRIVE="true"\n')
    lab.set_drive(lab.DriveRequest(allow=True))  # the session's permission, not in lab.env
    lab._proc = _FakeProcess()
    (tmp_path / "mode").write_text("competition\n")  # app.py writes the mode, then calls this
    lab.disable_outside_lessons()  # logged, not raised
    assert signals == [(_FakeProcess.pid, lab.signal.SIGINT)]
    status = lab.get_status()
    assert status["running"] is False and status["last_stop_reason"] == "competition_mode"
    # AUTOSTART could not be written, but the permissions are off whatever lab.env says.
    assert status["drive_allowed"] is False and "sudo chown" in status["config_error"]
    assert "-p allow_drive:=false -p allow_shoot:=false" in lab._build_command(
        lab._read_config(), lab._permissions())


def test_a_new_manager_never_restores_permissions_from_a_legacy_lab_env(lab, monkeypatch, tmp_path):
    # lab.env written by an older manager, with everything allowed.
    (tmp_path / "lab.env").write_text(
        'AUTOSTART="true"\nALLOW_DRIVE="true"\nALLOW_SHOOT="true"\n'
        'PRACTICE_ALLOW_DRIVE="true"\nPRACTICE_ALLOW_SHOOT="true"\n')
    fresh = importlib.reload(lab)  # a new robot_manager process (boot or restart)
    seen = []
    monkeypatch.setattr(fresh, "start_bridge",
                        lambda: seen.append(fresh._build_command(fresh._read_config(),
                                                                 fresh._permissions())))
    monkeypatch.setattr(fresh.threading, "Thread", _run_now)
    fresh.autostart()  # the pages are still served automatically
    assert len(seen) == 1 and "-p allow_drive:=false -p allow_shoot:=false" in seen[0]
    status = fresh.get_status()
    assert status["drive_allowed"] is False and status["shoot_allowed"] is False
    assert "ALLOW_DRIVE" not in fresh._read_config()


def test_allowing_never_writes_lab_env(lab, tmp_path, read_only_lab_env):
    read_only_lab_env('AUTOSTART="true"\n')
    status = lab.set_drive(lab.DriveRequest(allow=True))  # a read-only lab.env does not matter
    assert status["drive_allowed"] is True and status["config_error"] is None
    assert (tmp_path / "lab.env").read_text() == 'AUTOSTART="true"\n'


def test_forbidding_restarts_the_bridge_even_if_lab_env_cannot_be_written(
        lab, monkeypatch, tmp_path, read_only_lab_env):
    monkeypatch.setattr(lab.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(lab.os, "killpg", lambda pgid, sig: None)
    started = []

    def fake_start():
        started.append(lab._build_command(lab._read_config(), lab._permissions()))
        lab._proc = _FakeProcess()
    monkeypatch.setattr(lab, "start_bridge", fake_start)
    read_only_lab_env('ALLOW_DRIVE="true"\n')
    lab.set_drive(lab.DriveRequest(allow=True))
    lab._proc = _FakeProcess()
    status = lab.set_drive(lab.DriveRequest(allow=False))
    assert len(started) == 1 and "-p allow_drive:=false" in started[0]
    assert status["drive_allowed"] is False and status["config_error"] is None


def test_bridge_lists_the_recorders_rosbags(lab, tmp_path):
    # Without rosbag.env: the recorder's default folder.
    script = lab._build_command({"CAMERA_TOPIC": ""}, {})
    assert '-p rosbag_dir:="/var/lib/questix/rosbags"' in script
    (tmp_path / "rosbag.env").write_text("OUTPUT_DIR=/data/bags\n")
    assert '-p rosbag_dir:="/data/bags"' in lab._build_command({"CAMERA_TOPIC": ""}, {})
    # A path the shell could misread is not passed on (the bridge keeps its default).
    (tmp_path / "rosbag.env").write_text("OUTPUT_DIR=/data/$(reboot)\n")
    assert "rosbag_dir" not in lab._build_command({"CAMERA_TOPIC": ""}, {})


def test_records_dir_is_the_bridges_default_unless_set(lab, tmp_path):
    assert "records_dir" not in lab._build_command(lab._read_config(), {})
    (tmp_path / "lab.env").write_text('RECORDS_DIR="/srv/questix/lab-records"\n')
    config = lab._read_config()
    assert config["RECORDS_DIR"] == "/srv/questix/lab-records"
    assert '-p records_dir:="/srv/questix/lab-records"' in lab._build_command(config, {})
    # The settings form keeps it.
    lab.set_config(lab.LabConfig(CAMERA_TOPIC="", AUTOSTART=True))
    assert lab._read_config()["RECORDS_DIR"] == "/srv/questix/lab-records"
    with pytest.raises(HTTPException) as error:
        lab._build_command({"RECORDS_DIR": "relative; reboot"}, {})
    assert "RECORDS_DIR" in error.value.detail


def test_status_passes_the_bridges_records_summary_on(lab, monkeypatch):
    records = {"dir": "/home/ubuntu/.local/share/questix/lab-records", "count": 3,
               "used_bytes": 1234567, "limit_bytes": 524288000, "save": True,
               "auto_record": True, "rosbag_dir": "/var/lib/questix/rosbags"}
    state = {"read_only": True, "clients": 0, "max_clients": 24, "records": records}
    monkeypatch.setattr(lab, "_bridge_state", lambda: state)
    lab._proc = _FakeProcess()
    assert lab.get_status()["bridge"]["records"] == records


def test_both_permissions_are_always_passed_explicitly(lab):
    # A permission of this session must never fall back to lab_bridge.yaml's defaults.
    script = lab._build_command({}, {"ALLOW_DRIVE": True, "ALLOW_SHOOT": True})
    assert "-p allow_drive:=true -p allow_shoot:=true" in script
    # Only True is on: strings from a file or anything else never are.
    script = lab._build_command({}, {"ALLOW_DRIVE": "true", "ALLOW_SHOOT": 1})
    assert "-p allow_drive:=false -p allow_shoot:=false" in script
    assert "-p allow_drive:=false -p allow_shoot:=false" in lab._build_command({}, {})
    # lab.env settings named like the permissions do not reach the bridge either.
    script = lab._build_command({"ALLOW_DRIVE": "true", "ALLOW_SHOOT": "true"}, {})
    assert "-p allow_drive:=false -p allow_shoot:=false" in script


def test_shoot_is_off_at_start_and_only_the_teacher_switches_it_on(lab):
    status = lab.get_status()
    assert status["shoot_allowed"] is False and status["shoot_running"] is None
    status = lab.set_shoot(lab.DriveRequest(allow=True))
    assert status["shoot_allowed"] is True and status["drive_allowed"] is False
    assert "-p allow_drive:=false -p allow_shoot:=true" in lab._build_command(
        lab._read_config(), lab._permissions())
    lab.set_config(lab.LabConfig(CAMERA_TOPIC="/cam/compressed"))  # the form keeps it
    assert lab.get_status()["shoot_allowed"] is True
    assert "ALLOW" not in lab.LAB_ENV_FILE.read_text()


def test_shoot_switch_restarts_our_bridge_and_keeps_the_permission(lab, monkeypatch):
    signals = []
    monkeypatch.setattr(lab.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(lab.os, "killpg", lambda pgid, sig: signals.append((pgid, sig)))
    started = []

    def fake_start():
        permissions = lab._permissions()
        started.append(permissions["ALLOW_SHOOT"])
        lab._proc = _FakeProcess()
        lab._started_allow_drive = permissions["ALLOW_DRIVE"]
        lab._started_allow_shoot = permissions["ALLOW_SHOOT"]
    monkeypatch.setattr(lab, "start_bridge", fake_start)
    lab._proc = _FakeProcess()
    status = lab.set_shoot(lab.DriveRequest(allow=True))
    assert signals == [(_FakeProcess.pid, lab.signal.SIGINT)]
    assert started == [True]
    assert status["shoot_allowed"] is True and status["shoot_running"] is True
    assert status["drive_allowed"] is False  # the other switch is untouched
    status = lab.set_shoot(lab.DriveRequest(allow=False))
    assert started == [True, False]
    assert status["shoot_allowed"] is False and status["shoot_running"] is False


def test_shoot_cannot_be_allowed_in_competition_mode(lab, tmp_path):
    (tmp_path / "mode").write_text("competition\n")
    with pytest.raises(HTTPException) as error:
        lab.set_shoot(lab.DriveRequest(allow=True))
    assert error.value.status_code == 409 and "発射" in error.value.detail
    assert lab.get_status()["shoot_allowed"] is False
    lab.set_shoot(lab.DriveRequest(allow=False))  # forbidding is always possible


def test_competition_round_trip_drops_legacy_keys_and_keeps_the_settings(lab, monkeypatch, tmp_path):
    monkeypatch.setattr(lab, "start_bridge", lambda: None)
    monkeypatch.setattr(lab.threading, "Thread", _run_now)
    monkeypatch.setattr(lab, "_port_in_use", lambda: False)
    # AUTOSTART already off, and lab.env of an older manager still allows everything.
    (tmp_path / "lab.env").write_text(
        'CAMERA_TOPIC="/cam/compressed"\nAUTOSTART="false"\nALLOW_DRIVE="true"\n'
        'ALLOW_SHOOT="true"\nRECORDS_DIR="/srv/lab"\n')
    lab.disable_outside_lessons()
    text = (tmp_path / "lab.env").read_text()
    assert "ALLOW_" not in text  # written anyway, to drop them
    lab.enable_for_lessons()
    text = (tmp_path / "lab.env").read_text()
    assert "ALLOW_" not in text
    assert lab._read_config() == {
        "CAMERA_TOPIC": "/cam/compressed", "AUTOSTART": "false", "RECORDS_DIR": "/srv/lab"}
    status = lab.get_status()
    assert status["drive_allowed"] is False and status["shoot_allowed"] is False


def test_forbidding_shoot_works_even_if_lab_env_cannot_be_written(
        lab, monkeypatch, read_only_lab_env):
    monkeypatch.setattr(lab.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(lab.os, "killpg", lambda pgid, sig: None)
    started = []

    def fake_start():
        started.append(lab._build_command(lab._read_config(), lab._permissions()))
        lab._proc = _FakeProcess()
    monkeypatch.setattr(lab, "start_bridge", fake_start)
    read_only_lab_env('ALLOW_DRIVE="true"\nALLOW_SHOOT="true"\n')
    lab.set_drive(lab.DriveRequest(allow=True))
    lab.set_shoot(lab.DriveRequest(allow=True))
    lab._proc = _FakeProcess()
    status = lab.set_shoot(lab.DriveRequest(allow=False))
    assert len(started) == 1 and "-p allow_drive:=true -p allow_shoot:=false" in started[0]
    assert status["shoot_allowed"] is False and status["drive_allowed"] is True
    assert status["config_error"] is None


# --- the teacher's choices across leaving lesson mode ------------------------------------------------

def test_an_allow_never_survives_a_competition_round_trip(lab, monkeypatch, tmp_path):
    started = []
    monkeypatch.setattr(lab, "start_bridge", lambda: started.append(True))
    monkeypatch.setattr(lab.threading, "Thread", _run_now)
    monkeypatch.setattr(lab, "_port_in_use", lambda: False)
    lab.set_drive(lab.DriveRequest(allow=True))
    lab.set_shoot(lab.DriveRequest(allow=True))
    (tmp_path / "mode").write_text("competition\n")
    lab.disable_outside_lessons()
    lab.disable_outside_lessons()  # competition -> competition keeps the lesson AUTOSTART
    assert lab._runtime_permissions == {"ALLOW_DRIVE": False, "ALLOW_SHOOT": False}
    (tmp_path / "mode").write_text("lesson\n")
    now = lab.enable_for_lessons()
    assert now == {"restored": True, "autostart": True, "drive": False, "shoot": False}
    status = lab.get_status()
    assert status["drive_allowed"] is False and status["shoot_allowed"] is False
    assert started == [True]
    assert "PRACTICE_" not in (tmp_path / "lab.env").read_text()  # cleared after restoring


def test_autostart_off_survives_a_competition_round_trip(lab, monkeypatch, tmp_path):
    started = []
    monkeypatch.setattr(lab, "start_bridge", lambda: started.append(True))
    monkeypatch.setattr(lab.threading, "Thread", _run_now)
    monkeypatch.setattr(lab, "_port_in_use", lambda: False)
    lab.set_config(lab.LabConfig(AUTOSTART=False))
    (tmp_path / "mode").write_text("competition\n")
    lab.disable_outside_lessons()
    lab.set_config(lab.LabConfig(CAMERA_TOPIC="/cam/compressed"))  # keeps the saved values
    (tmp_path / "mode").write_text("lesson\n")
    assert lab.enable_for_lessons()["autostart"] is False
    assert lab._read_config()["AUTOSTART"] == "false" and started == []


def test_bridge_does_not_start_in_competition_mode(lab, tmp_path):
    (tmp_path / "mode").write_text("competition\n")
    with pytest.raises(HTTPException) as error:
        lab.start_bridge()
    assert error.value.status_code == 409 and "大会モード" in error.value.detail
    assert lab.get_status()["competition"] is True


# --- 「すべて止める」 -------------------------------------------------------------------------------

class _FakeBridgeSocket:
    """A WebSocket server on 127.0.0.1 that records the text frames a client sends."""

    def __init__(self, refuse=False):
        import socket
        import threading
        self.texts = []
        self.refuse = refuse
        self.server = socket.socket()
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(1)
        self.port = self.server.getsockname()[1]
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        import base64
        import hashlib
        conn, _ = self.server.accept()
        with conn:
            data = b""
            while b"\r\n\r\n" not in data:
                data += conn.recv(4096)
            head, data = data.split(b"\r\n\r\n", 1)
            if self.refuse:
                conn.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                return
            key = [line.split(b":", 1)[1].strip() for line in head.split(b"\r\n")
                   if line.lower().startswith(b"sec-websocket-key")][0]
            accept = base64.b64encode(hashlib.sha1(
                key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
            conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                         b"Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n"
                         b"\x81\x05hello")  # a server frame the client must just skip
            while True:
                while len(data) < 2:
                    data += conn.recv(4096)
                opcode, length = data[0] & 0x0F, data[1] & 0x7F
                assert data[1] & 0x80  # clients mask every frame
                offset = 2
                if length == 126:
                    while len(data) < 4:
                        data += conn.recv(4096)
                    length, offset = int.from_bytes(data[2:4], "big"), 4
                while len(data) < offset + 4 + length:
                    data += conn.recv(4096)
                mask = data[offset:offset + 4]
                payload = bytes(b ^ mask[i % 4] for i, b in
                                enumerate(data[offset + 4:offset + 4 + length]))
                data = data[offset + 4 + length:]
                if opcode == 0x8:
                    conn.sendall(b"\x88\x02\x03\xe8")
                    return
                self.texts.append(payload.decode("utf-8"))


def test_ws_client_sends_text_frames_and_closes(lab):
    server = _FakeBridgeSocket()
    long_text = '{"type":"stop","pad":"' + "x" * 200 + '"}'  # 16-bit length
    lab._ws_send_texts(server.port, ['{"type":"stop"}', long_text])
    server.thread.join(2)
    assert server.texts == ['{"type":"stop"}', long_text]


def test_ws_client_reports_a_refused_upgrade(lab):
    server = _FakeBridgeSocket(refuse=True)
    with pytest.raises(OSError, match="refused"):
        lab._ws_send_texts(server.port, ['{"type":"stop"}'])


def test_stop_lesson_motion_sends_stop_and_roller_stop(lab, monkeypatch):
    sent = []
    states = [
        {"drive_state": {"active": True}, "shoot_state": {"active": False}},  # before
        {"drive_state": {"active": False}, "shoot_state": {"active": False}},  # after
    ]
    monkeypatch.setattr(lab, "_port_in_use", lambda: True)
    monkeypatch.setattr(lab, "_bridge_state", lambda: states.pop(0) if states else None)
    monkeypatch.setattr(lab, "_ws_send_texts", lambda port, texts: sent.append((port, texts)))
    answer = lab.stop_lesson_motion()
    assert sent == [(lab.LAB_BRIDGE_PORT, ['{"type":"stop"}', '{"type":"roller_stop"}'])]
    assert answer["ok"] is True and answer["message"] == "教材の走行・発射を止めました"


def test_stop_lesson_motion_without_a_bridge_or_with_a_broken_one(lab, monkeypatch):
    monkeypatch.setattr(lab, "_port_in_use", lambda: False)
    assert lab.stop_lesson_motion()["ok"] is True
    monkeypatch.setattr(lab, "_port_in_use", lambda: True)

    def fail(port, texts):
        raise OSError("the bridge refused the WebSocket: HTTP/1.1 503")
    monkeypatch.setattr(lab, "_ws_send_texts", fail)
    answer = lab.stop_lesson_motion()
    assert answer["ok"] is False and "503" in answer["message"]


def test_stop_lesson_motion_reports_a_run_that_did_not_end(lab, monkeypatch):
    monkeypatch.setattr(lab, "STOP_CONFIRM_SEC", 0.2)
    monkeypatch.setattr(lab, "_port_in_use", lambda: True)
    monkeypatch.setattr(lab, "_bridge_state", lambda: {
        "drive_state": {"active": False}, "shoot_state": {"active": True}})
    monkeypatch.setattr(lab, "_ws_send_texts", lambda port, texts: None)
    answer = lab.stop_lesson_motion()
    assert answer["ok"] is False and answer["shoot_active"] is True


# --- the actuator permissions belong to one session of the manager -------------------------------

class _ExitedProcess(_FakeProcess):
    """A bridge process of ours that has exited on its own."""

    def poll(self):
        return 1


def test_explicit_stop_switches_both_permissions_off(lab, monkeypatch):
    monkeypatch.setattr(lab.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(lab.os, "killpg", lambda pgid, sig: None)
    lab.set_drive(lab.DriveRequest(allow=True))
    lab.set_shoot(lab.DriveRequest(allow=True))
    lab._proc = _FakeProcess()
    status = lab.stop_bridge()
    assert status["last_stop_reason"] == "stopped"
    assert status["drive_allowed"] is False and status["shoot_allowed"] is False
    # The next 配信開始 starts without them.
    assert "-p allow_drive:=false -p allow_shoot:=false" in lab._build_command(
        lab._read_config(), lab._permissions())
    # 配信停止 with nothing running still ends the permissions.
    lab.set_drive(lab.DriveRequest(allow=True))
    with pytest.raises(HTTPException):
        lab.stop_bridge()
    assert lab.get_status()["drive_allowed"] is False


def test_revoke_restarts_a_bridge_that_had_a_permission_on(lab, monkeypatch):
    signals = []
    monkeypatch.setattr(lab.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(lab.os, "killpg", lambda pgid, sig: signals.append((pgid, sig)))
    started = []

    def fake_start():
        started.append(lab._build_command(lab._read_config(), lab._permissions()))
        lab._proc = _FakeProcess()
        lab._started_allow_drive = lab._started_allow_shoot = False
    monkeypatch.setattr(lab, "start_bridge", fake_start)
    lab.set_drive(lab.DriveRequest(allow=True))
    lab._proc = _FakeProcess()
    lab._started_allow_drive = True
    answer = lab.revoke_permissions("stop_all")
    assert answer["ok"] is True and answer["revoked"] is True and answer["restarted"] is True
    assert signals == [(_FakeProcess.pid, lab.signal.SIGINT)]
    assert len(started) == 1 and "-p allow_drive:=false -p allow_shoot:=false" in started[0]
    status = lab.get_status()
    assert status["drive_allowed"] is False and status["drive_running"] is False
    # A bridge already without permissions is left alone (the pages stay connected).
    answer = lab.revoke_permissions("stop_all")
    assert answer["revoked"] is False and answer["restarted"] is False
    assert len(started) == 1


def test_stop_all_switches_both_permissions_off(lab, monkeypatch):
    from robot_manager import app as app_module
    app_module = importlib.reload(app_module)
    calls = []
    monkeypatch.setattr(app_module.lab, "stop_lesson_motion",
                        lambda: calls.append("lesson") or {"ok": True, "message": "止めました"})
    monkeypatch.setattr(app_module, "_stop_service",
                        lambda: calls.append("service") or {"ok": True, "state": "inactive",
                                                            "message": "止めました"})
    app_module.lab.set_drive(app_module.lab.DriveRequest(allow=True))
    app_module.lab.set_shoot(app_module.lab.DriveRequest(allow=True))
    answer = app_module.stop_all()
    assert calls == ["lesson", "service"]
    # The teacher's runtime authority goes off first and takes both lesson permissions with it.
    assert answer["ok"] is True and answer["actuation"]["revoked"] == ["drive", "launcher"]
    assert answer["actuation"]["drive"] is False and answer["actuation"]["launcher"] is False
    status = app_module.lab.get_status()
    assert status["drive_allowed"] is False and status["shoot_allowed"] is False


def test_a_bridge_that_exits_on_its_own_takes_the_permissions_with_it(lab):
    lab.set_drive(lab.DriveRequest(allow=True))
    lab.set_shoot(lab.DriveRequest(allow=True))
    lab._proc = _ExitedProcess()
    status = lab.get_status()
    assert status["running"] is False and status["last_stop_reason"] == "exited"
    assert status["drive_allowed"] is False and status["shoot_allowed"] is False


def test_a_start_after_an_unnoticed_exit_starts_without_permissions(lab, monkeypatch):
    seen = []

    class _Popen:
        pid = 777

        def __init__(self, args, **_kwargs):
            seen.append(args[-1])

        def poll(self):
            return None
    monkeypatch.setattr(lab.subprocess, "Popen", _Popen)
    monkeypatch.setattr(lab, "_port_in_use", lambda: False)
    monkeypatch.setattr(lab, "_lan_addresses", lambda: [])
    monkeypatch.setattr(lab, "START_GRACE_SEC", 0)
    (lab.LAB_DIR / "index.html").is_file() or pytest.skip("teaching pages not in this tree")
    lab.set_drive(lab.DriveRequest(allow=True))
    lab._proc = _ExitedProcess()  # exited, and no status poll has noticed yet
    status = lab.start_bridge()
    assert len(seen) == 1 and "-p allow_drive:=false -p allow_shoot:=false" in seen[0]
    assert status["drive_allowed"] is False and status["drive_running"] is False


def test_a_switch_after_an_unnoticed_exit_keeps_the_teachers_new_choice(lab):
    lab.set_shoot(lab.DriveRequest(allow=True))
    lab._proc = _ExitedProcess()  # exited before the teacher switches driving on
    status = lab.set_drive(lab.DriveRequest(allow=True))
    assert status["last_stop_reason"] == "exited" and status["running"] is False
    # The exit took the older permission; the one switched on afterwards holds.
    assert status["drive_allowed"] is True and status["shoot_allowed"] is False


def test_a_failed_restart_for_a_switch_takes_the_permissions_back(lab, monkeypatch):
    monkeypatch.setattr(lab.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(lab.os, "killpg", lambda pgid, sig: None)

    def fail():
        raise HTTPException(status_code=500, detail="ROS missing")
    monkeypatch.setattr(lab, "start_bridge", fail)
    lab._proc = _FakeProcess()
    with pytest.raises(HTTPException):
        lab.set_drive(lab.DriveRequest(allow=True))
    assert lab.get_status()["drive_allowed"] is False


def test_a_config_write_drops_legacy_keys_and_keeps_the_settings(lab, tmp_path):
    (tmp_path / "lab.env").write_text(
        'CAMERA_TOPIC="/cam/compressed"\nAUTOSTART="true"\nALLOW_DRIVE="true"\n'
        'ALLOW_SHOOT="true"\nRECORDS_DIR="/srv/lab"\nPRACTICE_AUTOSTART="false"\n'
        'PRACTICE_ALLOW_DRIVE="true"\nPRACTICE_ALLOW_SHOOT="true"\n')
    lab.set_config(lab.LabConfig(CAMERA_TOPIC="/cam/compressed", AUTOSTART=True))
    text = (tmp_path / "lab.env").read_text()
    for key in lab.LEGACY_PERMISSION_KEYS:
        assert f"{key}=" not in text
    assert 'RECORDS_DIR="/srv/lab"' in text and 'PRACTICE_AUTOSTART="false"' in text
    assert lab._read_config() == {
        "CAMERA_TOPIC": "/cam/compressed", "AUTOSTART": "true", "RECORDS_DIR": "/srv/lab"}
    fresh = importlib.reload(lab)  # the next manager process
    status = fresh.get_status()
    assert status["drive_allowed"] is False and status["shoot_allowed"] is False


def test_manager_shutdown_ends_the_permissions(lab):
    lab.set_drive(lab.DriveRequest(allow=True))
    lab.shutdown()
    assert lab._runtime_permissions == {"ALLOW_DRIVE": False, "ALLOW_SHOOT": False}
