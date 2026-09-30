"""Tests for scripts/cleanup_legacy_privileges.py and the custom image's first-boot enrollment.

Everything runs in temporary directories: the cleanup against a fake root tree with a fake
visudo, the enrollment script (scripts/iso/questix-first-boot-enroll.sh) with fake passwd,
chpasswd, ssh-keygen and systemctl on its PATH. Nothing touches the real /etc, accounts or SSH.
"""

import os
import subprocess
import textwrap
from pathlib import Path

import pytest

import cleanup_legacy_privileges as clp

SCRIPTS = Path(__file__).resolve().parents[1]
LEGACY = b"ubuntu ALL=(ALL) NOPASSWD:ALL\n"


class Root:
    """A fake / with sudoers, shadow and polkit directories, and a fake visudo."""

    def __init__(self, base: Path):
        self.base = base
        for directory in ("etc/sudoers.d", "etc/polkit-1/localauthority/50-local.d"):
            (base / directory).mkdir(parents=True)
        (base / "etc/sudoers").write_text("@includedir /etc/sudoers.d\n")
        self.shadow("$y$j9T$hash")
        self.visudo_log = base / "visudo.log"
        self.visudo_results = base / "visudo.results"
        visudo = base / "visudo"
        visudo.write_text(textwrap.dedent(f'''\
            #!/bin/sh
            echo "$@" >> {self.visudo_log}
            results={self.visudo_results}
            [ -s "$results" ] || exit 0
            code=$(head -n 1 "$results"); sed -i 1d "$results"
            [ "$code" = 0 ] || echo "parse error" >&2
            exit "$code"
            '''))
        visudo.chmod(0o755)
        self.visudo = str(visudo)
        self.lines = []

    def shadow(self, field):
        (self.base / "etc/shadow").write_text(f"root:*:19000::::::\nubuntu:{field}:19000:0:99999:7:::\n")

    @property
    def sudoers(self):
        return self.base / clp.LEGACY_SUDOERS

    @property
    def pkla(self):
        return self.base / clp.LEGACY_PKLA[0]

    def run(self, check=False, results=()):
        self.visudo_results.write_text("".join(f"{code}\n" for code in results))
        self.lines = []
        return clp.Cleanup(root=str(self.base), check=check, visudo=[self.visudo],
                           out=self.lines.append).run()

    def text(self):
        return "\n".join(self.lines)


@pytest.fixture
def root(tmp_path):
    return Root(tmp_path)


def test_exact_legacy_sudoers_is_removed_between_two_checks(root):
    root.sudoers.write_bytes(LEGACY)
    assert root.run() == 0
    assert not root.sudoers.exists()
    assert not list((root.base / "etc/sudoers.d").iterdir())  # the parked copy is gone too
    assert len(root.visudo_log.read_text().splitlines()) == 2  # before and after
    assert "removed /etc/sudoers.d/ubuntu" in root.text()
    assert root.run() == 0 and root.lines == []  # a second run does nothing


def test_legacy_line_without_newline_counts(root):
    root.sudoers.write_bytes(LEGACY.rstrip(b"\n"))
    assert root.run() == 0 and not root.sudoers.exists()


@pytest.mark.parametrize("content", [
    b"ubuntu ALL=(ALL) NOPASSWD:ALL\nadmin ALL=(ALL) ALL\n",
    b"ubuntu ALL=(ALL) NOPASSWD: /usr/bin/apt\n",
    b"# local\nubuntu ALL=(ALL) NOPASSWD:ALL\n",
    b"ubuntu ALL=(ALL) ALL\n",
])
def test_other_sudoers_content_is_kept(root, content):
    root.sudoers.write_bytes(content)
    assert root.run() == 0
    assert root.sudoers.read_bytes() == content
    assert not root.visudo_log.exists()
    if b"NOPASSWD" in content:
        assert "WARNING" in root.text() and "kept" in root.text()


@pytest.mark.parametrize("field", ["!", "!$y$j9T$hash", "*", ""])
def test_legacy_sudoers_is_kept_without_a_usable_password(root, field):
    root.shadow(field)
    root.sudoers.write_bytes(LEGACY)
    assert root.run() == 0
    assert root.sudoers.read_bytes() == LEGACY
    assert "no usable password" in root.text()


def test_broken_sudoers_stops_before_any_change(root):
    root.sudoers.write_bytes(LEGACY)
    assert root.run(results=[1]) == 2
    assert root.sudoers.read_bytes() == LEGACY
    assert "STOP" in root.text()


def test_failed_check_after_removal_restores_the_file(root):
    root.sudoers.write_bytes(LEGACY)
    assert root.run(results=[0, 1]) == 2
    assert root.sudoers.read_bytes() == LEGACY
    assert "restored" in root.text()


def test_missing_visudo_stops(root):
    root.sudoers.write_bytes(LEGACY)
    root.visudo = str(root.base / "no-such-visudo")
    assert root.run() == 2
    assert root.sudoers.read_bytes() == LEGACY


def test_symlinked_sudoers_is_left_alone(root):
    target = root.base / "elsewhere"
    target.write_bytes(LEGACY)
    root.sudoers.symlink_to(target)
    assert root.run() == 0
    assert root.sudoers.is_symlink() and target.read_bytes() == LEGACY
    assert "not a plain file" in root.text()


def test_legacy_pkla_is_removed_whatever_it_holds(root):
    root.pkla.write_text("[Questix Robot Service Management]\nIdentity=unix-user:ubuntu\n"
                         "Action=org.freedesktop.systemd1.manage-units\nResultAny=yes\n")
    assert root.run() == 0
    assert not root.pkla.exists()
    assert "removed /etc/polkit-1/localauthority/50-local.d/50-questix-robot.pkla" in root.text()
    assert root.run() == 0 and root.lines == []


def test_check_reports_and_changes_nothing(root):
    root.pkla.write_text("x")
    root.sudoers.write_bytes(LEGACY)
    assert root.run(check=True) == 1
    assert root.pkla.exists() and root.sudoers.read_bytes() == LEGACY
    assert "would remove" in root.text()
    root.pkla.unlink()
    root.sudoers.unlink()
    assert root.run(check=True) == 0


def test_real_run_needs_root(monkeypatch):
    monkeypatch.setattr(clp.os, "geteuid", lambda: 1000)
    assert clp.main([]) == 2


def test_nothing_else_in_etc_is_touched(root):
    keep = root.base / "etc/sudoers.d/90-admin"
    keep.write_text("admin ALL=(ALL) ALL\n")
    (root.base / "etc/polkit-1/localauthority/50-local.d/60-site.pkla").write_text("site")
    root.sudoers.write_bytes(LEGACY)
    assert root.run() == 0
    assert keep.exists()
    assert (root.base / "etc/polkit-1/localauthority/50-local.d/60-site.pkla").exists()


# --- First-boot enrollment (scripts/iso/questix-first-boot-enroll.sh) ------------------------

ENROLL = SCRIPTS / "iso" / "questix-first-boot-enroll.sh"
FAKE = textwrap.dedent('''\
    #!/bin/bash
    state={state}
    name=$(basename "$0")
    printf '%s\\n' "$(printf '%q ' "$name" "$@")" >> "$state/calls"
    if [ "$name" = chpasswd ]; then cat > "$state/chpasswd.stdin"; fi
    if [ -e "$state/fail-$name" ]; then exit 1; fi
    if [ "$name" = id ] && [ "$1" != ubuntu ]; then exit 1; fi
    exit 0
    ''')


class Box:
    """Fake tools and state directories for one enrollment run."""

    def __init__(self, base: Path):
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

    def run(self, stdin):
        env = {"PATH": f"{self.bin}:/usr/bin:/bin", "QUESTIX_ENROLL_STATE_DIR": str(self.var),
               "QUESTIX_SYSTEMD_UNIT_DIR": str(self.units), "LC_ALL": "C.UTF-8"}
        return subprocess.run(["bash", str(ENROLL)], input=stdin, capture_output=True,
                              text=True, env=env, timeout=20)

    def calls(self):
        try:
            return (self.state / "calls").read_text().splitlines()
        except FileNotFoundError:
            return []

    def fail(self, tool):
        (self.state / f"fail-{tool}").touch()

    @property
    def marker(self):
        return self.var / "first-boot-enrolled"


@pytest.fixture
def box(tmp_path):
    return Box(tmp_path)


SECRET = "Robot-Pass-2026"


def test_enrollment_sets_the_password_then_enables_ssh(box):
    result = box.run(f"{SECRET}\n{SECRET}\n")
    assert result.returncode == 0, result.stdout + result.stderr
    calls = box.calls()
    # The password goes to chpasswd on stdin only, never on a command line.
    assert (box.state / "chpasswd.stdin").read_text() == f"ubuntu:{SECRET}\n"
    assert all(SECRET not in call for call in calls)
    assert SECRET not in result.stdout + result.stderr
    assert "ssh-keygen -A " in calls
    # SSH is enabled only after the password was set.
    assert calls.index("systemctl enable ssh.socket ") > calls.index("chpasswd ")
    assert "systemctl enable ssh.socket " in calls
    assert "systemctl disable questix-first-boot.service " in calls
    assert "systemctl start --no-block ssh.socket " in calls
    assert box.marker.exists()


def test_ssh_service_is_used_without_socket_activation(box):
    (box.units / "ssh.socket").unlink()
    assert box.run(f"{SECRET}\n{SECRET}\n").returncode == 0
    assert "systemctl enable ssh.service " in box.calls()


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


def assert_fail_closed(box, result):
    assert result.returncode == 1
    calls = box.calls()
    assert "passwd -l ubuntu " in calls
    assert "systemctl disable ssh.socket ssh.service " in calls
    assert not box.marker.exists()
    assert "systemctl disable questix-first-boot.service " not in calls  # retried next boot


def test_end_of_input_fails_closed(box):
    result = box.run("")
    assert_fail_closed(box, result)
    assert not (box.state / "chpasswd.stdin").exists()
    assert not any(call.startswith("systemctl enable") for call in box.calls())


def test_chpasswd_failure_fails_closed(box):
    box.fail("chpasswd")
    result = box.run(f"{SECRET}\n{SECRET}\n")
    assert_fail_closed(box, result)
    assert not any(call.startswith("systemctl enable") for call in box.calls())


def test_ssh_failure_locks_the_account_again(box):
    box.fail("ssh-keygen")
    result = box.run(f"{SECRET}\n{SECRET}\n")
    assert_fail_closed(box, result)
    calls = box.calls()
    # Locked again after the password had been set.
    assert "passwd -l ubuntu " in calls[calls.index("chpasswd "):]


def test_already_enrolled_does_nothing(box):
    box.var.mkdir()
    box.marker.write_text("done")
    assert box.run("").returncode == 0
    assert box.calls() == []


def test_unit_runs_on_the_console_before_login():
    unit = (SCRIPTS / "iso" / "questix-first-boot.service").read_text()
    for line in ("ExecStart=/usr/local/sbin/questix-first-boot-enroll", "StandardInput=tty",
                 "StandardOutput=tty", "StandardError=tty", "TTYPath=/dev/tty1",
                 "ConditionPathExists=!/var/lib/questix/first-boot-enrolled",
                 "Before=getty@tty1.service display-manager.service", "WantedBy=multi-user.target"):
        assert line + "\n" in unit


def test_marker_paths_agree():
    unit = (SCRIPTS / "iso" / "questix-first-boot.service").read_text()
    script = ENROLL.read_text()
    assert 'STATE_DIR="${QUESTIX_ENROLL_STATE_DIR:-/var/lib/questix}"' in script
    assert 'MARKER="$STATE_DIR/first-boot-enrolled"' in script
    assert "!/var/lib/questix/first-boot-enrolled" in unit
    assert "SELF_UNIT=questix-first-boot.service" in script
    assert os.access(ENROLL, os.X_OK)
