"""Tests for the QUESTiX LAB console (no ROS needed: the bridge command is only built)."""

import getpass
import importlib
import os

import pytest
from fastapi import HTTPException


@pytest.fixture
def lab(tmp_path, monkeypatch):
    monkeypatch.setenv("QUESTIX_CONFIG_DIR", str(tmp_path))
    from robot_manager import lab as module
    module = importlib.reload(module)
    # Never ask a bridge that happens to run on this machine, never write to the real ~/.cache.
    monkeypatch.setattr(module, "_bridge_state", lambda: None)
    monkeypatch.setattr(module, "LOG_FILE", tmp_path / "cache" / "lab-bridge.log")
    # The recorder's rosbag.env (OUTPUT_DIR is passed to the bridge): never the machine's own.
    monkeypatch.setattr(module.recorder, "ROSBAG_ENV_FILE", tmp_path / "rosbag.env")
    return module


def test_command_sources_ros_and_serves_the_managers_lab_dir(lab, tmp_path):
    (tmp_path / "launch.env").write_text('ROBOT_WS="/home/ubuntu/robot_ws"\nROS_DOMAIN_ID=42\n')
    script = lab._build_command({"CAMERA_TOPIC": ""})
    assert 'source "/home/ubuntu/robot_ws/install/setup.bash"' in script
    assert "export ROS_DOMAIN_ID=42; exec ros2 run questix_lab_bridge lab_bridge_node" in script
    assert f'lab_dir:="{lab.LAB_DIR}"' in script and f"port:={lab.LAB_BRIDGE_PORT}" in script
    # An empty camera_topic override would be an rcl parse error.
    assert "camera_topic" not in script


def test_camera_topic_is_passed_only_when_valid(lab, tmp_path):
    script = lab._build_command({"CAMERA_TOPIC": "/image_raw/compressed"})
    assert "-p camera_topic:=/image_raw/compressed" in script
    assert "ROS_DOMAIN_ID" not in script  # nothing configured -> keep the shell's own value
    with pytest.raises(HTTPException):
        lab._build_command({"CAMERA_TOPIC": "/cam; rm -rf /"})


def test_invalid_workspace_is_rejected(lab, tmp_path):
    (tmp_path / "launch.env").write_text('ROBOT_WS="/home/x; reboot"\n')
    with pytest.raises(HTTPException):
        lab._build_command({"CAMERA_TOPIC": ""})


def test_config_round_trip_and_validation(lab):
    assert lab.set_config(lab.LabConfig(CAMERA_TOPIC=" /cam/compressed ")) == {
        "CAMERA_TOPIC": "/cam/compressed", "AUTOSTART": "true"}
    assert lab._read_config() == {
        "CAMERA_TOPIC": "/cam/compressed", "AUTOSTART": "true", "ALLOW_DRIVE": "true",
        "RECORDS_DIR": ""}
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


def test_competition_mode_turns_autostart_off_and_stops_the_bridge(lab, monkeypatch):
    signals = []
    # Never signal a real process group from a test.
    monkeypatch.setattr(lab.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(lab.os, "killpg", lambda pgid, sig: signals.append((pgid, sig)))
    lab.set_config(lab.LabConfig(CAMERA_TOPIC="/cam/compressed", AUTOSTART=True))
    lab.set_drive(lab.DriveRequest(allow=True))
    lab._proc = _FakeProcess()
    lab.disable_for_competition()
    assert signals == [(_FakeProcess.pid, lab.signal.SIGINT)]
    # Driving from the lessons is switched off with the stream.
    assert lab._read_config() == {
        "CAMERA_TOPIC": "/cam/compressed", "AUTOSTART": "false", "ALLOW_DRIVE": "false",
        "RECORDS_DIR": ""}
    status = lab.get_status()
    assert status["running"] is False and status["last_stop_reason"] == "competition_mode"
    lab.disable_for_competition()  # nothing running, already off: no error


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
    lab.enable_for_practice()
    # Driving stays off: it is turned on deliberately, never by a mode switch.
    assert lab._read_config() == {
        "CAMERA_TOPIC": "/cam/compressed", "AUTOSTART": "true", "ALLOW_DRIVE": "true",
        "RECORDS_DIR": ""}
    assert started == [True]


def test_practice_mode_leaves_a_running_bridge_alone(lab, monkeypatch):
    started = []
    monkeypatch.setattr(lab, "start_bridge", lambda: started.append(True))
    monkeypatch.setattr(lab.threading, "Thread", _run_now)
    monkeypatch.setattr(lab, "_port_in_use", lambda: True)  # e.g. started by hand
    lab.enable_for_practice()
    assert started == []
    assert lab.get_status()["last_stop_reason"] is None


def test_mode_switches_call_the_lab_console(lab, monkeypatch, tmp_path):
    from robot_manager import app as app_module
    app_module = importlib.reload(app_module)
    calls = []
    monkeypatch.setattr(app_module.lab, "disable_for_competition", lambda: calls.append("off"))
    monkeypatch.setattr(app_module.lab, "enable_for_practice", lambda: calls.append("on"))
    app_module.set_mode(app_module.ModeRequest(mode="practice"))
    assert calls == []  # practice -> practice: the learner's own checkbox choice stays
    app_module.set_mode(app_module.ModeRequest(mode="competition"))
    assert calls == ["off"]
    assert (tmp_path / "mode").read_text() == "competition\n"
    app_module.set_mode(app_module.ModeRequest(mode="practice"))
    assert calls == ["off", "on"]


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


def test_drive_is_on_by_default_and_the_teacher_can_switch_it_off(lab):
    # Each run is confirmed by the learner on the page; the switch is the teacher's off switch.
    assert lab.get_status()["drive_allowed"] is True
    assert "-p allow_drive:=true" in lab._build_command(lab._read_config())
    lab.set_drive(lab.DriveRequest(allow=False))
    assert "allow_drive" not in lab._build_command(lab._read_config())
    lab.set_drive(lab.DriveRequest(allow=True))
    # The settings form does not touch it.
    lab.set_config(lab.LabConfig(CAMERA_TOPIC="/cam/compressed"))
    assert lab._read_config()["ALLOW_DRIVE"] == "true"


def test_drive_switch_restarts_our_bridge_so_it_applies_at_once(lab, monkeypatch):
    signals = []
    monkeypatch.setattr(lab.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(lab.os, "killpg", lambda pgid, sig: signals.append((pgid, sig)))
    started = []

    def fake_start():
        started.append(lab._read_config()["ALLOW_DRIVE"])
        lab._proc = _FakeProcess()
        lab._started_allow_drive = lab._read_config()["ALLOW_DRIVE"] == "true"
    monkeypatch.setattr(lab, "start_bridge", fake_start)
    lab.set_drive(lab.DriveRequest(allow=True))
    assert started == []  # not running: only the setting changes
    lab._proc = _FakeProcess()
    status = lab.set_drive(lab.DriveRequest(allow=False))
    assert signals == [(_FakeProcess.pid, lab.signal.SIGINT)]
    assert started == ["false"]
    assert status["drive_allowed"] is False and status["drive_running"] is False


def test_drive_cannot_be_allowed_in_competition_mode(lab, tmp_path):
    (tmp_path / "mode").write_text("competition\n")
    with pytest.raises(HTTPException) as error:
        lab.set_drive(lab.DriveRequest(allow=True))
    assert error.value.status_code == 409
    assert lab._read_config()["ALLOW_DRIVE"] == "false"
    lab.set_drive(lab.DriveRequest(allow=False))  # forbidding is always possible


def test_invalid_workspace_is_explained_in_japanese(lab, tmp_path):
    (tmp_path / "launch.env").write_text('ROBOT_WS="relative/ws"\n')
    with pytest.raises(HTTPException) as error:
        lab._build_command({"CAMERA_TOPIC": ""})
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
        lab, monkeypatch, read_only_lab_env):
    signals = []
    monkeypatch.setattr(lab.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(lab.os, "killpg", lambda pgid, sig: signals.append((pgid, sig)))
    read_only_lab_env('AUTOSTART="true"\nALLOW_DRIVE="true"\n')
    lab._proc = _FakeProcess()
    lab.disable_for_competition()  # logged, not raised
    assert signals == [(_FakeProcess.pid, lab.signal.SIGINT)]
    status = lab.get_status()
    assert status["running"] is False and status["last_stop_reason"] == "competition_mode"
    # lab.env still says true, but driving counts as off until it can be written.
    assert status["drive_allowed"] is False and "sudo chown" in status["config_error"]
    assert "allow_drive" not in lab._build_command(lab._read_config())


def test_manager_start_keeps_the_teachers_choice(lab, monkeypatch, tmp_path):
    seen = []
    monkeypatch.setattr(lab, "start_bridge", lambda: seen.append(lab._read_config()))
    monkeypatch.setattr(lab.threading, "Thread", _run_now)
    (tmp_path / "lab.env").write_text('AUTOSTART="true"\nALLOW_DRIVE="false"\n')
    lab.autostart()
    assert seen[0]["ALLOW_DRIVE"] == "false"


def test_allowing_again_needs_a_writable_lab_env(lab, tmp_path, read_only_lab_env):
    read_only_lab_env('ALLOW_DRIVE="false"\n')
    with pytest.raises(HTTPException) as error:
        lab.set_drive(lab.DriveRequest(allow=True))
    assert "sudo chown" in error.value.detail
    (tmp_path / "lab.env").chmod(0o600)
    lab.set_drive(lab.DriveRequest(allow=True))
    status = lab.get_status()
    assert status["drive_allowed"] is True and status["config_error"] is None


def test_forbidding_restarts_the_bridge_even_if_lab_env_cannot_be_written(
        lab, monkeypatch, tmp_path, read_only_lab_env):
    monkeypatch.setattr(lab.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(lab.os, "killpg", lambda pgid, sig: None)
    started = []

    def fake_start():
        started.append(lab._build_command(lab._read_config()))
        lab._proc = _FakeProcess()
    monkeypatch.setattr(lab, "start_bridge", fake_start)
    read_only_lab_env('ALLOW_DRIVE="true"\n')
    lab._proc = _FakeProcess()
    status = lab.set_drive(lab.DriveRequest(allow=False))
    assert len(started) == 1 and "allow_drive" not in started[0]
    assert status["drive_allowed"] is False and status["config_error"]


def test_bridge_lists_the_recorders_rosbags(lab, tmp_path):
    # Without rosbag.env: the recorder's default folder.
    script = lab._build_command({"CAMERA_TOPIC": ""})
    assert '-p rosbag_dir:="/var/lib/questix/rosbags"' in script
    (tmp_path / "rosbag.env").write_text("OUTPUT_DIR=/data/bags\n")
    assert '-p rosbag_dir:="/data/bags"' in lab._build_command({"CAMERA_TOPIC": ""})
    # A path the shell could misread is not passed on (the bridge keeps its default).
    (tmp_path / "rosbag.env").write_text("OUTPUT_DIR=/data/$(reboot)\n")
    assert "rosbag_dir" not in lab._build_command({"CAMERA_TOPIC": ""})


def test_records_dir_is_the_bridges_default_unless_set(lab, tmp_path):
    assert "records_dir" not in lab._build_command(lab._read_config())
    (tmp_path / "lab.env").write_text('RECORDS_DIR="/srv/questix/lab-records"\n')
    config = lab._read_config()
    assert config["RECORDS_DIR"] == "/srv/questix/lab-records"
    assert '-p records_dir:="/srv/questix/lab-records"' in lab._build_command(config)
    # The settings form keeps it.
    lab.set_config(lab.LabConfig(CAMERA_TOPIC="", AUTOSTART=True))
    assert lab._read_config()["RECORDS_DIR"] == "/srv/questix/lab-records"
    with pytest.raises(HTTPException) as error:
        lab._build_command({"RECORDS_DIR": "relative; reboot"})
    assert "RECORDS_DIR" in error.value.detail


def test_status_passes_the_bridges_records_summary_on(lab, monkeypatch):
    records = {"dir": "/home/ubuntu/.local/share/questix/lab-records", "count": 3,
               "used_bytes": 1234567, "limit_bytes": 524288000, "save": True,
               "auto_record": True, "rosbag_dir": "/var/lib/questix/rosbags"}
    state = {"read_only": True, "clients": 0, "max_clients": 24, "records": records}
    monkeypatch.setattr(lab, "_bridge_state", lambda: state)
    lab._proc = _FakeProcess()
    assert lab.get_status()["bridge"]["records"] == records
