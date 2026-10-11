"""Tests for the E-stop display (no ROS: the listener is a fake process fed JSON lines)."""

import importlib
import io
import os
import queue
import subprocess
import threading
import types

import pytest
from fastapi import HTTPException

from robot_manager import estop_listener


class _Feed:
    """The listener's stdout: each pushed line returns once the manager's reader handled it."""

    def __init__(self):
        self._queue = queue.Queue()

    def push(self, line):
        done = threading.Event()
        self._queue.put((line, done))
        assert done.wait(2.0), "the reader did not take the line"

    def close(self):
        self._queue.put((None, threading.Event()))

    def __iter__(self):
        while True:
            line, done = self._queue.get()
            if line is None:
                return
            yield line
            done.set()  # the reader asked for the next line: this one is handled


class _FakeStdin(io.StringIO):
    def __init__(self, on_close):
        super().__init__()
        self.closed_by_parent = False
        self._on_close = on_close

    def close(self):
        self.closed_by_parent = True
        self._on_close()


class _FakeListener:
    """What subprocess.Popen returns for the listener: running until stdin closes or it exits."""

    def __init__(self, command, **kwargs):
        self.command = command
        self.kwargs = kwargs
        self.stdout = _Feed()
        self.stdin = _FakeStdin(self.stdout.close)
        self.returncode = None
        self.pid = 4343

    def exit(self, code):
        self.returncode = code
        self.stdout.close()

    def poll(self):
        if self.stdin.closed_by_parent and self.returncode is None:
            self.returncode = 0
        return self.returncode

    def wait(self, timeout=None):
        return self.poll()

    def kill(self):
        self.returncode = -9


@pytest.fixture
def monitor(tmp_path, monkeypatch):
    monkeypatch.setenv("QUESTIX_CONFIG_DIR", str(tmp_path))
    from robot_manager import estop_monitor as module
    module = importlib.reload(module)
    (tmp_path / "launch.env").write_text("ROS_DOMAIN_ID=7\n")
    ros = tmp_path / "ros.bash"
    workspace = tmp_path / "ws.bash"
    ros.write_text("")
    workspace.write_text("")
    monkeypatch.setattr(module.control_runtime, "_ros_paths", lambda config: (ros, workspace))
    started = []

    def popen(command, **kwargs):
        proc = _FakeListener(command, **kwargs)
        started.append(proc)
        return proc

    # Only this module's Popen: the real subprocess module stays untouched for everyone else.
    monkeypatch.setattr(module, "subprocess", types.SimpleNamespace(
        Popen=popen, PIPE=subprocess.PIPE, DEVNULL=subprocess.DEVNULL,
        TimeoutExpired=subprocess.TimeoutExpired))
    clock = [100.0]
    monkeypatch.setattr(module, "_now", lambda: clock[0])
    module.started = started
    module.clock = clock
    yield module
    module.shutdown()


def line(active, reason="released"):
    return ('{"active": %s, "source": "operation_manager", "reason": "%s"}\n'
            % ("true" if active else "false", reason))


def test_nothing_runs_while_the_robot_service_is_not_active(monitor):
    for service in ("inactive", "activating", "failed", "unknown"):
        assert monitor.observe(service)["state"] == "unknown"
        assert monitor.observe(service)["note"] == "robot_stopped"
    assert monitor.started == []


def test_an_active_robot_gets_a_listener_in_its_own_domain(monitor):
    first = monitor.observe("active")
    assert first["state"] == "unknown" and first["note"] == "starting"
    (proc,) = monitor.started
    assert "export ROS_DOMAIN_ID=7; " in proc.command[4]
    assert proc.command[-1].endswith("estop_listener.py")
    assert "ROS_DOMAIN_ID" not in proc.kwargs["env"]  # the command exports the robot's domain
    monitor.observe("active")
    assert len(monitor.started) == 1  # one listener, kept running
    monitor.clock[0] += monitor.STARTUP_SEC
    assert monitor.observe("active")["note"] == "not_heard"


def test_released_and_pressed_follow_the_topic_with_its_reason(monitor):
    monitor.observe("active")
    (proc,) = monitor.started
    proc.stdout.push(line(False))
    released = monitor.observe("active")
    assert released["state"] == "released" and released["reason"] == "released"
    assert released["source"] == "operation_manager"
    proc.stdout.push(line(True, "pin 5 is true, expected false; "))
    pressed = monitor.observe("active")
    assert pressed["state"] == "pressed"
    assert pressed["reason"] == "pin 5 is true, expected false; "


def test_a_silent_topic_is_unknown_never_released(monitor):
    monitor.observe("active")
    monitor.started[0].stdout.push(line(False))
    monitor.clock[0] += monitor.STALE_SEC + 0.1
    silent = monitor.observe("active")
    assert silent["state"] == "unknown" and silent["note"] == "silent"
    assert silent["age_sec"] == pytest.approx(monitor.STALE_SEC + 0.1, abs=0.05)


def test_lines_that_are_not_reports_never_count(monitor):
    monitor.observe("active")
    proc = monitor.started[0]
    for garbage in ("not json\n", '{"active": "false"}\n', '["released"]\n',
                    '{"active": false, "reason": 5}\n'):
        proc.stdout.push(garbage)
        assert monitor.observe("active")["state"] == "unknown"


def test_stopping_the_robot_stops_the_listener_and_forgets_the_state(monitor):
    monitor.observe("active")
    proc = monitor.started[0]
    proc.stdout.push(line(False))
    stopped = monitor.observe("inactive")
    assert stopped["note"] == "robot_stopped" and proc.stdin.closed_by_parent
    restarted = monitor.observe("active")
    assert restarted["note"] == "starting" and len(monitor.started) == 2


def test_a_listener_that_exits_is_reported_and_retried_later(monitor):
    monitor.observe("active")
    monitor.started[0].exit(1)
    gone = monitor.observe("active")
    assert gone["state"] == "unknown" and gone["note"] == "unavailable"
    assert "終了コード 1" in gone["detail"]
    assert len(monitor.started) == 1  # not restarted in a loop
    monitor.clock[0] += monitor.RETRY_SEC
    assert monitor.observe("active")["note"] == "starting"
    assert len(monitor.started) == 2


def test_a_changed_domain_moves_the_listener(monitor, tmp_path):
    monitor.observe("active")
    old = monitor.started[0]
    old.stdout.push(line(False))
    (tmp_path / "launch.env").write_text("ROS_DOMAIN_ID=9\n")
    moved = monitor.observe("active")
    assert old.stdin.closed_by_parent and moved["note"] == "starting"
    assert "export ROS_DOMAIN_ID=9; " in monitor.started[1].command[4]


def test_missing_ros_is_reported_without_a_listener(monitor, monkeypatch):
    def missing(config):
        raise HTTPException(503, "ROS 環境が見つかりません。")
    monkeypatch.setattr(monitor.control_runtime, "_ros_paths", missing)
    report = monitor.observe("active")
    assert report["note"] == "unavailable" and report["detail"] == "ROS 環境が見つかりません。"
    assert monitor.started == []


def test_shutdown_stops_the_listener(monitor):
    monitor.observe("active")
    monitor.shutdown()
    assert monitor.started[0].stdin.closed_by_parent


def test_the_listener_reports_changes_at_once_and_otherwise_once_per_period():
    reporter = estop_listener.Reporter(period=0.5)
    assert reporter.update(False, "operation_manager", "released", 0.0) is not None
    assert reporter.update(False, "operation_manager", "released", 0.1) is None
    pressed = reporter.update(True, "operation_manager", "pin 5 is true, expected false; ", 0.2)
    assert '"active": true' in pressed
    assert reporter.update(True, "operation_manager", "pin 5 is true, expected false; ", 0.5) is None
    assert reporter.update(True, "operation_manager", "pin 5 is true, expected false; ", 0.75)
    long = reporter.update(True, "x" * 500, "y" * 500, 0.8)
    assert '"' + "x" * estop_listener.MAX_TEXT + '"' in long and "x" * 201 not in long


def test_the_listener_notices_its_stdin_closing():
    read_end, write_end = os.pipe()
    with os.fdopen(read_end) as stdin:
        writer = os.fdopen(write_end, "w")
        assert estop_listener.stdin_closed(stdin) is False
        writer.close()
        assert estop_listener.stdin_closed(stdin) is True
