"""Tests for the QUESTiX Local root helper (network_admin.py) with fake nmcli / iw / ip.

The helper runs against temporary directories and fake tools on its fixed PATH: nothing here
touches the real network, NetworkManager or /etc. The fake tools log every argument list, so the
tests can check what would run and that the passphrase never appears on a command line.
"""

import fcntl
import json
import os
import re
import stat
import textwrap
from pathlib import Path

import pytest

from robot_manager import network_admin as na

FAKE_TOOL = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, sys
    state = {state!r}
    name = os.path.basename(sys.argv[0])
    args = sys.argv[1:]
    with open(os.path.join(state, "calls"), "a") as log:
        log.write(json.dumps([name] + args) + "\\n")
    def read(file, default=""):
        try:
            with open(os.path.join(state, file)) as f:
                return f.read()
        except FileNotFoundError:
            return default
    active = os.path.join(state, "active")
    if name == "nmcli":
        if args == ["-t", "-f", "RUNNING", "general"]:
            print(read("nm_running", "running").strip())
        elif args[:5] == ["-t", "-f", "NAME", "connection", "show"]:
            print("Wired connection 1")
            if os.path.exists(active):
                print("questix-ap")
        elif args[:5] == ["-t", "-f", "CHAN,SIGNAL", "device", "wifi"]:
            sys.stdout.write(read("scan"))
        elif args == ["connection", "up", "questix-ap"]:
            if os.path.exists(os.path.join(state, "fail_up")):
                print("Error: Connection activation failed.", file=sys.stderr)
                sys.exit(4)
            open(active, "w").close()
        elif args == ["connection", "down", "questix-ap"]:
            if os.path.exists(active):
                os.remove(active)
        elif args == ["connection", "reload"]:
            pass
        else:
            sys.exit(2)
    elif name == "ip":
        sys.stdout.write(read("routes"))
    elif name == "iw":
        pass
''')


class Kit:
    """A temporary robot: settings directory, NetworkManager directory, fake tools."""

    def __init__(self, root: Path):
        self.root = root
        self.config = root / "etc_questix_robot"
        self.nm = root / "system-connections"
        self.modprobe = root / "modprobe.d"
        self.state = root / "state"
        self.bin = root / "bin"
        self.sys_net = root / "sys_net"
        for path in (self.config, self.nm, self.modprobe, self.state, self.bin, self.sys_net / "wlan0"):
            path.mkdir(parents=True)
        self.config.chmod(0o755)
        (self.sys_net / "wlan0" / "address").write_text("dc:a6:32:12:3f:2a\n")
        for tool in ("nmcli", "iw", "ip"):
            path = self.bin / tool
            path.write_text(FAKE_TOOL.format(state=str(self.state)))
            path.chmod(0o755)
        self.paths = na.Paths(
            config_dir=str(self.config), keyfile=str(self.nm / "questix-ap.nmconnection"),
            regdom=str(self.modprobe / "questix-wifi-regdom.conf"), sys_net=str(self.sys_net),
            lock=str(root / "lock"), tool_path=f"{self.bin}:/usr/bin:/bin",
            # The files this test writes belong to the test's user; the service trusts root only.
            trusted_uids={os.geteuid()})

    @property
    def keyfile(self) -> Path:
        return self.nm / "questix-ap.nmconnection"

    @property
    def settings(self) -> Path:
        return self.config / "wifi_ap.env"

    def request(self, action, settings=None, **extra):
        body = {"version": 1, "id": "0" * 31 + "1", "action": action, "settings": settings or {}}
        body.update(extra)
        path = self.config / na.REQUEST_NAME
        path.write_text(json.dumps(body))
        path.chmod(0o600)
        return path

    def run(self, action=None, settings=None, **extra):
        if action is not None:
            self.request(action, settings, **extra)
        code = na.Helper(self.paths).main()
        return code, json.loads((self.config / na.STATUS_NAME).read_text())

    def calls(self):
        try:
            lines = (self.state / "calls").read_text().splitlines()
        except FileNotFoundError:
            return []
        return [json.loads(line) for line in lines]

    def reset_calls(self):
        (self.state / "calls").unlink(missing_ok=True)

    def saved(self):
        return na.parse_settings(self.settings.read_text())


@pytest.fixture
def kit(tmp_path):
    return Kit(tmp_path)


def nm_calls(kit):
    return [c for c in kit.calls() if c[0] == "nmcli" and c[1] == "connection"]


def test_first_start_creates_the_access_point_like_the_role(kit, capsys):
    code, status = kit.run("start")
    assert code == 0
    assert status["state"] == "succeeded" and status["code"] == "started"
    saved = kit.saved()
    assert saved["state"] == "up"
    assert saved["ssid"] == "QUESTiX-3F2A"  # last 4 hex digits of the Wi-Fi MAC address
    assert re.fullmatch(f"[{na.PASSWORD_CHARACTERS}]{{12}}", saved["password"])
    assert saved["country"] == "JP" and saved["address"] == "10.42.0.1/24"
    assert int(saved["channel"]) in na.CHANNELS["bg"]
    keyfile = kit.keyfile.read_text()
    assert "autoconnect=true\n" in keyfile and "method=shared\n" in keyfile
    assert f"psk={saved['password']}\n" in keyfile
    assert stat.S_IMODE(kit.keyfile.stat().st_mode) == 0o600
    assert stat.S_IMODE(kit.settings.stat().st_mode) == 0o640
    assert "ieee80211_regdom=JP" in (kit.modprobe / "questix-wifi-regdom.conf").read_text()
    assert ["iw", "reg", "set", "JP"] in kit.calls()
    # Reload before up, up last.
    assert nm_calls(kit)[-2:] == [["nmcli", "connection", "reload"], ["nmcli", "connection", "up", "questix-ap"]]
    # The request is read once and removed; the password is nowhere but in the two files.
    assert not (kit.config / na.REQUEST_NAME).exists()
    assert saved["password"] not in json.dumps(kit.calls())
    assert saved["password"] not in json.dumps(status)
    assert saved["password"] not in capsys.readouterr().err


def test_start_again_changes_nothing(kit):
    kit.run("start")
    before = kit.keyfile.read_bytes(), kit.settings.read_text()
    kit.reset_calls()
    code, status = kit.run("start")
    assert code == 0 and status["code"] == "started"
    assert nm_calls(kit) == []  # already active with the same profile: no reload, no up
    assert (kit.keyfile.read_bytes(), kit.settings.read_text()) == before


def test_stop_keeps_the_profile_and_hands_over_to_client_profiles(kit):
    kit.run("start")
    kit.reset_calls()
    code, status = kit.run("stop")
    assert code == 0 and status["code"] == "stopped"
    assert kit.keyfile.exists()  # never deleted from the UI
    assert "autoconnect=false\n" in kit.keyfile.read_text()
    assert kit.saved()["state"] == "down"
    assert nm_calls(kit) == [["nmcli", "connection", "down", "questix-ap"],
                             ["nmcli", "connection", "reload"]]
    kit.reset_calls()
    assert kit.run("stop")[0] == 0
    assert nm_calls(kit) == []  # stopping twice does nothing more


def test_stop_without_settings_is_refused(kit):
    code, status = kit.run("stop")
    assert code == 1 and status["code"] == "not_configured"
    assert not kit.keyfile.exists()


def test_configure_while_on_applies_and_keeps_unset_values(kit):
    kit.run("start")
    password = kit.saved()["password"]
    kit.reset_calls()
    code, status = kit.run("configure", {"ssid": "QUESTiX Room 3", "channel": 11})
    assert code == 0 and status["code"] == "configured_applied"
    saved = kit.saved()
    assert saved["ssid"] == "QUESTiX Room 3" and saved["channel"] == "11"
    assert saved["password"] == password
    assert ["nmcli", "connection", "up", "questix-ap"] in kit.calls()


def test_configure_while_off_only_saves(kit):
    kit.run("start")
    kit.run("stop")
    kit.reset_calls()
    code, status = kit.run("configure", {"password": "new-pass;word"})
    assert code == 0 and status["code"] == "configured"
    assert kit.saved()["password"] == "new-pass;word"
    assert ["nmcli", "connection", "up", "questix-ap"] not in kit.calls()
    assert "new-pass;word" not in json.dumps(kit.calls())


def test_band_change_picks_a_channel_of_the_new_band(kit):
    kit.run("start")
    (kit.state / "scan").write_text("36:90\n40:80\n44:10\n")
    code, _ = kit.run("configure", {"band": "a"})
    assert code == 0
    assert kit.saved()["band"] == "a" and kit.saved()["channel"] == "48"


def test_channel_of_the_other_band_is_refused(kit):
    kit.run("start")
    before = kit.keyfile.read_bytes()
    code, status = kit.run("configure", {"channel": 36})
    assert code == 1 and status["code"] == "invalid_settings"
    assert kit.keyfile.read_bytes() == before


def test_auto_channel_avoids_crowded_ones(kit):
    (kit.state / "scan").write_text("1:80\n2:40\n6:70\n11:5\n")
    kit.run("start")
    assert kit.saved()["channel"] == "11"


def test_regenerate_password_applies_a_new_one(kit):
    kit.run("start")
    old = kit.saved()["password"]
    kit.reset_calls()
    code, status = kit.run("regenerate_password")
    assert code == 0 and status["code"] == "password_regenerated"
    new = kit.saved()["password"]
    assert new != old and na.valid_password(new)
    assert f"psk={new}\n" in kit.keyfile.read_text()
    assert ["nmcli", "connection", "up", "questix-ap"] in kit.calls()


def test_address_conflict_moves_to_a_free_range(kit):
    (kit.state / "routes").write_text("10.42.0.0/24 dev eth0 proto kernel scope link src 10.42.0.5\n"
                                      "default via 192.168.1.1 dev eth0\n")
    kit.run("start")
    assert kit.saved()["address"] == "10.43.0.1/24"


def test_explicit_address_conflict_is_refused(kit):
    (kit.state / "routes").write_text("192.168.50.0/24 dev eth0 proto kernel scope link\n")
    code, status = kit.run("configure", {"address": "192.168.50.1/24"})
    assert code == 1 and status["code"] == "address_conflict"
    assert not kit.keyfile.exists()


def test_own_interface_route_is_not_a_conflict(kit):
    (kit.state / "routes").write_text("10.42.0.0/24 dev wlan0 proto kernel scope link\n")
    kit.run("start")
    assert kit.saved()["address"] == "10.42.0.1/24"


@pytest.mark.parametrize("body", [
    {"version": 1, "id": "0" * 32, "action": "start", "command": "reboot"},
    {"version": 1, "id": "0" * 32, "action": "remove"},
    {"version": 1, "id": "0" * 32, "action": "shell"},
    {"version": 2, "id": "0" * 32, "action": "start"},
    {"version": 1, "id": "../x", "action": "start"},
    {"version": 1, "id": "0" * 32, "action": "configure", "settings": {"interface": "eth0"}},
    {"version": 1, "id": "0" * 32, "action": "configure", "settings": {"path": "/etc/shadow"}},
    {"version": 1, "id": "0" * 32, "action": "start", "settings": {"ssid": "QUESTiX-1"}},
    [1, 2, 3],
])
def test_unknown_requests_are_refused_without_changes(kit, body):
    (kit.config / na.REQUEST_NAME).write_text(json.dumps(body))
    code, status = kit.run()
    assert code == 1 and status["code"] == "bad_request"
    assert not kit.keyfile.exists() and not kit.settings.exists()
    assert nm_calls(kit) == []


@pytest.mark.parametrize("settings", [
    {"ssid": " leading"}, {"ssid": "x"}, {"ssid": "a" * 33}, {"ssid": "semi;colon"},
    {"ssid": "QUESTiX\nX"}, {"password": "short"}, {"password": "has space1"},
    {"password": "back\\slash"}, {"password": ""}, {"password": "x" * 64}, {"band": "ac"},
    {"channel": 13}, {"channel": True}, {"channel": "6"}, {"address": "8.8.8.1/24"},
    {"address": "10.42.0.0/24"}, {"address": "10.42.0.1/8"}, {"address": "10.42.0.1"},
])
def test_invalid_values_are_refused(kit, settings):
    code, status = kit.run("configure", settings)
    assert code == 1 and status["code"] == "invalid_settings"
    assert not kit.keyfile.exists()


def test_symlinked_request_is_not_followed(kit):
    target = kit.root / "elsewhere.json"
    target.write_text(json.dumps({"version": 1, "id": "0" * 32, "action": "start"}))
    (kit.config / na.REQUEST_NAME).symlink_to(target)
    code, status = kit.run()
    assert code == 1 and status["code"] == "bad_request"
    assert not kit.keyfile.exists()


def test_oversized_request_is_refused(kit):
    (kit.config / na.REQUEST_NAME).write_text(" " * (na.MAX_REQUEST_BYTES + 1))
    assert kit.run()[1]["code"] == "bad_request"


@pytest.mark.skipif(os.geteuid() != 0, reason="needs root to give the request another owner")
def test_request_of_another_user_is_refused(kit):
    path = kit.request("start")
    os.chown(path, 4242, 4242)
    os.chown(kit.config, 1000, 1000)
    assert kit.run()[1]["code"] == "bad_request"
    assert not kit.keyfile.exists()


def test_group_writable_settings_directory_is_refused(kit):
    kit.request("start")
    kit.config.chmod(0o775)
    assert na.Helper(kit.paths).main() == 1
    assert not kit.keyfile.exists()


def test_symlinked_status_file_is_replaced_not_followed(kit):
    victim = kit.root / "victim"
    victim.write_text("keep")
    (kit.config / na.STATUS_NAME).symlink_to(victim)
    kit.run("start")
    assert victim.read_text() == "keep"
    assert not (kit.config / na.STATUS_NAME).is_symlink()


def test_up_failure_keeps_the_profile_and_reports_safely(kit, capsys):
    (kit.state / "fail_up").touch()
    code, status = kit.run("start")
    assert code == 1 and status["state"] == "failed" and status["code"] == "ap_up_failed"
    assert status["message"] == na.MESSAGES["ap_up_failed"]
    assert kit.keyfile.exists()  # never removed because the start failed
    password = kit.saved()["password"]
    assert password not in json.dumps(status) and password not in capsys.readouterr().err


def test_networkmanager_not_running_changes_nothing(kit):
    (kit.state / "nm_running").write_text("stopped\n")
    code, status = kit.run("start")
    assert code == 1 and status["code"] == "networkmanager_not_running"
    assert not kit.keyfile.exists() and not kit.settings.exists()


def test_missing_nmcli_is_reported(kit):
    (kit.bin / "nmcli").unlink()
    kit.paths.tool_path = str(kit.bin)
    code, status = kit.run("start")
    assert code == 1 and status["code"] == "networkmanager_missing"
    assert not kit.keyfile.exists()


def test_missing_wifi_interface_is_reported(kit):
    (kit.sys_net / "wlan0" / "address").unlink()
    (kit.sys_net / "wlan0").rmdir()
    assert kit.run("start")[1]["code"] == "no_interface"


def test_a_second_run_at_the_same_time_is_refused(kit):
    kit.request("start")
    with open(kit.paths.lock, "w") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        code, status = kit.run()
    assert code == 1 and status["code"] == "busy"
    assert not kit.keyfile.exists()


ROLE_SETTINGS = (
    "# Ansible managed\n"
    "WIFI_AP_STATE=up\nWIFI_AP_INTERFACE=wlan1\nWIFI_AP_SSID='QUESTiX 3F2A'\n"
    "WIFI_AP_PASSWORD=abcdefgh1\nWIFI_AP_BAND=bg\nWIFI_AP_CHANNEL=6\n"
    "WIFI_AP_COUNTRY=US\nWIFI_AP_ADDRESS=10.42.0.1/24\n")


def trusted_settings(kit, mode=0o640):
    (kit.sys_net / "wlan1").mkdir()
    kit.settings.write_text(ROLE_SETTINGS)
    kit.settings.chmod(mode)


def test_root_settings_keep_cli_interface_and_country(kit):
    # `wifi-ap.sh up --interface wlan1 --country US` (root): inherited, never changed by the API.
    trusted_settings(kit)
    code, _ = kit.run("configure", {"ssid": "QUESTiX Room 3"})
    assert code == 0
    saved = kit.saved()
    assert saved["interface"] == "wlan1" and saved["country"] == "US"
    assert "interface-name=wlan1\n" in kit.keyfile.read_text()
    assert ["iw", "reg", "set", "US"] in kit.calls()


def test_settings_of_another_owner_are_not_trusted(kit):
    # The robot user owns the directory and could replace the root file with its own.
    trusted_settings(kit)
    kit.paths.trusted_uids = frozenset({os.geteuid() + 1})
    code, status = kit.run("start")
    assert code == 1 and status["code"] == "settings_untrusted"
    assert not kit.keyfile.exists() and nm_calls(kit) == []
    assert "wlan1" not in json.dumps(kit.calls())


@pytest.mark.parametrize("mode", [0o660, 0o642, 0o646, 0o666])
def test_writable_settings_are_not_trusted(kit, mode):
    trusted_settings(kit, mode)
    code, status = kit.run("start")
    assert code == 1 and status["code"] == "settings_untrusted"
    assert not kit.keyfile.exists()


def test_symlinked_settings_are_not_trusted(kit):
    real = kit.root / "real.env"
    real.write_text(ROLE_SETTINGS)
    real.chmod(0o640)
    kit.settings.symlink_to(real)
    assert kit.run("start")[1]["code"] == "settings_untrusted"
    assert not kit.keyfile.exists()


def test_hard_linked_settings_are_not_trusted(kit):
    trusted_settings(kit)
    os.link(kit.settings, kit.root / "second-link")
    assert kit.run("start")[1]["code"] == "settings_untrusted"


def test_the_service_trusts_root_only():
    assert na.Paths().trusted_uids == frozenset({0})
    assert na.Paths().lock == "/run/questix_network_admin/lock"


@pytest.mark.skipif(os.geteuid() != 0, reason="needs root to give the settings file another owner")
def test_settings_owned_by_the_robot_user_are_refused_by_default_paths(kit):
    trusted_settings(kit)
    os.chown(kit.settings, 4242, 4242)
    kit.paths.trusted_uids = na.TRUSTED_SETTINGS_UIDS
    assert kit.run("start")[1]["code"] == "settings_untrusted"


def test_settings_written_by_the_role_are_read_as_data(kit):
    kit.settings.write_text(
        "# Ansible managed\n"
        "WIFI_AP_STATE=up\nWIFI_AP_INTERFACE=wlan0\nWIFI_AP_SSID='QUESTiX 3F2A'\n"
        "WIFI_AP_PASSWORD='ab\"c'\"'\"'d;e:f'\nWIFI_AP_BAND=bg\nWIFI_AP_CHANNEL=6\n"
        "WIFI_AP_COUNTRY=JP\nWIFI_AP_ADDRESS=10.42.0.1/24\n")
    code, _ = kit.run("configure", {"channel": 1})
    assert code == 0
    saved = kit.saved()
    assert saved["password"] == "ab\"c'd;e:f" and saved["ssid"] == "QUESTiX 3F2A"
    assert saved["channel"] == "1"


def test_settings_that_are_shell_code_are_refused(kit):
    marker = kit.root / "pwned"
    kit.settings.write_text(f"WIFI_AP_STATE=up\nWIFI_AP_SSID=\"$(touch {marker})\"\n"
                            "WIFI_AP_PASSWORD=abcdefgh1\nWIFI_AP_CHANNEL=6\n")
    code, status = kit.run("start")
    assert code == 1 and status["code"] == "settings_unreadable"
    assert not marker.exists() and not kit.keyfile.exists()


def test_render_round_trip_is_stable():
    settings = {"state": "up", "interface": "wlan0", "ssid": "QUESTiX 3F2A",
                "password": "ab\"c'd;e:f", "band": "bg", "channel": 6, "country": "JP",
                "address": "10.42.0.1/24"}
    parsed = na.parse_settings(na.render_settings(settings))
    assert parsed == {k: str(v) for k, v in settings.items()}


def test_connection_uuid_matches_ansible_to_uuid():
    core = pytest.importorskip("ansible.plugins.filter.core")
    assert na.connection_uuid() == core.to_uuid("questix-ap")


def test_command_line_accepts_only_apply():
    assert na.main(["questix_network_admin.py"]) == 2
    assert na.main(["questix_network_admin.py", "apply", "--config", "/tmp/x"]) == 2


def test_validation_matches_the_role_assert():
    tasks = (Path(__file__).resolve().parents[2]
             / "ansible/roles/wifi_access_point/tasks/main.yaml").read_text()
    assert f"wifi_ap_ssid is match('{na.SSID_PATTERN}')" in tasks
    assert f"wifi_ap_password is match('{na.PASSWORD_PATTERN}')" in tasks
    assert f"wifi_ap_country is match('{na.COUNTRY_PATTERN}')" in tasks
    script = (Path(__file__).resolve().parents[1] / "wifi-ap.sh").read_text()
    assert "echo 36 40 44 48; else echo 1 6 11" in script
    assert na.CHANNELS == {"bg": (1, 6, 11), "a": (36, 40, 44, 48)}
    assert "PASSWORD_LENGTH=12" in script and "PASSWORD_CHARACTERS='A-HJ-NP-Za-km-z2-9'" in script


def test_no_shell_anywhere():
    here = Path(__file__).resolve().parent
    for name in ("network_admin.py", "wifi_ap.py"):
        source = (here / name).read_text()
        assert "shell=True" not in source
        assert "os.system" not in source and "os.popen" not in source
