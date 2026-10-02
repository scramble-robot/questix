#!/usr/bin/env python3
"""Remove root-equivalent defaults that older QUESTiX images and installers left on a robot.

Run as root by every update path (``scripts/install-robot-manager.sh``,
``scripts/update-robot-manager.sh``, the Ansible ``legacy_privilege_cleanup`` role at the end of
``setup_kit.yaml`` / ``setup_dev.yaml``). Standard library only. It removes only files whose
content is exactly what QUESTiX itself wrote, and never guesses about an administrator's own
rules:

- ``/etc/polkit-1/localauthority/50-local.d/50-questix-robot.pkla``: the legacy polkit file
  (``manage-units`` for every unit and ``org.freedesktop.policykit.exec``, i.e. passwordless
  pkexec) deployed by older installers. The path is QUESTiX's own, so it is always removed; the
  narrow JavaScript rules in ``/etc/polkit-1/rules.d/50-questix-robot.rules`` stay the only
  QUESTiX polkit authority.
- ``/etc/sudoers.d/ubuntu``: removed only when it is exactly the old custom image's
  ``ubuntu ALL=(ALL) NOPASSWD:ALL`` line, the user has a usable password that is not the old
  image's known ``ubuntu``, and ``visudo -c`` passes before and after (the file is restored
  when the second check fails). A file with any other content is kept and reported.
- The old image's known password: while ``ubuntu`` still has the password ``ubuntu`` the robot
  is not considered clean, whatever else was removed (``passwd ubuntu`` first). The check
  compares hashes with the system's crypt(3); neither the password nor the hash is printed.

Console / desktop autologin is not touched: on a kit it is the ``display_settings`` role's
``enable_autologin`` setting (the same content the old image wrote), a product decision
rather than a privilege default; without NOPASSWD it no longer gives root.

Exit status, the same for ``--check`` (changes nothing) and a real run:
  0  clean (nothing QUESTiX left; an administrator's own sudoers rules may remain, reported)
  1  ``--check`` only: something would be removed automatically by a real run
  2  unsafe or undetermined, an operator has to act: the known default password, legacy
     sudoers that cannot be removed without losing sudo (locked or empty password), visudo
     missing or failing, sudoers or shadow not readable (``--check`` without root), a link.
A real run removes what it safely can and still exits 2 while something unsafe remains.
"""

import argparse
import ctypes
import ctypes.util
import hmac
import os
import stat
import subprocess
import sys
import warnings

CLEAN, FIXABLE, UNSAFE = 0, 1, 2

LEGACY_PKLA = (
    "etc/polkit-1/localauthority/50-local.d/50-questix-robot.pkla",
)
LEGACY_SUDOERS = "etc/sudoers.d/ubuntu"
LEGACY_USER = "ubuntu"
# What scripts/prepare-base-system.sh used to write (echo ... >> /etc/sudoers.d/ubuntu).
LEGACY_SUDOERS_CONTENT = (
    b"ubuntu ALL=(ALL) NOPASSWD:ALL\n",
    b"ubuntu ALL=(ALL) NOPASSWD:ALL",
)
# The old custom image's `chpasswd` value (and Ubuntu's own preinstalled-image default).
KNOWN_DEFAULT_PASSWORDS = ("ubuntu",)


def system_crypt(password, setting):
    """Return crypt(3) of password with the hash's own settings, or None when unavailable.

    Python's ``crypt`` module (3.12, deprecated) or libcrypt through ctypes (3.13+): the same
    libxcrypt that /etc/shadow's yescrypt / SHA-512 hashes come from on Ubuntu 24.04.
    """
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            import crypt  # noqa: F401  (removed in Python 3.13)
        result = crypt.crypt(password, setting)
    except (ImportError, OSError):
        name = ctypes.util.find_library("crypt")
        if not name:
            return None
        try:
            library = ctypes.CDLL(name)
        except OSError:
            return None
        library.crypt.restype = ctypes.c_char_p
        library.crypt.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        raw = library.crypt(password.encode(), setting.encode())
        result = raw.decode() if raw else None
    # libxcrypt returns "*0"/"*1" (never a valid hash) for a setting it does not support.
    if not result or result.startswith("*"):
        return None
    return result


class Cleanup:
    """One run against a root directory ("/" on a robot, a temporary tree in the tests)."""

    def __init__(self, root="/", check=False, visudo=("visudo",), out=print, crypt=system_crypt):
        self.root = root
        self.check = check
        self.visudo = tuple(visudo)
        self.out = out
        self.crypt = crypt
        self.pending = False
        self.unsafe = False

    def path(self, relative):
        return os.path.join(self.root, relative)

    def say(self, message):
        self.out(message)

    def stop(self, message):
        """Record an unsafe or undetermined state (exit 2) with what the operator should do."""
        self.unsafe = True
        self.say(message)

    def remove(self, relative, why):
        if self.check:
            self.pending = True
            self.say(f"would remove {'/' + relative}: {why}")
            return
        os.unlink(self.path(relative))
        self.say(f"removed {'/' + relative}: {why}")

    def read_plain(self, relative, limit=4096):
        """Return (state, bytes): state is "absent", "ok", "unreadable" or "not_plain"."""
        try:
            info = os.lstat(self.path(relative))
        except FileNotFoundError:
            return "absent", None
        except PermissionError:  # --check as a normal user: /etc/sudoers.d is root's
            return "unreadable", None
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            return "not_plain", None
        try:
            with open(self.path(relative), "rb") as file:
                return "ok", file.read(limit + 1)
        except PermissionError:
            return "unreadable", None

    # --- polkit ------------------------------------------------------------------

    def pkla(self):
        for relative in LEGACY_PKLA:
            try:
                present = os.path.lexists(self.path(relative))
            except OSError:
                present = False
            if present:
                self.remove(relative, "legacy polkit rule (every unit, passwordless pkexec)")

    # --- the legacy user's password ----------------------------------------------

    def user_exists(self, user):
        try:
            with open(self.path("etc/passwd")) as file:
                return any(line.split(":", 1)[0] == user for line in file)
        except OSError:
            return False

    def password_state(self, user):
        """Return "usable", "known_default", "locked", "empty", "missing" or "unreadable".

        Never prints or returns the hash.
        """
        try:
            with open(self.path("etc/shadow")) as file:
                lines = file.read().splitlines()
        except PermissionError:
            return "unreadable"
        except OSError:
            return "missing"
        for line in lines:
            fields = line.split(":")
            if fields[0] != user or len(fields) < 2:
                continue
            hashed = fields[1]
            if not hashed:
                return "empty"
            if hashed[0] in "!*":
                return "locked"
            for known in KNOWN_DEFAULT_PASSWORDS:
                computed = self.crypt(known, hashed)
                if computed is None:
                    return "unreadable"  # this system cannot verify the hash: undetermined
                if hmac.compare_digest(computed, hashed):
                    return "known_default"
            return "usable"
        return "missing"

    def default_password(self):
        """Report the old image's known password, an unsafe state on its own."""
        if not self.user_exists(LEGACY_USER):
            return None
        state = self.password_state(LEGACY_USER)
        if state == "known_default":
            self.stop(f"UNSAFE: {LEGACY_USER} still has the old image's known default password. "
                      f"Set a new one first: sudo passwd {LEGACY_USER}")
        elif state == "unreadable":
            self.stop(f"UNDETERMINED: the password of {LEGACY_USER} cannot be checked "
                      "(run as root; crypt(3) must support the hash).")
        return state

    # --- sudoers -----------------------------------------------------------------

    def visudo_ok(self):
        try:
            result = subprocess.run([*self.visudo, "-c", "-f", self.path("etc/sudoers")],
                                    capture_output=True, text=True, check=False, shell=False)
        except OSError as error:
            self.stop(f"STOP: visudo cannot run ({error.strerror}); sudoers left as they are")
            return False
        if result.returncode != 0:
            self.stop("STOP: visudo -c reports a sudoers problem; nothing changed:\n"
                      + (result.stdout + result.stderr).strip())
            return False
        return True

    def sudoers(self, password):
        where = "/" + LEGACY_SUDOERS
        state, data = self.read_plain(LEGACY_SUDOERS)
        if state == "absent":
            return
        if state == "unreadable":
            self.stop(f"UNDETERMINED: {where} cannot be read (run as root).")
            return
        if state == "not_plain":
            self.stop(f"UNSAFE: {where} is not a plain file (link or several links); "
                      f"left as it is. Check it with: sudo visudo -f {where}")
            return
        if data not in LEGACY_SUDOERS_CONTENT:
            if b"NOPASSWD" in data:
                self.say(f"WARNING: {where} has a NOPASSWD rule that QUESTiX did not write; "
                         f"kept. Check it with: sudo visudo -f {where}")
            return
        if password in ("locked", "empty", "missing") and self.user_exists(LEGACY_USER):
            self.stop(f"UNSAFE: {where} (NOPASSWD:ALL, from an old QUESTiX image) kept: "
                      f"{LEGACY_USER} has no usable password, so sudo would be lost. "
                      f"Set one first: sudo passwd {LEGACY_USER}")
            return
        if password in ("known_default", "unreadable"):
            self.say(f"kept {where} until the password of {LEGACY_USER} is safe (see above)")
            return
        if self.check:
            # A real run needs visudo: check that it can run at all.
            try:
                subprocess.run([*self.visudo, "--version"], capture_output=True, check=False)
            except OSError as error:
                self.stop(f"STOP: visudo cannot run ({error.strerror}); cannot remove {where}")
                return
            self.remove(LEGACY_SUDOERS, "legacy NOPASSWD:ALL rule")
            return
        if not self.visudo_ok():
            return
        # sudo ignores files in sudoers.d whose name contains a dot: park it, check, then drop.
        parked = self.path("etc/sudoers.d/.ubuntu.questix-legacy")
        os.rename(self.path(LEGACY_SUDOERS), parked)
        if not self.visudo_ok():
            os.rename(parked, self.path(LEGACY_SUDOERS))
            self.say(f"STOP: restored {where}")
            return
        os.unlink(parked)
        self.say(f"removed {where}: legacy NOPASSWD:ALL rule "
                 f"(sudo now asks for {LEGACY_USER}'s password)")

    def run(self):
        self.pkla()
        password = self.default_password()
        self.sudoers(password)
        if self.unsafe:
            return UNSAFE
        return FIXABLE if self.check and self.pending else CLEAN


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--check", action="store_true",
                        help="change nothing; exit 1 if a real run would remove something, "
                             "2 if an operator has to act")
    args = parser.parse_args(argv)
    if not args.check and os.geteuid() != 0:
        print("run as root (sudo)", file=sys.stderr)
        return UNSAFE
    return Cleanup(check=args.check).run()


if __name__ == "__main__":
    sys.exit(main())
