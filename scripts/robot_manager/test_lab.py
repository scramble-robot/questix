"""Tests for the QUESTiX LAB console (no ROS needed: the bridge command is only built)."""

import importlib

import pytest
from fastapi import HTTPException


@pytest.fixture
def lab(tmp_path, monkeypatch):
    monkeypatch.setenv("QUESTIX_CONFIG_DIR", str(tmp_path))
    from robot_manager import lab as module
    return importlib.reload(module)


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
    assert lab._read_config() == {"CAMERA_TOPIC": "/cam/compressed", "AUTOSTART": "true"}
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
    lab._proc = _FakeProcess()
    lab.disable_for_competition()
    assert signals == [(_FakeProcess.pid, lab.signal.SIGINT)]
    assert lab._read_config() == {"CAMERA_TOPIC": "/cam/compressed", "AUTOSTART": "false"}
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
    assert lab._read_config() == {"CAMERA_TOPIC": "/cam/compressed", "AUTOSTART": "true"}
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
