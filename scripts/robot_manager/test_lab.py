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
        "CAMERA_TOPIC": "/cam/compressed", "AUTOSTART": "false"}
    assert lab._read_config() == {"CAMERA_TOPIC": "/cam/compressed", "AUTOSTART": "false"}
    lab.set_config(lab.LabConfig(AUTOSTART=True))
    assert lab._read_config()["AUTOSTART"] == "true"
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
    assert started == []  # off by default
    lab.set_config(lab.LabConfig(AUTOSTART=True))
    lab.autostart()
    assert started == [True]


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
