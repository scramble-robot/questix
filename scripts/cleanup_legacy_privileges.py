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
  ``ubuntu ALL=(ALL) NOPASSWD:ALL`` line, only when the user has a usable password (otherwise
  sudo would be lost: a warning says to set one first) and only between two successful
  ``visudo -c`` checks (the file is restored when the second one fails). A file with any other
  content is kept and reported.

Console / desktop autologin is not touched: on a kit it is the ``display_settings`` role's
``enable_autologin`` setting (the same content the old image wrote), a product decision
rather than a privilege default; without NOPASSWD it no longer gives root.

Exit status: 0 done (or nothing to do), 1 with ``--check`` when something would be removed,
2 when it stopped for safety (sudoers syntax). ``--check`` changes nothing.
"""

import argparse
import os
import stat
import subprocess
import sys

LEGACY_PKLA = (
    "etc/polkit-1/localauthority/50-local.d/50-questix-robot.pkla",
)
LEGACY_SUDOERS = "etc/sudoers.d/ubuntu"
LEGACY_SUDOERS_USER = "ubuntu"
# What scripts/prepare-base-system.sh used to write (echo ... >> /etc/sudoers.d/ubuntu).
LEGACY_SUDOERS_CONTENT = (
    b"ubuntu ALL=(ALL) NOPASSWD:ALL\n",
    b"ubuntu ALL=(ALL) NOPASSWD:ALL",
)


class Cleanup:
    """One run against a root directory ("/" on a robot, a temporary tree in the tests)."""

    def __init__(self, root="/", check=False, visudo=("visudo",), out=print):
        self.root = root
        self.check = check
        self.visudo = tuple(visudo)
        self.out = out
        self.pending = False

    def path(self, relative):
        return os.path.join(self.root, relative)

    def say(self, message):
        self.out(message)

    def remove(self, relative, why):
        if self.check:
            self.pending = True
            self.say(f"would remove {'/' + relative}: {why}")
            return
        os.unlink(self.path(relative))
        self.say(f"removed {'/' + relative}: {why}")

    def read_exact(self, relative, limit=4096):
        """Bytes of a regular, unlinked-elsewhere file, or None when absent or not such a file."""
        try:
            info = os.lstat(self.path(relative))
        except FileNotFoundError:
            return None
        except PermissionError:  # --check as a normal user: /etc/sudoers.d is root's
            return None
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            self.say(f"WARNING: {'/' + relative} is not a plain file; left as it is")
            return None
        try:
            with open(self.path(relative), "rb") as file:
                return file.read(limit + 1)
        except PermissionError:
            return None

    # --- polkit ------------------------------------------------------------------

    def pkla(self):
        for relative in LEGACY_PKLA:
            if os.path.lexists(self.path(relative)):
                self.remove(relative, "legacy polkit rule (every unit, passwordless pkexec)")

    # --- sudoers -----------------------------------------------------------------

    def visudo_ok(self):
        try:
            result = subprocess.run([*self.visudo, "-c", "-f", self.path("etc/sudoers")],
                                    capture_output=True, text=True, check=False, shell=False)
        except OSError as error:
            self.say(f"STOP: visudo cannot run ({error.strerror}); sudoers left as they are")
            return False
        if result.returncode != 0:
            self.say("STOP: visudo -c reports a sudoers problem; nothing changed:\n"
                     + (result.stdout + result.stderr).strip())
            return False
        return True

    def password_usable(self, user):
        """Whether the user has a password sudo can ask for (not locked, not empty)."""
        try:
            with open(self.path("etc/shadow")) as file:
                for line in file:
                    fields = line.rstrip("\n").split(":")
                    if fields[0] == user and len(fields) > 1:
                        return bool(fields[1]) and fields[1][0] not in "!*"
        except OSError:
            return False
        return False

    def sudoers(self):
        data = self.read_exact(LEGACY_SUDOERS)
        if data is None:
            return 0
        where = "/" + LEGACY_SUDOERS
        if data not in LEGACY_SUDOERS_CONTENT:
            if b"NOPASSWD" in data:
                self.say(f"WARNING: {where} has a NOPASSWD rule that QUESTiX did not write; "
                         "kept. Check it with: sudo visudo -f " + where)
            return 0
        if not self.password_usable(LEGACY_SUDOERS_USER):
            self.say(f"WARNING: {where} (NOPASSWD:ALL, from an old QUESTiX image) kept: "
                     f"{LEGACY_SUDOERS_USER} has no usable password, so sudo would be lost. "
                     f"Run `passwd` as {LEGACY_SUDOERS_USER}, then run this update again.")
            return 0
        if self.check:
            self.remove(LEGACY_SUDOERS, "legacy NOPASSWD:ALL rule")
            return 0
        if not self.visudo_ok():
            return 2
        # sudo ignores files in sudoers.d whose name contains a dot: park it, check, then drop.
        parked = self.path("etc/sudoers.d/.ubuntu.questix-legacy")
        os.rename(self.path(LEGACY_SUDOERS), parked)
        if not self.visudo_ok():
            os.rename(parked, self.path(LEGACY_SUDOERS))
            self.say(f"STOP: restored {where}")
            return 2
        os.unlink(parked)
        self.say(f"removed {where}: legacy NOPASSWD:ALL rule "
                 f"(sudo now asks for {LEGACY_SUDOERS_USER}'s password)")
        return 0

    def run(self):
        self.pkla()
        status = self.sudoers()
        if status:
            return status
        return 1 if self.check and self.pending else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--check", action="store_true",
                        help="report what would be removed; exit 1 if anything")
    args = parser.parse_args(argv)
    if not args.check and os.geteuid() != 0:
        print("run as root (sudo)", file=sys.stderr)
        return 2
    return Cleanup(check=args.check).run()


if __name__ == "__main__":
    sys.exit(main())
