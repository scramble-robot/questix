"""Tests for systemd/questix_robot_launcher.sh: the practice start request Robot Manager writes.

The script runs for real with a fake ``ros2`` and ``logger`` first in PATH, a temporary config
directory (QUESTIX_CONFIG_DIR), a fake boot id and an empty ROS setup file; nothing is launched.
"""

import os
import subprocess
import time
from pathlib import Path

import pytest

from robot_manager import app

REPO = Path(__file__).resolve().parents[2]
LAUNCHER = REPO / "systemd" / "questix_robot_launcher.sh"
ANSIBLE_COPY = REPO / "ansible" / "roles" / "robot_autostart" / "files" / "questix_robot_launcher.sh"
BOOT_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"


@pytest.fixture
def robot(tmp_path):
    config = tmp_path / "etc"
    config.mkdir()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    calls = tmp_path / "ros2.calls"
    (bin_dir / "ros2").write_text(f'#!/bin/sh\necho "$*" >> "{calls}"\n')
    (bin_dir / "logger").write_text(f'#!/bin/sh\necho "$*" >> "{tmp_path / "logger.log"}"\n')
    for tool in ("ros2", "logger"):
        (bin_dir / tool).chmod(0o755)
    (tmp_path / "boot_id").write_text(BOOT_ID + "\n")
    (tmp_path / "setup.bash").write_text("")
    (config / "launch.env").write_text(
        "ROS_DOMAIN_ID=7\nCONTROLLER_TYPE=web\nENABLE_GPIO_REF=true\n")

    class Robot:
        dir = config

        def mode(self, mode):
            (config / "mode").write_text(mode + "\n")

        def request(self, mode="practice", age=0, boot_id=BOOT_ID):
            (config / "start-request").write_text(
                f"mode={mode}\nrequested_at={int(time.time()) - age}\nboot_id={boot_id}\n")

        def run(self):
            env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}",
                       QUESTIX_CONFIG_DIR=str(config),
                       QUESTIX_BOOT_ID_FILE=str(tmp_path / "boot_id"),
                       QUESTIX_ROS_SETUP=str(tmp_path / "setup.bash"),
                       ROBOT_WS=str(tmp_path / "no_ws"))
            result = subprocess.run(["bash", str(LAUNCHER)], env=env, capture_output=True,
                                    text=True, timeout=20, check=False)
            launched = calls.read_text().splitlines() if calls.exists() else []
            return result, launched

    return Robot()


def test_ansible_copy_is_identical():
    assert ANSIBLE_COPY.read_text() == LAUNCHER.read_text()


def test_practice_without_a_request_does_not_launch(robot):
    robot.mode("practice")
    result, launched = robot.run()
    assert result.returncode == 0 and launched == []
    assert "no start request" in result.stdout


def test_practice_with_a_fresh_request_runs_the_practice_launch_once(robot):
    robot.mode("practice")
    robot.request()
    result, launched = robot.run()
    assert result.returncode == 0, result.stderr
    assert len(launched) == 1
    args = launched[0].split()
    assert args[:3] == ["launch", "questix_launcher", "questix_core.launch.xml"]
    assert "enable_autoreferee:=false" in args and "enable_gpio_ref:=true" in args
    assert "controller_type:=web" in args
    assert not (robot.dir / "start-request").exists()  # consumed: a crash is not relaunched
    last = (robot.dir / "last-launch").read_text()
    assert "mode=practice" in last and f"boot_id={BOOT_ID}" in last
    # What Restart=on-failure would do after a crash: no request left, nothing launched.
    _, launched = robot.run()
    assert len(launched) == 1


def test_practice_gpio_safety_follows_launch_env(robot):
    robot.mode("practice")
    (robot.dir / "launch.env").write_text("ENABLE_GPIO_REF=false\n")
    robot.request()
    _, launched = robot.run()
    assert "enable_gpio_ref:=false" in launched[0].split()
    assert "controller_type:=uart" in launched[0].split()  # the default


@pytest.mark.parametrize("request_kwargs, reason", [
    ({"age": 600}, "600 s old"),
    ({"boot_id": "another-boot"}, "earlier boot"),
    ({"mode": "competition"}, "asks for mode 'competition'"),
])
def test_unusable_requests_never_launch_and_are_removed(robot, request_kwargs, reason):
    robot.mode("practice")
    robot.request(**request_kwargs)
    result, launched = robot.run()
    assert result.returncode == 0 and launched == []
    assert reason in result.stdout
    assert not (robot.dir / "start-request").exists()


def test_competition_is_unchanged_and_drops_a_leftover_request(robot):
    robot.mode("competition")
    (robot.dir / "launch.env").write_text("ENABLE_GPIO_REF=false\nCONTROLLER_TYPE=uart\n")
    robot.request()
    result, launched = robot.run()
    assert result.returncode == 0
    args = launched[0].split()
    # Competition always keeps both GPIO safety inputs, whatever launch.env says.
    assert "enable_gpio_ref:=true" in args and "enable_autoreferee:=true" in args
    assert not (robot.dir / "start-request").exists()
    assert "mode=competition" in (robot.dir / "last-launch").read_text()


def test_manager_writes_a_request_the_launcher_accepts(robot, monkeypatch):
    # The same format on both sides: app.py writes it, the script reads it.
    monkeypatch.setattr(app, "START_REQUEST_FILE", robot.dir / "start-request")
    monkeypatch.setattr(app, "_boot_id", lambda: BOOT_ID)
    robot.mode("practice")
    app._write_start_request("practice")
    _, launched = robot.run()
    assert len(launched) == 1 and "enable_autoreferee:=false" in launched[0]
