"""Tests for the access point data (QR codes, network card) and the QUESTiX Local API.

Nothing here runs a real tool: ``_tool`` (read-only nmcli / iw / ip) and ``_systemctl_start``
(the only command that changes something, through the root helper) are replaced.
"""

import asyncio
import importlib
import json
import threading

import pytest
from fastapi import HTTPException

from robot_manager import network_admin


@pytest.fixture
def wifi_ap(tmp_path, monkeypatch):
    monkeypatch.setenv("QUESTIX_CONFIG_DIR", str(tmp_path))
    from robot_manager import wifi_ap as module
    module = importlib.reload(module)
    monkeypatch.setattr(module, "_active", lambda: True)
    # The controller type comes from launch.env: never the machine's own.
    monkeypatch.setattr(module.lab, "LAUNCH_ENV_FILE", tmp_path / "launch.env")
    module.tools = []

    def tool(argv):
        module.tools.append(argv)
        return module.tool_output.get(argv[0], "")
    module.tool_output = {}
    monkeypatch.setattr(module, "_tool", tool)
    monkeypatch.setattr(module, "SYS_NET", tmp_path / "sys_net")
    helper = tmp_path / "opt" / "questix_network_admin.py"
    helper.parent.mkdir()
    helper.write_text("# installed helper\n")
    monkeypatch.setattr(module, "HELPER_PATH", helper)
    return module


def test_not_configured_without_settings(wifi_ap):
    answer = wifi_ap.get_access_point()
    assert answer["configured"] is False and answer["admin_available"] is True
    assert answer["job"] == {"state": "idle"}


def test_reads_the_settings_written_by_the_role(wifi_ap, tmp_path):
    # As rendered by templates/wifi_ap.env.j2 with Ansible's `quote` filter.
    (tmp_path / "wifi_ap.env").write_text(
        "# Ansible managed\n"
        "WIFI_AP_STATE=up\n"
        "WIFI_AP_SSID='QUESTiX 3F2A'\n"
        "WIFI_AP_PASSWORD='ab\"c'\"'\"'d;e:f'\n"
        "WIFI_AP_BAND=bg\n"
        "WIFI_AP_CHANNEL=11\n"
        "WIFI_AP_ADDRESS=10.42.0.1/24\n"
    )
    answer = wifi_ap.get_access_point()
    assert {key: answer[key] for key in (
        "configured", "active", "ssid", "password", "band", "channel", "address", "lab_url",
        "controller_url", "controller_type")} == {
        "configured": True,
        "active": True,
        "ssid": "QUESTiX 3F2A",
        "password": "ab\"c'd;e:f",
        "band": "bg",
        "channel": "11",
        "address": "10.42.0.1",
        "lab_url": f"http://10.42.0.1:{wifi_ap.lab.LAB_BRIDGE_PORT}/",
        "controller_url": "http://10.42.0.1:8899/",
        "controller_type": "",
    }


def test_carries_the_browser_controller_for_the_card(wifi_ap, tmp_path):
    (tmp_path / "launch.env").write_text("CONTROLLER_TYPE=web\n")
    (tmp_path / "wifi_ap.env").write_text("WIFI_AP_SSID=robot\nWIFI_AP_ADDRESS=10.42.0.1/24\n")
    answer = wifi_ap.get_access_point()
    assert answer["controller_type"] == "web"
    assert answer["controller_url"] == "http://10.42.0.1:8899/"


def test_unreadable_settings_count_as_not_configured(wifi_ap, tmp_path, monkeypatch):
    def refuse(self, *args, **kwargs):
        raise PermissionError
    (tmp_path / "wifi_ap.env").write_text("WIFI_AP_SSID=x\n")
    monkeypatch.setattr(wifi_ap.Path, "read_text", refuse)
    assert wifi_ap.get_access_point()["configured"] is False


SETTINGS = ("WIFI_AP_STATE=up\nWIFI_AP_INTERFACE=wlan0\nWIFI_AP_SSID='QUESTiX 3F2A'\n"
            "WIFI_AP_PASSWORD=secret-pass-9\nWIFI_AP_BAND=bg\nWIFI_AP_CHANNEL=6\n"
            "WIFI_AP_COUNTRY=JP\nWIFI_AP_ADDRESS=10.42.0.1/24\n")


def test_network_card_fields_are_read_only(wifi_ap, tmp_path):
    (tmp_path / "wifi_ap.env").write_text(SETTINGS)
    (tmp_path / "sys_net" / "eth0").mkdir(parents=True)
    (tmp_path / "sys_net" / "eth0" / "carrier").write_text("1\n")
    wifi_ap.tool_output = {"iw": "Station aa:bb (on wlan0)\nStation cc:dd (on wlan0)\n",
                           "ip": "default via 192.168.1.1 dev eth0 proto dhcp\n"}
    before = sorted(p.name for p in tmp_path.iterdir())
    answer = wifi_ap.get_access_point()
    assert answer["state"] == "up" and answer["country"] == "JP" and answer["prefix"] == "24"
    assert answer["clients"] == 2
    assert answer["upstream"] == {"summary": "default_route", "wired": True, "default_route": True}
    assert answer["ssh"].endswith("@10.42.0.1")
    # Only reading tools, and nothing written.
    assert [argv[:2] for argv in wifi_ap.tools] == [["iw", "dev"], ["ip", "-4"]]
    assert sorted(p.name for p in tmp_path.iterdir()) == before


@pytest.mark.parametrize("routes, carrier, summary", [
    ("", None, "none"),
    ("", "1", "wired"),
    ("default via 10.42.0.1 dev wlan0\n", None, "none"),  # its own access point is no upstream
    ("default via 192.168.1.1 dev eth0\n", "0", "default_route"),
])
def test_upstream_summary(wifi_ap, tmp_path, routes, carrier, summary):
    if carrier is not None:
        (tmp_path / "sys_net" / "eth0").mkdir(parents=True)
        (tmp_path / "sys_net" / "eth0" / "carrier").write_text(carrier)
    wifi_ap.tool_output = {"ip": routes}
    assert wifi_ap._upstream("wlan0")["summary"] == summary


class FakeRequest:
    def __init__(self, body):
        self.body = body

    async def json(self):
        if isinstance(self.body, Exception):
            raise self.body
        return self.body


def put(wifi_ap, body):
    return asyncio.run(wifi_ap.put_config(FakeRequest(body)))


class Helper:
    """Stands in for systemctl start + the root helper: reads the request, writes a status."""

    def __init__(self, wifi_ap, tmp_path, state="succeeded", code=None, returncode=0, stderr=""):
        self.wifi_ap, self.tmp_path = wifi_ap, tmp_path
        self.state, self.code, self.returncode, self.stderr = state, code, returncode, stderr
        self.requests = []
        self.release = threading.Event()
        self.release.set()

    def __call__(self):
        self.release.wait(5)
        request_file = self.tmp_path / network_admin.REQUEST_NAME
        if self.state is not None:
            request = json.loads(request_file.read_text())
            self.requests.append(request)
            request_file.unlink()
            code = self.code or {"start": "started", "stop": "stopped", "configure": "configured",
                                 "regenerate_password": "password_regenerated"}[request["action"]]
            (self.tmp_path / network_admin.STATUS_NAME).write_text(json.dumps(
                {"id": request["id"], "state": self.state, "code": code}))
        return type("Result", (), {"returncode": self.returncode, "stderr": self.stderr})()


def wait(wifi_ap):
    for thread in threading.enumerate():
        if thread.name == "questix-local":
            thread.join(5)
    return wifi_ap.get_job()


@pytest.fixture
def helper(wifi_ap, tmp_path, monkeypatch):
    fake = Helper(wifi_ap, tmp_path)
    monkeypatch.setattr(wifi_ap, "_systemctl_start", fake)
    monkeypatch.setattr(wifi_ap.lab, "_competition_mode", lambda: False)
    monkeypatch.setattr(wifi_ap.lab, "_read_config", lambda: {"AUTOSTART": "true"})
    wifi_ap.lab_starts = []
    monkeypatch.setattr(wifi_ap.lab, "start_bridge", lambda: wifi_ap.lab_starts.append(1))
    return fake


def test_start_runs_the_helper_and_then_the_lab(wifi_ap, helper):
    response = wifi_ap.start_access_point()
    assert response.status_code == 202
    job = wait(wifi_ap)
    assert job["state"] == "succeeded" and job["code"] == "started"
    assert job["lab"] == "started" and wifi_ap.lab_starts == [1]
    assert helper.requests[0]["action"] == "start" and helper.requests[0]["settings"] == {}


def test_systemctl_is_asked_for_the_one_unit_only(wifi_ap, monkeypatch):
    calls = []
    monkeypatch.setattr(wifi_ap.subprocess, "run", lambda argv, **kw: calls.append((argv, kw)))
    wifi_ap._systemctl_start()
    argv, kwargs = calls[0]
    assert argv == ["systemctl", "--no-ask-password", "start", "questix_network_admin.service"]
    assert kwargs["shell"] is False


def test_no_lab_in_competition_mode(wifi_ap, helper, monkeypatch):
    monkeypatch.setattr(wifi_ap.lab, "_competition_mode", lambda: True)
    wifi_ap.start_access_point()
    job = wait(wifi_ap)
    assert job["state"] == "succeeded" and job["lab"] == "competition"
    assert wifi_ap.lab_starts == []


def test_no_lab_when_its_autostart_is_off(wifi_ap, helper, monkeypatch):
    monkeypatch.setattr(wifi_ap.lab, "_read_config", lambda: {"AUTOSTART": "false"})
    wifi_ap.start_access_point()
    assert wait(wifi_ap)["lab"] == "autostart_off" and wifi_ap.lab_starts == []


def test_lab_already_serving_is_fine(wifi_ap, helper, monkeypatch):
    def running():
        raise HTTPException(status_code=409, detail="教材はすでに配信中です")
    monkeypatch.setattr(wifi_ap.lab, "start_bridge", running)
    wifi_ap.start_access_point()
    assert wait(wifi_ap)["lab"] == "running"


def test_stop_does_not_touch_the_lab(wifi_ap, helper, tmp_path):
    (tmp_path / "wifi_ap.env").write_text(SETTINGS)
    wifi_ap.stop_access_point()
    job = wait(wifi_ap)
    assert job["code"] == "stopped" and "lab" not in job and wifi_ap.lab_starts == []


def test_stop_and_regenerate_need_settings(wifi_ap, helper):
    for call in (wifi_ap.stop_access_point, wifi_ap.regenerate_password):
        with pytest.raises(HTTPException) as error:
            call()
        assert error.value.status_code == 409
    assert helper.requests == []


def test_config_is_passed_on_validated(wifi_ap, helper, tmp_path):
    (tmp_path / "wifi_ap.env").write_text(SETTINGS)
    put(wifi_ap, {"ssid": "QUESTiX Room 3", "password": "n3w-Pass!", "band": "a",
                  "channel": 40, "address": "auto"})
    job = wait(wifi_ap)
    assert job["state"] == "succeeded"
    assert helper.requests[0]["settings"] == {"ssid": "QUESTiX Room 3", "password": "n3w-Pass!",
                                              "band": "a", "channel": 40, "address": "auto"}
    assert "n3w-Pass!" not in json.dumps(job)
    assert not (tmp_path / network_admin.REQUEST_NAME).exists()


@pytest.mark.parametrize("body", [
    {"interface": "eth0"}, {"ssid": "ok-name", "command": "reboot"}, {"path": "/etc/shadow"},
    {}, [], "start", {"channel": "6"}, {"channel": True}, {"band": "ac"},
    {"ssid": " bad"}, {"channel": 36}, {"address": "8.8.8.1/24"}, {"password": ""},
    {"password": 12345678}, ValueError("not json"),
])
def test_bad_config_is_refused_before_the_helper(wifi_ap, helper, tmp_path, body):
    (tmp_path / "wifi_ap.env").write_text(SETTINGS)
    with pytest.raises(HTTPException) as error:
        put(wifi_ap, body)
    assert error.value.status_code == 422
    assert helper.requests == [] and not (tmp_path / network_admin.REQUEST_NAME).exists()


@pytest.mark.parametrize("password", ["has space 1", "back\\slash1", "short", "日本語のパスワード"])
def test_refused_password_is_never_echoed(wifi_ap, helper, password):
    with pytest.raises(HTTPException) as error:
        put(wifi_ap, {"password": password})
    assert password not in str(error.value.detail)


def test_one_change_at_a_time(wifi_ap, helper):
    helper.release.clear()
    wifi_ap.start_access_point()
    with pytest.raises(HTTPException) as error:
        wifi_ap.start_access_point()
    assert error.value.status_code == 409
    assert wifi_ap.get_access_point()["job"]["state"] == "running"
    helper.release.set()
    assert wait(wifi_ap)["state"] == "succeeded"
    assert len(helper.requests) == 1


def test_missing_helper_is_reported(wifi_ap, helper):
    wifi_ap.HELPER_PATH.unlink()
    with pytest.raises(HTTPException) as error:
        wifi_ap.start_access_point()
    assert error.value.status_code == 503
    assert wifi_ap.get_access_point()["admin_available"] is False


@pytest.mark.parametrize("stderr, code", [
    ("Failed to start questix_network_admin.service: Interactive authentication required.",
     "not_permitted"),
    ("Failed to start questix_network_admin.service: Unit questix_network_admin.service not found.",
     "not_installed"),
    ("Job for questix_network_admin.service failed.", "helper_failed"),
])
def test_systemctl_failure_is_a_safe_message(wifi_ap, helper, tmp_path, stderr, code):
    helper.state, helper.returncode, helper.stderr = None, 1, stderr
    wifi_ap.start_access_point()
    job = wait(wifi_ap)
    assert job["state"] == "failed" and job["code"] == code
    assert job["message"] == wifi_ap.MESSAGES[code] and "lab" not in job
    # A request the helper never read (it may hold a password) is removed.
    assert not (tmp_path / network_admin.REQUEST_NAME).exists()


def test_helper_failure_is_reported_with_its_code(wifi_ap, helper):
    helper.state, helper.code, helper.returncode = "failed", "ap_up_failed", 1
    wifi_ap.start_access_point()
    job = wait(wifi_ap)
    assert job["state"] == "failed" and job["code"] == "ap_up_failed"
    assert job["message"] == network_admin.MESSAGES["ap_up_failed"]
    assert wifi_ap.lab_starts == []


def test_status_of_another_request_is_not_taken(wifi_ap, helper, tmp_path):
    helper.state = None  # the helper wrote nothing for this request
    (tmp_path / network_admin.STATUS_NAME).write_text(json.dumps(
        {"id": "f" * 32, "state": "succeeded", "code": "started"}))
    wifi_ap.start_access_point()
    assert wait(wifi_ap)["state"] == "failed"


def test_get_changes_nothing_while_a_job_is_idle(wifi_ap, tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("GET must not start anything")
    monkeypatch.setattr(wifi_ap, "_systemctl_start", forbidden)
    (tmp_path / "wifi_ap.env").write_text(SETTINGS)
    for _ in range(3):
        wifi_ap.get_access_point()
        wifi_ap.get_job()
    assert not (tmp_path / network_admin.REQUEST_NAME).exists()
