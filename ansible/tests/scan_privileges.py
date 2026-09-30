#!/usr/bin/env python3
"""Scan shipped files for root-equivalent defaults (run_contract_tests.sh sections 11 and 12).

Usage: scan_privileges.py CHECK PATH...   exit 0 = clean, 1 = hits (printed as file:line).

Only settings count, not their description: comment lines, Markdown, the tests and
scripts/cleanup_legacy_privileges.py (which names what it removes) are skipped.
"""

import re
import subprocess
import sys
from pathlib import Path

CHECKS = {
    # A sudoers rule without a password for every command (NOPASSWD:ALL / NOPASSWD: ALL), or any
    # NOPASSWD rule for the "nopasswd" check.
    "nopasswd": re.compile(r"\bNOPASSWD\s*:"),
    # A fixed password handed to chpasswd (echo "user:password" | chpasswd).
    "known-password": re.compile(r"""echo\s+["']?[^"'\s:]+:[^"'\s]+["']?\s*\|\s*chpasswd"""),
    # A console autologin for a fixed user (the kit's display_settings uses {{ target_user }}).
    "autologin-ubuntu": re.compile(r"--autologin\s+ubuntu\b"),
    # The legacy .pkla grants: passwordless pkexec, or any Result*=yes.
    "broad-polkit": re.compile(r"org\.freedesktop\.policykit\.exec|^Result(Any|Inactive|Active)=yes"),
}
SKIP_NAMES = {"cleanup_legacy_privileges.py", "scan_privileges.py"}


def files(paths):
    listed = subprocess.run(["git", "ls-files", "--", *paths], capture_output=True, text=True,
                            check=True).stdout.split()
    for name in listed:
        path = Path(name)
        if path.suffix == ".md" or path.name in SKIP_NAMES or path.name.startswith("test_") \
                or "tests" in path.parts or not path.is_file():
            continue
        yield path


def main(argv):
    check, paths = argv[1], argv[2:]
    pattern = CHECKS[check]
    hits = []
    for path in files(paths):
        try:
            lines = path.read_text().splitlines()
        except UnicodeDecodeError:
            continue
        for number, line in enumerate(lines, 1):
            stripped = line.strip()
            if stripped.startswith(("#", "//")):
                continue
            if pattern.search(stripped):
                hits.append(f"{path}:{number}")
    print("\n".join(hits))
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
