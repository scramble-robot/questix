"""Tests for the custom image's first-boot enrollment (scripts/iso/questix-first-boot-enroll.sh).

The script runs with fake passwd, chpasswd, ssh-keygen, systemctl, id and date on its PATH and
its state directory in a temporary tree: no real account, password or SSH unit is touched.
Order that matters: password → host keys → SSH enabled → started → active → marker → the unit
disables itself. A failure anywhere before the marker locks the account again, disables and
stops SSH, and leaves no marker (the next boot asks again).
"""

import os
import subprocess
import textwrap
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
ENROLL = SCRIPTS / "iso" / "questix-first-boot-enroll.sh"
UNIT = SCRIPTS / "iso" / "questix-first-boot.service"
SECRET = "Robot-Pass-2026"

# Each call is logged; a file fail-<tool> or fail-<tool>-<first argument> makes it fail.
FAKE = textwrap.dedent('''\
    #!/bin/bash
    state={state}
    name=$(basename "$0")
    printf '%s\\n' "$(printf '%q ' "$name" "$@")" >> "$state/calls"
    if [ "$name" = chpasswd ]; then cat > "$state/chpasswd.stdin"; fi
    if [ -e "$state/fail-$name" ] || [ -e "$state/fail-$name-$1" ]; then exit 1; fi
    if [ "$name" = id ] && [ "$1" != ubuntu ]; then exit 1; fi
    exit 0
    ''')


class Box:
    """Fake tools and state directories for one enrollment run."""

    def __init__(self, base: Path):
        self.base = base
        self.state = base / "state"
        self.bin = base / "bin"
        self.var = base / "var_lib_questix"
        self.units = base / "units"
        for path in (self.state, self.bin, self.units):
            path.mkdir()
        (self.units / "ssh.socket").write_text("")
        for tool in ("passwd", "chpasswd", "ssh-keygen", "systemctl", "id", "date"):
            fake = self.bin / tool
            fake.write_text(FAKE.format(state=self.state))
            fake.chmod(0o755)

    def run(self, stdin, state_dir=None):
        env = {"PATH": f"{self.bin}:/usr/bin:/bin",
               "QUESTIX_ENROLL_STATE_DIR": str(state_dir or self.var),
               "QUESTIX_SYSTEMD_UNIT_DIR": str(self.units), "LC_ALL": "C.UTF-8"}
        return subprocess.run(["bash", str(ENROLL)], input=stdin, capture_output=True,
                              text=True, env=env, timeout=20)

    def calls(self):
        try:
            return (self.state / "calls").read_text().splitlines()
        except FileNotFoundError:
            return []

    def fail(self, what):
        (self.state / f"fail-{what}").touch()

    @property
    def marker(self):
        return self.var / "first-boot-enrolled"


@pytest.fixture
def box(tmp_path):
    return Box(tmp_path)


def good(box):
    return box.run(f"{SECRET}\n{SECRET}\n")


def test_success_order_password_then_ssh_active_then_marker(box):
    result = good(box)
    assert result.returncode == 0, result.stdout + result.stderr
    calls = box.calls()
    order = [calls.index(c) for c in (
        "chpasswd ", "ssh-keygen -A ", "systemctl enable ssh.socket ",
        "systemctl start ssh.socket ", "systemctl is-active --quiet ssh.socket ",
        "systemctl disable questix-first-boot.service ")]
    assert order == sorted(order)
    # The marker is written by `date` after is-active and before the unit disables itself.
    date_call = next(i for i, c in enumerate(calls) if c.startswith("date "))
    assert order[4] < date_call < order[5]
    assert box.marker.exists()
    assert "passwd -l ubuntu " not in calls[calls.index("chpasswd "):]


def test_password_only_reaches_chpasswd_stdin(box):
    result = good(box)
    assert (box.state / "chpasswd.stdin").read_text() == f"ubuntu:{SECRET}\n"
    assert all(SECRET not in call for call in box.calls())  # never an argument
    assert SECRET not in result.stdout + result.stderr  # never shown or logged
    assert not any(SECRET in p.read_text(errors="ignore") for p in box.var.rglob("*") if p.is_file())


def test_ssh_service_is_used_without_socket_activation(box):
    (box.units / "ssh.socket").unlink()
    assert good(box).returncode == 0
    assert "systemctl is-active --quiet ssh.service " in box.calls()


def assert_fail_closed(box, result):
    assert result.returncode == 1
    calls = box.calls()
    assert "passwd -l ubuntu " in calls
    assert "systemctl disable ssh.socket ssh.service " in calls
    assert "systemctl stop ssh.socket ssh.service " in calls
    assert not box.marker.exists()
    assert "systemctl disable questix-first-boot.service " not in calls  # retried next boot


@pytest.mark.parametrize("failing", [
    "ssh-keygen", "systemctl-enable", "systemctl-start", "systemctl-is-active",
])
def test_ssh_step_failure_fails_closed(box, failing):
    box.fail(failing)
    result = good(box)
    assert_fail_closed(box, result)
    calls = box.calls()
    # The account is locked again after the password had been set.
    assert "passwd -l ubuntu " in calls[calls.index("chpasswd "):]


def test_marker_write_failure_fails_closed(box):
    blocker = box.base / "not-a-directory"
    blocker.write_text("")
    result = box.run(f"{SECRET}\n{SECRET}\n", state_dir=blocker / "state")
    assert result.returncode == 1
    calls = box.calls()
    assert "passwd -l ubuntu " in calls[calls.index("chpasswd "):]
    assert "systemctl stop ssh.socket ssh.service " in calls
    assert "systemctl disable questix-first-boot.service " not in calls


def test_self_disable_failure_after_the_marker_is_still_success(box):
    box.fail("systemctl-disable")
    result = good(box)
    assert result.returncode == 0
    assert box.marker.exists()
    assert "次回は動きません" in result.stdout


def test_chpasswd_failure_never_enables_ssh(box):
    box.fail("chpasswd")
    result = good(box)
    assert_fail_closed(box, result)
    assert not any(call.startswith(("systemctl enable", "systemctl start")) for call in box.calls())


def test_end_of_input_fails_closed(box):
    result = box.run("")
    assert_fail_closed(box, result)
    assert not (box.state / "chpasswd.stdin").exists()


def test_mismatch_and_short_passwords_are_asked_again(box):
    result = box.run(f"short\nshort\n{SECRET}\nother-pass-1\n{SECRET}\n{SECRET}\n")
    assert result.returncode == 0
    assert "8 文字以上" in result.stdout and "一致しません" in result.stdout
    assert (box.state / "chpasswd.stdin").read_text() == f"ubuntu:{SECRET}\n"


@pytest.mark.parametrize("weak", ["ubuntu", "questix"])
def test_default_like_passwords_are_refused(box, weak):
    result = box.run(f"{weak}\n{weak}\n")  # then the input ends
    assert result.returncode == 1
    assert not (box.state / "chpasswd.stdin").exists()


def test_already_enrolled_does_nothing(box):
    box.var.mkdir()
    box.marker.write_text("done")
    assert box.run("").returncode == 0
    assert box.calls() == []


def test_unit_runs_on_the_console_before_login():
    unit = UNIT.read_text()
    for line in ("ExecStart=/usr/local/sbin/questix-first-boot-enroll", "StandardInput=tty",
                 "StandardOutput=tty", "StandardError=tty", "TTYPath=/dev/tty1",
                 "ConditionPathExists=!/var/lib/questix/first-boot-enrolled",
                 "Before=getty@tty1.service display-manager.service", "WantedBy=multi-user.target"):
        assert line + "\n" in unit


def test_marker_paths_agree():
    script = ENROLL.read_text()
    assert 'STATE_DIR="${QUESTIX_ENROLL_STATE_DIR:-/var/lib/questix}"' in script
    assert 'MARKER="$STATE_DIR/first-boot-enrolled"' in script
    assert "!/var/lib/questix/first-boot-enrolled" in UNIT.read_text()
    assert "SELF_UNIT=questix-first-boot.service" in script
    assert os.access(ENROLL, os.X_OK)
