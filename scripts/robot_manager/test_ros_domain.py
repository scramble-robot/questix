"""QUESTiX's one ROS_DOMAIN_ID policy, and the copies that must repeat it."""

import importlib.util
import re
from pathlib import Path

import pytest
from fastapi import HTTPException

from robot_manager import ros_domain

REPO = Path(__file__).resolve().parents[2]


def _resolver():
    spec = importlib.util.spec_from_file_location(
        "resolve_ros_domain_id", REPO / "scripts" / "resolve_ros_domain_id.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_policy_values():
    assert ros_domain.ALLOWED_RANGES == ((0, 101), (215, 232))
    assert ros_domain.LEGACY_DOMAIN_ID == 42
    for value in (0, 42, 101, 215, 232):
        assert ros_domain.is_allowed(value)
    for value in (-1, 102, 150, 214, 233, 999):
        assert not ros_domain.is_allowed(value)


def test_parse_reads_like_the_kitting_resolver():
    resolver = _resolver()
    for raw in ("0", "42", " 101 ", '"215"', "'232'", "042", "102", "214", "233", "-1", "abc",
                "", "1e2", "4 2", '"42', None):
        expected = resolver.parse_strict_int(raw)
        if expected is not None and not resolver.is_in_allowed_range(expected):
            expected = None
        assert ros_domain.parse(raw) == expected, raw


def test_the_resolver_uses_this_policy_not_a_copy():
    resolver = _resolver()
    assert resolver.ALLOWED_RANGES is ros_domain.ALLOWED_RANGES
    assert resolver.LEGACY_DOMAIN_ID == ros_domain.LEGACY_DOMAIN_ID


def test_copies_that_cannot_import_the_policy_repeat_it():
    # Ansible (can be run without the resolver, e.g. ISO builds).
    ansible = (REPO / "ansible/playbooks/tasks/validate_ros_domain_id.yaml").read_text()
    bounds = [int(n) for n in re.findall(r"\(ros_domain_id \| int\) [<>]= (\d+)", ansible)]
    assert bounds == [0, 101, 215, 232]
    # The robot launcher (warns only) and its Ansible copy.
    for path in ("systemd/questix_robot_launcher.sh",
                 "ansible/roles/robot_autostart/files/questix_robot_launcher.sh"):
        text = (REPO / path).read_text()
        assert ('{ [ "${id}" -ge 0 ] && [ "${id}" -le 101 ]; } || '
                '{ [ "${id}" -ge 215 ] && [ "${id}" -le 232 ]; }') in text, path
    # The settings form (a number input cannot express the gap; the API refuses it).
    html = (REPO / "scripts/robot_manager/static/index.html").read_text()
    assert '<input type="number" id="ros-domain-id" min="0" max="232"' in html
    assert ros_domain.ALLOWED_TEXT in html


def test_launch_settings_refuse_what_kitting_refuses():
    from robot_manager import app
    for value in ("12", "0", "101", "215", "232"):
        assert app.LaunchConfig(ROS_DOMAIN_ID=value).ROS_DOMAIN_ID == value
    for value in ("102", "150", "214", "233", "-1", "abc"):
        with pytest.raises(ValueError):
            app.LaunchConfig(ROS_DOMAIN_ID=value)


def test_control_runtime_refuses_a_domain_outside_the_policy():
    from robot_manager import control_runtime
    with pytest.raises(HTTPException) as error:
        control_runtime.read_snapshot({"ROS_DOMAIN_ID": "150"})
    assert error.value.status_code == 422 and ros_domain.ALLOWED_TEXT in error.value.detail


def test_shell_export_follows_the_robot_even_outside_the_policy():
    assert ros_domain.shell_export("12") == "export ROS_DOMAIN_ID=12; "
    assert ros_domain.shell_export('"12"') == "export ROS_DOMAIN_ID=12; "
    # The robot runs in it anyway (the launcher only warns): the bridge and recorder must too.
    assert ros_domain.shell_export("150") == "export ROS_DOMAIN_ID=150; "
    # Missing: the launcher's own fallback (${ROS_DOMAIN_ID:-42}).
    assert ros_domain.shell_export(None) == "export ROS_DOMAIN_ID=42; "
    assert ros_domain.shell_export("") == "export ROS_DOMAIN_ID=42; "
    for raw in ("abc", "12; reboot", "$(reboot)", "1234", "-1"):
        assert ros_domain.shell_export(raw) == ""


def test_the_recorder_records_in_the_robots_domain(tmp_path, monkeypatch):
    from robot_manager import recorder
    monkeypatch.setattr(recorder, "LAUNCH_ENV_FILE", tmp_path / "launch.env")
    (tmp_path / "launch.env").write_text('ROBOT_WS=/home/ubuntu/robot_ws\nROS_DOMAIN_ID="17"\n')
    script = recorder._build_record_command({}, tmp_path / "bag")
    assert "export ROS_DOMAIN_ID=17; exec ros2 bag record" in script
    (tmp_path / "launch.env").write_text("ROBOT_WS=/home/ubuntu/robot_ws\n")
    # No value: where the robot launcher then runs (42), not the manager's own environment.
    assert "export ROS_DOMAIN_ID=42; " in recorder._build_record_command({}, tmp_path / "bag")
