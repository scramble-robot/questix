"""Tests for scripts/cleanup_legacy_privileges.py (exit contract 0 clean / 1 fixable / 2 unsafe).

Everything runs against a fake root tree with a fake visudo: nothing touches the real /etc,
accounts or sudo. Password hashes are real ones made by the system's libxcrypt (yescrypt and
SHA-512), so the known-default-password check is exercised end to end.
"""

import ctypes
import ctypes.util
import os
import textwrap
from pathlib import Path

import pytest

import cleanup_legacy_privileges as clp

LEGACY = b"ubuntu ALL=(ALL) NOPASSWD:ALL\n"

FAKE_VISUDO = textwrap.dedent("""\
    #!/bin/sh
    echo "$@" >> {log}
    [ "$1" = --version ] && exit 0
    results={results}
    [ -s "$results" ] || exit 0
    code=$(head -n 1 "$results"); sed -i 1d "$results"
    [ "$code" = 0 ] || echo "parse error" >&2
    exit "$code"
    """)


def make_hash(password, method="$y$"):
    """Return a real /etc/shadow hash made by libxcrypt (yescrypt or SHA-512)."""
    library = ctypes.CDLL(ctypes.util.find_library("crypt"))
    library.crypt_gensalt.restype = ctypes.c_char_p
    library.crypt_gensalt.argtypes = [ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p,
                                      ctypes.c_int]
    setting = library.crypt_gensalt(method.encode(), 0, None, 0).decode()
    hashed = clp.system_crypt(password, setting)
    assert hashed and hashed.startswith(method)
    return hashed


class Root:
    """A fake / with passwd, shadow, sudoers and polkit directories, and a fake visudo."""

    def __init__(self, base: Path):
        self.base = base
        for directory in ("etc/sudoers.d", "etc/polkit-1/localauthority/50-local.d"):
            (base / directory).mkdir(parents=True)
        (base / "etc/sudoers").write_text("@includedir /etc/sudoers.d\n")
        (base / "etc/passwd").write_text("root:x:0:0::/root:/bin/bash\n"
                                         "ubuntu:x:1000:1000::/home/ubuntu:/bin/bash\n")
        self.shadow(make_hash("A-changed-pass-7"))
        self.visudo_log = base / "visudo.log"
        self.visudo_results = base / "visudo.results"
        visudo = base / "visudo"
        visudo.write_text(FAKE_VISUDO.format(log=self.visudo_log, results=self.visudo_results))
        visudo.chmod(0o755)
        self.visudo = str(visudo)
        self.lines = []

    def shadow(self, field):
        self.shadow_field = field
        (self.base / "etc/shadow").write_text(
            f"root:*:19000::::::\nubuntu:{field}:19000:0:99999:7:::\n")

    @property
    def sudoers(self):
        return self.base / clp.LEGACY_SUDOERS

    @property
    def pkla(self):
        return self.base / clp.LEGACY_PKLA[0]

    def run(self, check=False, results=(), **kwargs):
        self.visudo_results.write_text("".join(f"{code}\n" for code in results))
        self.lines = []
        return clp.Cleanup(root=str(self.base), check=check, visudo=[self.visudo],
                           out=self.lines.append, **kwargs).run()

    def text(self):
        return "\n".join(self.lines)

    def checks(self):
        try:
            lines = self.visudo_log.read_text().splitlines()
        except FileNotFoundError:
            return []
        return [line for line in lines if line.startswith("-c")]


@pytest.fixture
def root(tmp_path):
    return Root(tmp_path)


def test_clean_robot_is_clean(root):
    assert root.run(check=True) == clp.CLEAN
    assert root.run() == clp.CLEAN
    assert root.lines == []


def test_exact_legacy_sudoers_is_removed_between_two_checks(root):
    root.sudoers.write_bytes(LEGACY)
    assert root.run(check=True) == clp.FIXABLE
    assert root.sudoers.exists()  # --check changes nothing
    assert root.run() == clp.CLEAN
    assert not root.sudoers.exists()
    assert not list((root.base / "etc/sudoers.d").iterdir())  # the parked copy is gone too
    assert len(root.checks()) == 2  # visudo -c before and after
    assert "removed /etc/sudoers.d/ubuntu" in root.text()
    assert root.run() == clp.CLEAN and root.lines == []  # a second run does nothing
    assert root.run(check=True) == clp.CLEAN


def test_legacy_line_without_newline_counts(root):
    root.sudoers.write_bytes(LEGACY.rstrip(b"\n"))
    assert root.run() == clp.CLEAN and not root.sudoers.exists()


@pytest.mark.parametrize("method", ["$y$", "$6$"])
def test_known_default_password_is_unsafe_and_keeps_the_sudoers(root, method):
    root.shadow(make_hash("ubuntu", method))
    root.sudoers.write_bytes(LEGACY)
    assert root.run(check=True) == clp.UNSAFE
    assert root.run() == clp.UNSAFE
    assert root.sudoers.read_bytes() == LEGACY  # not removed while the password is known
    assert root.checks() == []
    assert "sudo passwd ubuntu" in root.text()
    # Neither the hash nor its salt or digest is printed.
    assert root.shadow_field not in root.text()
    assert root.shadow_field.split("$")[-1] not in root.text()


def test_known_default_password_is_unsafe_without_legacy_sudoers(root):
    root.shadow(make_hash("ubuntu"))
    assert root.run(check=True) == clp.UNSAFE
    assert "known default password" in root.text()


def test_changed_password_lets_the_cleanup_finish(root):
    root.shadow(make_hash("ubuntu"))
    root.sudoers.write_bytes(LEGACY)
    assert root.run() == clp.UNSAFE
    root.shadow(make_hash("Now-a-good-one-9"))
    assert root.run(check=True) == clp.FIXABLE
    assert root.run() == clp.CLEAN and not root.sudoers.exists()


def test_uncheckable_hash_is_undetermined(root):
    root.sudoers.write_bytes(LEGACY)
    assert root.run(crypt=lambda password, setting: None) == clp.UNSAFE
    assert "UNDETERMINED" in root.text()
    assert root.sudoers.read_bytes() == LEGACY


@pytest.mark.parametrize("field", ["!", "!$y$j9T$hash", "*", ""])
def test_legacy_sudoers_without_a_usable_password_is_unsafe(root, field):
    root.shadow(field)
    root.sudoers.write_bytes(LEGACY)
    assert root.run(check=True) == clp.UNSAFE
    assert root.run() == clp.UNSAFE
    assert root.sudoers.read_bytes() == LEGACY
    assert "no usable password" in root.text()


@pytest.mark.parametrize("content", [
    b"ubuntu ALL=(ALL) NOPASSWD:ALL\nadmin ALL=(ALL) ALL\n",
    b"ubuntu ALL=(ALL) NOPASSWD: /usr/bin/apt\n",
    b"# local\nubuntu ALL=(ALL) NOPASSWD:ALL\n",
    b"ubuntu ALL=(ALL) ALL\n",
])
def test_other_sudoers_content_is_kept_and_clean(root, content):
    root.sudoers.write_bytes(content)
    assert root.run(check=True) == clp.CLEAN
    assert root.run() == clp.CLEAN
    assert root.sudoers.read_bytes() == content
    assert root.checks() == []
    if b"NOPASSWD" in content:
        assert "WARNING" in root.text() and "kept" in root.text()


def test_broken_sudoers_stops_before_any_change(root):
    root.sudoers.write_bytes(LEGACY)
    assert root.run(results=[1]) == clp.UNSAFE
    assert root.sudoers.read_bytes() == LEGACY
    assert "STOP" in root.text()


def test_failed_check_after_removal_restores_the_file(root):
    root.sudoers.write_bytes(LEGACY)
    assert root.run(results=[0, 1]) == clp.UNSAFE
    assert root.sudoers.read_bytes() == LEGACY
    assert "restored" in root.text()


@pytest.mark.parametrize("check", [True, False])
def test_missing_visudo_is_unsafe(root, check):
    root.sudoers.write_bytes(LEGACY)
    root.visudo = str(root.base / "no-such-visudo")
    assert root.run(check=check) == clp.UNSAFE
    assert root.sudoers.read_bytes() == LEGACY


def test_symlinked_sudoers_is_unsafe_and_left_alone(root):
    target = root.base / "elsewhere"
    target.write_bytes(LEGACY)
    root.sudoers.symlink_to(target)
    assert root.run() == clp.UNSAFE
    assert root.sudoers.is_symlink() and target.read_bytes() == LEGACY
    assert "not a plain file" in root.text()


def test_unreadable_sudoers_is_undetermined(root, monkeypatch):
    # What a normal user's --check sees (/etc/sudoers.d is root's); simulated so that the test
    # also holds when it runs as root.
    root.sudoers.write_bytes(LEGACY)
    real = os.lstat

    def denied(path, *args, **kwargs):
        if str(path).endswith(clp.LEGACY_SUDOERS):
            raise PermissionError(13, "Permission denied")
        return real(path, *args, **kwargs)
    monkeypatch.setattr(clp.os, "lstat", denied)
    assert root.run(check=True) == clp.UNSAFE
    assert "cannot be read" in root.text()


def test_unreadable_shadow_is_undetermined(root, monkeypatch):
    real = open

    def denied(path, *args, **kwargs):
        if str(path).endswith("etc/shadow"):
            raise PermissionError(13, "Permission denied")
        return real(path, *args, **kwargs)
    monkeypatch.setattr("builtins.open", denied)
    assert root.run(check=True) == clp.UNSAFE
    assert "cannot be checked" in root.text()


def test_legacy_pkla_is_removed_whatever_it_holds(root):
    root.pkla.write_text("[Questix Robot Service Management]\nIdentity=unix-user:ubuntu\n"
                         "Action=org.freedesktop.systemd1.manage-units\nResultAny=yes\n")
    assert root.run(check=True) == clp.FIXABLE
    assert root.run() == clp.CLEAN
    assert not root.pkla.exists()
    assert "removed /etc/polkit-1/localauthority/50-local.d/50-questix-robot.pkla" in root.text()
    assert root.run() == clp.CLEAN and root.lines == []


def test_real_run_removes_what_it_can_and_still_reports_unsafe(root):
    root.pkla.write_text("x")
    root.shadow(make_hash("ubuntu"))
    root.sudoers.write_bytes(LEGACY)
    assert root.run() == clp.UNSAFE
    assert not root.pkla.exists() and root.sudoers.exists()


def test_real_run_needs_root(monkeypatch):
    monkeypatch.setattr(clp.os, "geteuid", lambda: 1000)
    assert clp.main([]) == clp.UNSAFE


def test_nothing_else_in_etc_is_touched(root):
    keep = root.base / "etc/sudoers.d/90-admin"
    keep.write_text("admin ALL=(ALL) ALL\n")
    (root.base / "etc/polkit-1/localauthority/50-local.d/60-site.pkla").write_text("site")
    root.sudoers.write_bytes(LEGACY)
    assert root.run() == clp.CLEAN
    assert keep.exists()
    assert (root.base / "etc/polkit-1/localauthority/50-local.d/60-site.pkla").exists()


def test_no_user_ubuntu_means_no_password_check(root):
    (root.base / "etc/passwd").write_text("root:x:0:0::/root:/bin/bash\n")
    root.shadow(make_hash("ubuntu"))  # a leftover line for a user that no longer exists
    assert root.run(check=True) == clp.CLEAN
