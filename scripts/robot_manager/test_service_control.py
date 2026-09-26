"""Tests for starting and stopping the robot service (practice start request, 「すべて止める」).

systemctl is never run: app._systemctl and app._service_status are replaced by a fake service
whose ExecStart imitates systemd/questix_robot_launcher.sh (test_launcher_script.py runs the
real script).
"""

import importlib
import time

import pytest
from fastapi import HTTPException

BOOT = "boot-1"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("QUESTIX_CONFIG_DIR", str(tmp_path))
    from robot_manager import app as module
    module = importlib.reload(module)
    monkeypatch.setattr(module, "_boot_id", lambda: BOOT)
    monkeypatch.setattr(module, "START_PICKUP_SEC", 0.3)
    monkeypatch.setattr(module, "START_SETTLE_SEC", 0.0)
    monkeypatch.setattr(module, "STOP_SETTLE_SEC", 0.2)
    monkeypatch.setattr(module, "POLL_SEC", 0.02)
    return module


class FakeService:
    """questix_robot.service with a launcher that behaves like the real one (or an old one)."""

    def __init__(self, app, launcher="current", launch_survives=True):
        self.app = app
        self.state = "inactive"
        self.launcher = launcher
        self.launch_survives = launch_survives
        self.calls = []

    def systemctl(self, action):
        self.calls.append(action)
        if action == "stop":
            self.state = "inactive"
            return
        mode = self.app._read_mode()
        request = self.app.START_REQUEST_FILE
        if mode == "competition":
            launched = True
        elif self.launcher == "old":
            launched = False  # the old launcher skips practice and leaves the file alone
        else:
            fresh = request.exists() and "mode=practice" in request.read_text()
            if request.exists():
                request.unlink()
            launched = fresh
        if launched:
            self.app.LAST_LAUNCH_FILE.write_text(
                f"mode={mode}\nstarted_at={int(time.time())}\nboot_id={BOOT}\n")
        self.state = "active" if launched and self.launch_survives else "inactive"

    def status(self):
        return self.state


@pytest.fixture
def service(app, monkeypatch):
    fake = FakeService(app)
    monkeypatch.setattr(app, "_systemctl", fake.systemctl)
    monkeypatch.setattr(app, "_service_status", fake.status)
    return fake


def test_practice_start_writes_a_request_and_reports_the_practice_launch(app, service, tmp_path):
    (tmp_path / "mode").write_text("practice\n")
    answer = app.control_service("start")
    assert answer["ok"] is True and answer["message"] == "練習用の構成で起動しました"
    assert answer["running_mode"] == "practice"
    assert not app.START_REQUEST_FILE.exists()
    status = app.get_status()
    assert status["mode"] == "practice" and status["running_mode"] == "practice"


def test_request_is_written_before_systemctl_in_the_launchers_format(app, service, monkeypatch,
                                                                     tmp_path):
    (tmp_path / "mode").write_text("practice\n")
    seen = []

    def systemctl(action):
        seen.append(app.START_REQUEST_FILE.read_text())
        service.systemctl(action)
    monkeypatch.setattr(app, "_systemctl", systemctl)
    app.control_service("restart")
    lines = seen[0].splitlines()
    assert lines[0] == "mode=practice" and lines[2] == f"boot_id={BOOT}"
    assert abs(int(lines[1].split("=")[1]) - time.time()) < 5
    assert not list(tmp_path.glob(".start-request.*"))  # written atomically, no leftovers


def test_old_launcher_is_reported_and_the_request_removed(app, service, tmp_path):
    (tmp_path / "mode").write_text("practice\n")
    service.launcher = "old"
    answer = app.control_service("start")
    assert answer["ok"] is False and answer["message"].startswith("起動できませんでした")
    assert "起動スクリプト" in answer["message"]
    assert "完了" not in answer["message"]
    # A request left behind must never start the robot later (e.g. at the next crash restart).
    assert not app.START_REQUEST_FILE.exists()


def test_a_practice_launch_that_dies_at_once_is_not_called_started(app, service, tmp_path):
    (tmp_path / "mode").write_text("practice\n")
    service.launch_survives = False
    answer = app.control_service("start")
    assert answer["ok"] is False and answer["state"] == "inactive"
    assert "自動で起動し直しません" in answer["message"]


def test_competition_start_needs_no_request(app, service, tmp_path):
    (tmp_path / "mode").write_text("competition\n")
    answer = app.control_service("start")
    assert answer["ok"] is True and answer["message"] == "大会用の構成で起動しました"
    assert not app.START_REQUEST_FILE.exists()


def test_failed_systemctl_removes_the_request(app, service, monkeypatch, tmp_path):
    (tmp_path / "mode").write_text("practice\n")

    def refuse(action):
        raise HTTPException(status_code=500, detail="Access denied")
    monkeypatch.setattr(app, "_systemctl", refuse)
    with pytest.raises(HTTPException):
        app.control_service("start")
    assert not app.START_REQUEST_FILE.exists()


def test_unwritable_request_is_a_permission_error_with_the_fix(app, service, monkeypatch,
                                                               tmp_path):
    (tmp_path / "mode").write_text("practice\n")

    def refuse(mode):
        raise PermissionError
    monkeypatch.setattr(app, "_write_start_request", refuse)
    with pytest.raises(HTTPException) as error:
        app.control_service("start")
    assert error.value.status_code == 403 and "sudo chown" in error.value.detail
    assert service.calls == []


def test_stop_reports_and_remembers_the_request(app, service, tmp_path):
    (tmp_path / "mode").write_text("practice\n")
    app.control_service("start")
    answer = app.control_service("stop")
    assert answer["ok"] is True and answer["state"] == "inactive"
    assert answer["message"] == "ロボット制御を止めました"
    status = app.get_status()
    assert status["running_mode"] is None and status["stop_requested_at"] is not None


def test_running_mode_differs_from_the_next_mode_after_a_switch(app, service, tmp_path,
                                                                monkeypatch):
    (tmp_path / "mode").write_text("practice\n")
    app.control_service("start")
    monkeypatch.setattr(app.lab, "disable_for_competition", lambda: None)
    answer = app.set_mode(app.ModeRequest(mode="competition"))
    assert answer["running_mode"] == "practice" and answer["restart_needed"] is True
    status = app.get_status()
    assert (status["mode"], status["running_mode"]) == ("competition", "practice")


def test_running_mode_of_another_boot_or_an_old_launcher_is_unknown(app, service, tmp_path):
    service.state = "active"
    assert app.get_status()["running_mode"] == "unknown"  # nothing recorded
    app.LAST_LAUNCH_FILE.write_text("mode=practice\nstarted_at=1\nboot_id=old-boot\n")
    assert app.get_status()["running_mode"] == "unknown"


def test_manager_start_removes_a_leftover_request(app, monkeypatch):
    import asyncio
    monkeypatch.setattr(app.lab, "autostart", lambda: None)
    monkeypatch.setattr(app.lab, "shutdown", lambda: None)
    app.START_REQUEST_FILE.write_text("mode=practice\n")

    async def run():
        async with app.app.router.lifespan_context(app.app):
            assert not app.START_REQUEST_FILE.exists()
    asyncio.run(run())


def test_stop_all_stops_the_lessons_then_the_service(app, service, monkeypatch, tmp_path):
    (tmp_path / "mode").write_text("practice\n")
    app.control_service("start")
    order = []
    monkeypatch.setattr(app.lab, "stop_lesson_motion", lambda: order.append("lab") or {
        "ok": True, "message": "教材の走行・発射を止めました", "bridge": True,
        "drive_active": False, "shoot_active": False})
    real = service.systemctl
    monkeypatch.setattr(app, "_systemctl", lambda action: order.append(action) or real(action))
    answer = app.stop_all()
    assert order == ["lab", "stop"]
    assert answer["ok"] is True and answer["service"]["state"] == "inactive"
    assert answer["lab"]["message"] == "教材の走行・発射を止めました"


def test_stop_all_still_stops_the_service_when_the_bridge_fails(app, service, monkeypatch):
    service.state = "active"
    monkeypatch.setattr(app.lab, "stop_lesson_motion", lambda: {
        "ok": False, "message": "教材のブリッジに停止を送れませんでした", "bridge": True,
        "drive_active": None, "shoot_active": None})
    answer = app.stop_all()
    assert answer["ok"] is False and service.state == "inactive"
    assert answer["service"]["ok"] is True


def test_stop_all_reports_a_service_that_cannot_be_stopped(app, service, monkeypatch):
    service.state = "active"
    monkeypatch.setattr(app.lab, "stop_lesson_motion", lambda: {
        "ok": True, "message": "", "bridge": False, "drive_active": None, "shoot_active": None})

    def refuse(action):
        raise HTTPException(status_code=500, detail="Access denied")
    monkeypatch.setattr(app, "_systemctl", refuse)
    answer = app.stop_all()  # never raises: the lessons were stopped all the same
    assert answer["ok"] is False and "Access denied" in answer["service"]["message"]
