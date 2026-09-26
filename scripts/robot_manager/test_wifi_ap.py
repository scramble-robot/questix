"""Tests for the access point QR data (the settings file of scripts/wifi-ap.sh)."""

import importlib

import pytest


@pytest.fixture
def wifi_ap(tmp_path, monkeypatch):
    monkeypatch.setenv("QUESTIX_CONFIG_DIR", str(tmp_path))
    from robot_manager import wifi_ap as module
    module = importlib.reload(module)
    monkeypatch.setattr(module, "_active", lambda: True)
    # The controller type comes from launch.env: never the machine's own.
    monkeypatch.setattr(module.lab, "LAUNCH_ENV_FILE", tmp_path / "launch.env")
    return module


def test_not_configured_without_settings(wifi_ap):
    assert wifi_ap.get_access_point() == {"configured": False}


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
    assert wifi_ap.get_access_point() == {
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
    assert wifi_ap.get_access_point() == {"configured": False}
