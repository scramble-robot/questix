#!/usr/bin/env python3
"""QUESTiX Local: the root helper that applies Robot Manager's access point requests.

Robot Manager runs as the robot's login user and never changes the network itself. For the
管理設定 card 「ネットワーク / QUESTiX Local」 it writes one JSON request to
``/etc/questix_robot/network_request.json`` and starts ``questix_network_admin.service``, the only
unit polkit lets that user start for this (``50-questix-robot.rules``). The service runs a root-owned
copy of this file (``/opt/questix_robot/questix_network_admin.py``, installed by
``scripts/update-robot-manager.sh``, ``scripts/install-robot-manager.sh`` and the Ansible
``robot_autostart`` role), which:

- reads the request once (no symlink, a regular file of the settings directory's owner, at most
  4 KiB), removes it, and accepts only the actions and keys listed here, validated again;
- reads the saved settings (``wifi_ap.env``) as data, never as shell code, and validates them too;
- writes the same three files as the ``wifi_access_point`` role (NetworkManager keyfile, settings,
  regulatory domain; ``ansible/tests/run_contract_tests.sh`` renders the role's templates and
  compares them with ``render_*`` below) and applies them with the role's nmcli/iw steps;
- runs every tool as an argument list with a fixed PATH (never a shell); the passphrase goes only
  into the root-only keyfile and the settings file, never into a command line, a log or the
  status file Robot Manager reads back (``network_status.json``).

It takes no path, command or interface from the request. It never deletes the profile (the
``remove`` of ``scripts/wifi-ap.sh`` stays a CLI task) and knows nothing about QUESTiX LAB: Robot
Manager starts the bridge itself after a successful start. Standard library only: it runs with
``python3 -I`` outside the installed package.
"""

import fcntl
import ipaddress
import json
import os
import re
import secrets
import shlex
import socket
import stat
import subprocess
import sys
import time
import uuid

# ---------------------------------------------------------------------------
# Validation shared with robot_manager/wifi_ap.py (it imports these) and with the role's assert
# (ansible/roles/wifi_access_point/tasks/main.yaml); the contract test keeps them identical.
# ---------------------------------------------------------------------------

SSID_PATTERN = r"^[A-Za-z0-9_.-][A-Za-z0-9 _.-]{0,30}[A-Za-z0-9_.-]$"
# Printable ASCII without spaces or backslashes: the keyfile would reinterpret those.
PASSWORD_PATTERN = r"^[!-\[\]-~]{8,63}$"
COUNTRY_PATTERN = r"^[A-Z]{2}$"
INTERFACE_PATTERN = r"^[A-Za-z0-9_-]{1,15}$"
SSID_RE = re.compile(SSID_PATTERN)
PASSWORD_RE = re.compile(PASSWORD_PATTERN)
COUNTRY_RE = re.compile(COUNTRY_PATTERN)
INTERFACE_RE = re.compile(INTERFACE_PATTERN)
# Channels that do not overlap. 5 GHz: W52 only, which Japan allows indoors without radar
# detection (DFS), which a Pi access point does not do. Same lists as scripts/wifi-ap.sh.
CHANNELS = {"bg": (1, 6, 11), "a": (36, 40, 44, 48)}
STATES = ("up", "down")
ACTIONS = ("start", "stop", "configure", "regenerate_password")
SETTING_KEYS = ("ssid", "password", "band", "channel", "address")
REQUEST_KEYS = ("version", "id", "action", "settings")
REQUEST_ID_RE = re.compile(r"^[0-9a-f]{32}$")
DEFAULT_ADDRESS = "10.42.0.1/24"
DEFAULT_INTERFACE = "wlan0"
DEFAULT_COUNTRY = "JP"
CONNECTION_NAME = "questix-ap"
PASSWORD_LENGTH = 12
# No 0/O, 1/l/I: the password is read off a screen and typed on a phone (scripts/wifi-ap.sh).
PASSWORD_CHARACTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
MAX_REQUEST_BYTES = 4096
MAX_SETTINGS_BYTES = 8192

# Ansible's to_uuid filter: uuid5 in this namespace (the keyfile's uuid must stay the same).
ANSIBLE_UUID_NAMESPACE = uuid.UUID("361E6D51-FAEC-444A-9079-341386DA8E2E")

# Fixed locations (never taken from the request or the environment).
CONFIG_DIR = "/etc/questix_robot"
REQUEST_NAME = "network_request.json"
STATUS_NAME = "network_status.json"
SETTINGS_NAME = "wifi_ap.env"
KEYFILE_PATH = "/etc/NetworkManager/system-connections/questix-ap.nmconnection"
REGDOM_PATH = "/etc/modprobe.d/questix-wifi-regdom.conf"
SYS_NET = "/sys/class/net"
LOCK_PATH = "/run/questix_network_admin.lock"
TOOL_PATH = "/usr/sbin:/usr/bin:/sbin:/bin"
COMMAND_TIMEOUT_SEC = 60

# What Robot Manager shows for each result code (no secret, no tool output).
MESSAGES = {
    "started": "QUESTiX Local を開始しました。",
    "stopped": "QUESTiX Local を停止しました。保存済みの Wi-Fi があれば自動で接続します。",
    "configured": "設定を保存しました。",
    "configured_applied": "設定を保存し、QUESTiX Local に反映しました。",
    "password_regenerated": "新しいパスワードにしました。接続中の端末はつなぎ直してください。",
    "bad_request": "要求の形式が正しくありません。",
    "invalid_settings": "設定の値が正しくありません。",
    "settings_unreadable": "保存されている設定を読み取れません（sudo scripts/wifi-ap.sh status で確認してください）。",
    "not_configured": "QUESTiX Local はまだ設定されていません。",
    "address_conflict": "指定したアドレスは、このロボットの別のネットワークと重なっています。",
    "no_free_address": "空いているアドレスが見つかりません。詳細設定でアドレスを指定してください。",
    "no_interface": "Wi-Fi の装置が見つかりません。",
    "networkmanager_missing": "NetworkManager が見つかりません。",
    "networkmanager_not_running": "NetworkManager が動いていません。",
    "apply_failed": "設定を書き込めませんでした。",
    "ap_up_failed": "QUESTiX Local を開始できませんでした（設定は保存済みです）。",
    "ap_down_failed": "QUESTiX Local を停止できませんでした。",
    "busy": "ほかの切り替えが実行中です。",
}


class AdminError(Exception):
    """A refused or failed request; ``code`` is a key of MESSAGES."""

    def __init__(self, code, log=""):
        super().__init__(code)
        self.code = code
        self.log = log


def log(message):
    """Write one line to the journal (the service's stderr). Never pass a secret."""
    print(message, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def valid_ssid(value):
    return isinstance(value, str) and bool(SSID_RE.fullmatch(value)) and len(value.encode()) <= 32


def valid_password(value):
    return isinstance(value, str) and bool(PASSWORD_RE.fullmatch(value))


def parse_address(value):
    """Return the IPv4 interface for a robot address such as 10.42.0.1/24, or None.

    Stricter than the role's pattern: a private IPv4 host address (not the network or broadcast
    address) with a /16../30 prefix, so that DHCP clients have room.
    """
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}", value):
        return None
    try:
        interface = ipaddress.IPv4Interface(value)
    except ValueError:
        return None
    network = interface.network
    if not 16 <= network.prefixlen <= 30 or not interface.ip.is_private:
        return None
    if interface.ip in (network.network_address, network.broadcast_address):
        return None
    return interface


def valid_channel(value, band):
    return isinstance(value, int) and not isinstance(value, bool) and value in CHANNELS.get(band, ())


def validate_request(data):
    """Return (id, action, settings) of a parsed request, or raise AdminError('bad_request').

    Unknown keys, types and values are refused; every setting is optional (unset = keep).
    """
    if not isinstance(data, dict) or set(data) - set(REQUEST_KEYS):
        raise AdminError("bad_request", "unknown request keys")
    if data.get("version") != 1:
        raise AdminError("bad_request", "unsupported request version")
    request_id = data.get("id")
    if not isinstance(request_id, str) or not REQUEST_ID_RE.fullmatch(request_id):
        raise AdminError("bad_request", "bad request id")
    action = data.get("action")
    if action not in ACTIONS:
        raise AdminError("bad_request", "unknown action")
    settings = data.get("settings", {})
    if not isinstance(settings, dict) or set(settings) - set(SETTING_KEYS):
        raise AdminError("bad_request", "unknown setting keys")
    if action != "configure" and settings:
        raise AdminError("bad_request", "settings are only for configure")
    if "ssid" in settings and not valid_ssid(settings["ssid"]):
        raise AdminError("invalid_settings", "ssid")
    if "password" in settings and not valid_password(settings["password"]):
        raise AdminError("invalid_settings", "password")
    if "band" in settings and settings["band"] not in CHANNELS:
        raise AdminError("invalid_settings", "band")
    if "channel" in settings:
        channel = settings["channel"]
        if channel != "auto" and not (isinstance(channel, int) and not isinstance(channel, bool)
                                      and any(channel in c for c in CHANNELS.values())):
            raise AdminError("invalid_settings", "channel")
    if "address" in settings and settings["address"] != "auto" and parse_address(settings["address"]) is None:
        raise AdminError("invalid_settings", "address")
    return request_id, action, settings


def validate_saved(values):
    """Check settings read from wifi_ap.env; raise AdminError('settings_unreadable') if unusable.

    The file is in a directory the robot user owns, so its contents are treated like a request:
    anything the API could not have set is refused.
    """
    if values["state"] not in STATES:
        raise AdminError("settings_unreadable", "state")
    if not INTERFACE_RE.fullmatch(values["interface"]):
        raise AdminError("settings_unreadable", "interface")
    if not valid_ssid(values["ssid"]):
        raise AdminError("settings_unreadable", "ssid")
    if not valid_password(values["password"]):
        raise AdminError("settings_unreadable", "password")
    if values["band"] not in CHANNELS:
        raise AdminError("settings_unreadable", "band")
    # A channel set with `wifi-ap.sh --channel N` may be outside the lists; keep it if sane.
    if not isinstance(values["channel"], int) or not 1 <= values["channel"] <= 196:
        raise AdminError("settings_unreadable", "channel")
    if not COUNTRY_RE.fullmatch(values["country"]):
        raise AdminError("settings_unreadable", "country")
    if parse_address(values["address"]) is None:
        raise AdminError("settings_unreadable", "address")


# ---------------------------------------------------------------------------
# Rendering: the same text as the wifi_access_point role's templates (contract-tested)
# ---------------------------------------------------------------------------

def connection_uuid():
    return str(uuid.uuid5(ANSIBLE_UUID_NAMESPACE, CONNECTION_NAME))


def render_keyfile(s):
    """templates/questix-ap.nmconnection.j2 without its first (ansible_managed) line."""
    return (
        "# NetworkManager keyfile of the QUESTiX access point (wifi_access_point role).\n"
        "# Change it with scripts/wifi-ap.sh or the role variables, not by hand.\n"
        "[connection]\n"
        f"id={CONNECTION_NAME}\n"
        f"uuid={connection_uuid()}\n"
        "type=wifi\n"
        f"interface-name={s['interface']}\n"
        f"autoconnect={'true' if s['state'] == 'up' else 'false'}\n"
        "# Wins over saved Wi-Fi client profiles at boot while the access point is on.\n"
        "autoconnect-priority=100\n"
        "\n"
        "[wifi]\n"
        "mode=ap\n"
        f"ssid={s['ssid']}\n"
        f"band={s['band']}\n"
        f"channel={s['channel']}\n"
        "# 2 = disable power saving: keeps controller and camera latency low.\n"
        "powersave=2\n"
        "\n"
        "[wifi-security]\n"
        "key-mgmt=wpa-psk\n"
        "# WPA2/CCMP only. The Pi's brcmfmac firmware does not handle TKIP or PMF reliably in AP mode.\n"
        "proto=rsn\n"
        "pairwise=ccmp\n"
        "group=ccmp\n"
        "pmf=1\n"
        f"psk={s['password']}\n"
        "\n"
        "[ipv4]\n"
        "method=shared\n"
        f"address1={s['address']}\n"
        "\n"
        "[ipv6]\n"
        "method=disabled\n"
    )


def render_settings(s):
    """templates/wifi_ap.env.j2 without its first (ansible_managed) line; `quote` = shlex.quote."""
    lines = ["# Current access point settings, read by scripts/wifi-ap.sh (wifi_access_point role)."]
    for key in ("state", "interface", "ssid", "password", "band", "channel", "country", "address"):
        lines.append(f"WIFI_AP_{key.upper()}={shlex.quote(str(s[key]))}")
    return "\n".join(lines) + "\n"


def render_regdom(s):
    return (
        "# Managed by the wifi_access_point role.\n"
        f"options cfg80211 ieee80211_regdom={s['country']}\n"
    )


HEADER = "# Managed by questix_network_admin (Robot Manager); same content as the wifi_access_point role.\n"


def parse_settings(text):
    """Values of a wifi_ap.env (shell-quoted by the role or by render_settings), as data."""
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("WIFI_AP_") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        try:
            words = shlex.split(value)
        except ValueError:
            raise AdminError("settings_unreadable", "quoting")
        if len(words) > 1:
            raise AdminError("settings_unreadable", "value")
        values[key.removeprefix("WIFI_AP_").lower()] = words[0] if words else ""
    return values


# ---------------------------------------------------------------------------
# Files: never follow a link in the robot user's directory, always replace atomically
# ---------------------------------------------------------------------------

def _open_dir(path):
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)


def read_private_file(dir_fd, name, limit, owners=None):
    """Return the bytes of a regular file in dir_fd, or None when it does not exist.

    No symlink (O_NOFOLLOW), one link only, at most ``limit`` bytes, and owned by one of
    ``owners`` when given.
    """
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dir_fd)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise AdminError("bad_request", f"cannot open {name}: {error.strerror}")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise AdminError("bad_request", f"{name} is not a small regular file")
        if owners is not None and info.st_uid not in owners:
            raise AdminError("bad_request", f"{name} has an unexpected owner")
        data = os.read(fd, limit + 1)
        if len(data) > limit:
            raise AdminError("bad_request", f"{name} is too large")
        return data
    finally:
        os.close(fd)


def write_atomic(dir_fd, name, data, mode, gid=0):
    """Replace dir_fd/name with data: a new file (O_EXCL, no link followed), then rename."""
    temp = f".{name}.{secrets.token_hex(8)}.tmp"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600,
                 dir_fd=dir_fd)
    try:
        if os.geteuid() == 0:
            os.fchown(fd, 0, gid)
        os.fchmod(fd, mode)
        os.write(fd, data.encode())
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        os.unlink(temp, dir_fd=dir_fd)
        raise
    os.close(fd)
    os.rename(temp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)


def _body(text):
    """Return a managed file without its first (header) line: the header differs by writer."""
    return text.split("\n", 1)[1] if "\n" in text else ""


class Paths:
    """Where the helper reads and writes. The service always uses the defaults (tests do not)."""

    def __init__(self, config_dir=CONFIG_DIR, keyfile=KEYFILE_PATH, regdom=REGDOM_PATH,
                 sys_net=SYS_NET, lock=LOCK_PATH, tool_path=TOOL_PATH):
        self.config_dir = config_dir
        self.keyfile = keyfile
        self.regdom = regdom
        self.sys_net = sys_net
        self.lock = lock
        self.tool_path = tool_path


class Helper:
    """One run of the service: read the request, apply it, write the status."""

    def __init__(self, paths=None):
        self.paths = paths or Paths()
        self.secrets = []

    # --- tools ---------------------------------------------------------------

    def run(self, argv, check=True):
        """Run a tool as an argument list (no shell) with a fixed PATH; return the result."""
        env = {"PATH": self.paths.tool_path, "LC_ALL": "C"}
        try:
            result = subprocess.run(argv, capture_output=True, text=True, env=env,
                                    timeout=COMMAND_TIMEOUT_SEC, check=False, shell=False)
        except FileNotFoundError:
            if argv[0] == "nmcli":
                raise AdminError("networkmanager_missing", "nmcli not found")
            raise AdminError("apply_failed", f"{argv[0]} not found")
        except subprocess.TimeoutExpired:
            raise AdminError("apply_failed", f"{argv[0]} {argv[1] if len(argv) > 1 else ''} timed out")
        if check and result.returncode != 0:
            log(f"{' '.join(argv[:3])}: exit {result.returncode}: {self.redact(result.stderr)[:300]}")
        return result

    def redact(self, text):
        for secret in self.secrets:
            if secret:
                text = text.replace(secret, "********")
        return text.strip()

    def nm_running(self):
        result = self.run(["nmcli", "-t", "-f", "RUNNING", "general"], check=False)
        return result.returncode == 0 and result.stdout.strip() == "running"

    def active(self):
        result = self.run(["nmcli", "-t", "-f", "NAME", "connection", "show", "--active"])
        return CONNECTION_NAME in result.stdout.splitlines()

    def mac_suffix(self, interface):
        try:
            with open(os.path.join(self.paths.sys_net, interface, "address")) as file:
                mac = file.read().strip().replace(":", "")
        except OSError:
            return ""
        return mac[-4:].upper() if re.fullmatch(r"[0-9a-fA-F]{12}", mac) else ""

    def interface_exists(self, interface):
        return os.path.isdir(os.path.join(self.paths.sys_net, interface))

    def default_ssid(self, interface):
        suffix = self.mac_suffix(interface)
        if not suffix:
            host = re.sub(r"[^A-Za-z0-9_.-]", "", socket.gethostname().split(".")[0])[:20]
            suffix = host or "robot"
        return f"QUESTiX-{suffix}"

    def pick_channel(self, band, interface):
        """Return the least crowded channel around this robot (wifi-ap.sh pick_channel)."""
        candidates = CHANNELS[band]
        suffix = self.mac_suffix(interface)
        offset = int(suffix, 16) % len(candidates) if suffix else 0
        result = self.run(["nmcli", "-t", "-f", "CHAN,SIGNAL", "device", "wifi", "list",
                           "ifname", interface, "--rescan", "yes"], check=False)
        scan = []
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                parts = line.split(":")
                if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                    scan.append((int(parts[0]), int(parts[1])))
        overlap = 5 if band == "bg" else 1
        best, best_load = None, None
        for index in range(len(candidates)):
            channel = candidates[(index + offset) % len(candidates)]
            load = sum(signal for chan, signal in scan if abs(chan - channel) < overlap)
            if best is None or load < best_load:
                best, best_load = channel, load
        log(f"channel {best} ({'scanned' if scan else 'no scan, rotated by the MAC address'})")
        return best

    def other_routes(self, interface):
        """IPv4 routes of every interface except the access point (wifi-ap.sh other_ipv4_routes)."""
        result = self.run(["ip", "-4", "-o", "route", "show"], check=False)
        routes = []
        for line in result.stdout.splitlines():
            words = line.split()
            if not words or words[0] == "default":
                continue
            dev = words[words.index("dev") + 1] if "dev" in words[:-1] else ""
            if dev != interface:
                try:
                    routes.append(ipaddress.ip_network(words[0], strict=False))
                except ValueError:
                    pass
        return routes

    def choose_address(self, current, explicit, interface):
        """Keep the address unless another network overlaps it (wifi-ap.sh choose_address)."""
        routes = self.other_routes(interface)

        def conflict(address):
            network = ipaddress.IPv4Interface(address).network
            return any(network.overlaps(route) for route in routes if route.version == 4)

        if not conflict(current):
            return current
        if explicit:
            raise AdminError("address_conflict", current)
        for second in range(42, 62):
            candidate = f"10.{second}.0.1/24"
            if not conflict(candidate):
                log(f"address {current} overlaps another network; using {candidate}")
                return candidate
        raise AdminError("no_free_address")

    # --- settings ------------------------------------------------------------

    def load(self, dir_fd):
        """Return the saved settings, or None when the access point was never configured."""
        data = read_private_file(dir_fd, SETTINGS_NAME, MAX_SETTINGS_BYTES)
        if data is None:
            return None
        try:
            raw = parse_settings(data.decode())
        except UnicodeDecodeError:
            raise AdminError("settings_unreadable", "encoding")
        values = {
            "state": raw.get("state", "down"),
            "interface": raw.get("interface") or DEFAULT_INTERFACE,
            "ssid": raw.get("ssid", ""),
            "password": raw.get("password", ""),
            "band": raw.get("band") or "bg",
            "channel": raw.get("channel", ""),
            "country": raw.get("country") or DEFAULT_COUNTRY,
            "address": raw.get("address") or DEFAULT_ADDRESS,
        }
        values["channel"] = int(values["channel"]) if str(values["channel"]).isdigit() else None
        self.secrets.append(values["password"])
        validate_saved(values)
        return values

    def new_settings(self):
        return {"state": "down", "interface": DEFAULT_INTERFACE, "ssid": "", "password": "",
                "band": "bg", "channel": None, "country": DEFAULT_COUNTRY,
                "address": DEFAULT_ADDRESS}

    # --- actions -------------------------------------------------------------

    def prepare(self, action, settings, saved):
        """Return (new settings, whether the address was given explicitly)."""
        if action in ("stop", "regenerate_password") and saved is None:
            raise AdminError("not_configured")
        s = dict(saved) if saved else self.new_settings()
        explicit_address = False
        if not self.interface_exists(s["interface"]):
            raise AdminError("no_interface", s["interface"])
        if action == "start":
            s["state"] = "up"
        elif action == "stop":
            s["state"] = "down"
        elif action == "regenerate_password":
            s["password"] = ""
        elif action == "configure":
            if "ssid" in settings:
                s["ssid"] = settings["ssid"]
            if "password" in settings:
                s["password"] = settings["password"]
                self.secrets.append(s["password"])
            if "band" in settings and settings["band"] != s["band"]:
                s["band"] = settings["band"]
                s["channel"] = None  # the old channel is not in the new band
            if "channel" in settings:
                channel = settings["channel"]
                if channel == "auto":
                    s["channel"] = None
                elif valid_channel(channel, s["band"]):
                    s["channel"] = channel
                else:
                    raise AdminError("invalid_settings", "channel not in band")
            if "address" in settings:
                if settings["address"] == "auto":
                    s["address"] = DEFAULT_ADDRESS
                else:
                    s["address"] = settings["address"]
                    explicit_address = True
        if not s["ssid"]:
            s["ssid"] = self.default_ssid(s["interface"])
        if not s["password"]:
            s["password"] = "".join(secrets.choice(PASSWORD_CHARACTERS) for _ in range(PASSWORD_LENGTH))
            self.secrets.append(s["password"])
        if s["channel"] is None:
            s["channel"] = self.pick_channel(s["band"], s["interface"])
        if action != "stop":
            s["address"] = self.choose_address(s["address"], explicit_address, s["interface"])
        validate_saved(s)
        return s

    def write_files(self, dir_fd, s):
        """Write keyfile, settings and regulatory domain; return whether the keyfile changed."""
        keyfile_dir, keyfile_name = os.path.split(self.paths.keyfile)
        regdom_dir, regdom_name = os.path.split(self.paths.regdom)
        keyfile_text = render_keyfile(s)
        changed = False
        kfd = _open_dir(keyfile_dir)
        try:
            old = read_private_file(kfd, keyfile_name, 65536)
            if old is None or _body(old.decode(errors="replace")) != keyfile_text:
                write_atomic(kfd, keyfile_name, HEADER + keyfile_text, 0o600)
                changed = True
        finally:
            os.close(kfd)
        rfd = _open_dir(regdom_dir)
        try:
            old = read_private_file(rfd, regdom_name, 4096)
            if old is None or _body(old.decode(errors="replace")) != _body(render_regdom(s)):
                write_atomic(rfd, regdom_name, render_regdom(s), 0o644)
        finally:
            os.close(rfd)
        # Readable by the robot user (the directory's group) for the 教材 tab's QR code.
        group = os.fstat(dir_fd).st_gid
        write_atomic(dir_fd, SETTINGS_NAME, HEADER + render_settings(s), 0o640, gid=group)
        return changed

    def apply(self, dir_fd, s, was_active):
        """Apply the role's steps: regulatory domain, down, reload, up (up last)."""
        changed = self.write_files(dir_fd, s)
        if s["state"] == "up":
            if self.run(["iw", "reg", "set", s["country"]]).returncode != 0:
                log("iw reg set failed; the boot-time setting still applies")
        if s["state"] != "up" and was_active:
            if self.run(["nmcli", "connection", "down", CONNECTION_NAME]).returncode != 0:
                raise AdminError("ap_down_failed")
        if changed:
            if self.run(["nmcli", "connection", "reload"]).returncode != 0:
                raise AdminError("apply_failed", "nmcli connection reload failed")
        if s["state"] == "up" and (changed or not was_active):
            if self.run(["nmcli", "connection", "up", CONNECTION_NAME]).returncode != 0:
                raise AdminError("ap_up_failed")

    def handle(self, dir_fd, request_id, action, settings):
        saved = self.load(dir_fd)
        # NetworkManager first: without it nothing is written, so nothing changes at the next boot.
        if not self.nm_running():
            raise AdminError("networkmanager_not_running")
        was_active = self.active()
        s = self.prepare(action, settings, saved)
        self.apply(dir_fd, s, was_active)
        if action == "start":
            return "started"
        if action == "stop":
            return "stopped"
        if action == "regenerate_password":
            return "password_regenerated"
        return "configured_applied" if s["state"] == "up" else "configured"

    # --- one run -------------------------------------------------------------

    def write_status(self, dir_fd, request_id, action, state, code):
        status = {"id": request_id, "action": action, "state": state, "code": code,
                  "message": MESSAGES.get(code, ""), "finished_at": time.time()}
        write_atomic(dir_fd, STATUS_NAME, json.dumps(status, ensure_ascii=False) + "\n", 0o644)

    def take_request(self, dir_fd):
        """Read the request once and remove it; only the settings directory's owner may write it."""
        owner = os.fstat(dir_fd).st_uid
        data = read_private_file(dir_fd, REQUEST_NAME, MAX_REQUEST_BYTES, owners={owner, 0})
        if data is None:
            raise AdminError("bad_request", "no request")
        try:
            os.unlink(REQUEST_NAME, dir_fd=dir_fd)
        except FileNotFoundError:
            pass
        try:
            parsed = json.loads(data.decode())
        except (UnicodeDecodeError, ValueError):
            raise AdminError("bad_request", "request is not JSON")
        return validate_request(parsed)

    def main(self):
        """Apply the pending request; exit status 0 on success, 1 when it failed."""
        dir_info = os.lstat(self.paths.config_dir)
        if not stat.S_ISDIR(dir_info.st_mode) or dir_info.st_mode & 0o022:
            log(f"{self.paths.config_dir} must be a directory writable only by its owner")
            return 1
        dir_fd = _open_dir(self.paths.config_dir)
        lock = os.open(self.paths.lock, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        request_id, action = None, None
        try:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise AdminError("busy")
            request_id, action, settings = self.take_request(dir_fd)
            self.write_status(dir_fd, request_id, action, "running", "")
            code = self.handle(dir_fd, request_id, action, settings)
            log(f"{action}: {code}")
            self.write_status(dir_fd, request_id, action, "succeeded", code)
            return 0
        except AdminError as error:
            log(f"{action or 'request'} refused: {error.code}{': ' + self.redact(error.log) if error.log else ''}")
            self.write_status(dir_fd, request_id, action, "failed", error.code)
            return 1
        except OSError as error:
            log(f"{action or 'request'} failed: {error.strerror} ({error.filename})")
            self.write_status(dir_fd, request_id, action, "failed", "apply_failed")
            return 1
        finally:
            os.close(lock)
            os.close(dir_fd)


def main(argv):
    if argv[1:] != ["apply"]:
        print("usage: questix_network_admin.py apply", file=sys.stderr)
        return 2
    if os.geteuid() != 0:
        print("questix_network_admin.py runs as root from questix_network_admin.service", file=sys.stderr)
        return 2
    os.umask(0o077)
    return Helper().main()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
