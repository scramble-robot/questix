#!/usr/bin/env python3
# Resolves the effective ROS_DOMAIN_ID for a QUESTiX Raspberry Pi 5 kitting run.
#
# Responsibilities: read persisted state (launch.env, target user's ~/.bashrc
# managed block), validate, detect conflicts, apply legacy/default (42)
# handling, apply an explicit override, prompt interactively when a human
# decision is required, warn on the ROS 2 default domain (0), and print the
# final resolved integer.
#
# This script never writes to launch.env or .bashrc. Deploying the resolved
# value is Ansible's responsibility (robot_autostart / robotics_workspace
# roles), so re-running this resolver never has side effects on its own.
#
# stdout contract: the final resolved integer only, nothing else. Prompts,
# warnings, diagnostics, and conflict explanations all go to stderr, so
# `ROS_DOMAIN_ID="$(resolve_ros_domain_id.py)"` stays safe to use from
# setup.sh even while a human is being prompted.

import argparse
import os
import re
import sys

# Allowed ROS_DOMAIN_ID values, chosen to stay inside the standard Linux
# ephemeral port range (32768-60999) per the DDS/RTPS discovery port formula
# (7400 + 250 * domain_id [+ 2 for user traffic]); see
# ansible/playbooks/vars/README.md for the derivation.
ALLOWED_RANGES = ((0, 101), (215, 232))
LEGACY_DOMAIN_ID = 42
STANDARD_EPHEMERAL_RANGE = (32768, 60999)
EPHEMERAL_RANGE_PATH = "/proc/sys/net/ipv4/ip_local_port_range"

BASHRC_BEGIN_MARKER = "# BEGIN ANSIBLE MANAGED BLOCK - ROS2 Robotics Kit"
BASHRC_END_MARKER = "# END ANSIBLE MANAGED BLOCK - ROS2 Robotics Kit"

DEFAULT_LAUNCH_ENV_PATH = "/etc/questix_robot/launch.env"


class ResolutionError(Exception):
    """Raised when the domain ID cannot be resolved (caller should exit non-zero)."""


def eprint(message):
    print(message, file=sys.stderr)


def is_in_allowed_range(value):
    return any(low <= value <= high for low, high in ALLOWED_RANGES)


def parse_strict_int(raw):
    """Parse a plain (optionally quoted) integer string; reject anything else."""
    if raw is None:
        return None
    text = raw.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        text = text[1:-1].strip()
    if re.fullmatch(r"-?[0-9]+", text):
        return int(text)
    return None


def classify_domain_id(raw):
    """Classify a raw string as ('missing'|'invalid'|'valid', int_value_or_None)."""
    if raw is None:
        return "missing", None
    value = parse_strict_int(raw)
    if value is None or not is_in_allowed_range(value):
        return "invalid", None
    return "valid", value


def _split_lines(content):
    return content.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def _last_assignment(lines, key):
    """Return (raw_value_or_None, occurrence_count) for `key=value` lines.

    Comment lines are ignored. When a key is assigned more than once, bash
    `source` honors the last occurrence, so we mirror that instead of
    guessing which line is authoritative.
    """
    pattern = re.compile(r"^" + re.escape(key) + r"=(.*)$")
    matches = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        m = pattern.match(stripped)
        if m:
            matches.append(m.group(1))
    if not matches:
        return None, 0
    return matches[-1], len(matches)


def read_launch_env_domain_id(path, warn):
    try:
        with open(path, "r", newline="", encoding="utf-8") as fh:
            content = fh.read()
    except FileNotFoundError:
        return None
    except (OSError, UnicodeDecodeError) as exc:
        # Distinct from "missing": the file exists but we could not read it
        # (permissions, a directory in its place, bad encoding, ...). This
        # must not be silently treated the same as an absent file.
        raise ResolutionError(f"Could not read {path}: {exc}") from None
    lines = _split_lines(content)
    value, count = _last_assignment(lines, "ROS_DOMAIN_ID")
    if count > 1:
        warn(
            f"{path}: found {count} ROS_DOMAIN_ID assignments; using the last "
            "one (matches bash `source` semantics)."
        )
    return value


def _extract_managed_blocks(content):
    blocks = []
    current = None
    for line in _split_lines(content):
        if line.strip() == BASHRC_BEGIN_MARKER:
            current = []
            continue
        if line.strip() == BASHRC_END_MARKER:
            if current is not None:
                blocks.append(current)
            current = None
            continue
        if current is not None:
            current.append(line)
    return blocks


def read_bashrc_domain_id(path, warn):
    try:
        with open(path, "r", newline="", encoding="utf-8") as fh:
            content = fh.read()
    except FileNotFoundError:
        return None
    except (OSError, UnicodeDecodeError) as exc:
        # See read_launch_env_domain_id: "unreadable" must not collapse into
        # "missing".
        raise ResolutionError(f"Could not read {path}: {exc}") from None
    blocks = _extract_managed_blocks(content)
    if not blocks:
        return None
    if len(blocks) > 1:
        warn(
            f"{path}: found {len(blocks)} ANSIBLE MANAGED BLOCK sections; "
            "using the last one."
        )
    value, count = _last_assignment(blocks[-1], "export ROS_DOMAIN_ID")
    if count > 1:
        warn(
            f"{path}: found {count} ROS_DOMAIN_ID exports inside the managed "
            "block; using the last one."
        )
    return value


def check_ephemeral_range(warn, path=EPHEMERAL_RANGE_PATH):
    try:
        with open(path, "r") as fh:
            parts = fh.read().split()
        low, high = int(parts[0]), int(parts[1])
    except (OSError, IndexError, ValueError):
        warn(
            f"Could not read/parse {path}; unable to confirm that the "
            "configured allowed ROS_DOMAIN_ID range assumes the standard "
            "Linux ephemeral port range."
        )
        return
    if (low, high) != STANDARD_EPHEMERAL_RANGE:
        warn(
            f"Ephemeral port range is {low}-{high}, not the standard "
            f"{STANDARD_EPHEMERAL_RANGE[0]}-{STANDARD_EPHEMERAL_RANGE[1]}. "
            "The configured allowed ROS_DOMAIN_ID range assumes the "
            "standard Linux ephemeral port range."
        )


def _read_answer_or_raise_on_eof(read_line, context):
    """Read one line, distinguishing EOF ("") from a blank Enter ("\\n").

    read_line() returning the empty string means stdin was closed (EOF), not
    that the user pressed Enter. Conflating the two would let a closed/piped
    stdin silently pick "keep the current value" (or spin forever re-prompting
    on an already-exhausted stream) instead of failing loudly.
    """
    raw = read_line()
    if raw == "":
        raise ResolutionError(
            f"Input closed (EOF) while {context}; refusing to guess. "
            "Re-run interactively, or set QUESTIX_ROS_DOMAIN_ID=<id> explicitly."
        )
    return raw.strip()


def _prompt_for_new_value(warn, read_line, intro_lines):
    for line in intro_lines:
        warn(line)
    while True:
        warn("Enter ROS_DOMAIN_ID (0-101 or 215-232): ")
        answer = _read_answer_or_raise_on_eof(read_line, "waiting for a ROS_DOMAIN_ID")
        state, value = classify_domain_id(answer)
        if state == "valid":
            return value
        warn(f"'{answer}' is not a valid ROS_DOMAIN_ID (0-101 or 215-232). Try again.")


def _confirm_or_change(warn, read_line, candidate, intro_lines):
    for line in intro_lines:
        warn(line)
    while True:
        warn(f"Press Enter to keep {candidate}, or type a new ROS_DOMAIN_ID (0-101 or 215-232): ")
        answer = _read_answer_or_raise_on_eof(read_line, "confirming ROS_DOMAIN_ID")
        if answer == "":
            return candidate
        state, value = classify_domain_id(answer)
        if state == "valid":
            return value
        warn(f"'{answer}' is not a valid ROS_DOMAIN_ID (0-101 or 215-232). Try again.")


def _require_interactive(interactive, message):
    if not interactive:
        raise ResolutionError(
            message + " Re-run interactively, or set QUESTIX_ROS_DOMAIN_ID=<id> explicitly."
        )


def _finalize(warn, value):
    if value == 0:
        warn("ROS_DOMAIN_ID=0 overlaps the ROS 2 default domain; proceeding with a warning.")
    return value


def resolve(override_raw, launch_raw, bashrc_raw, interactive, read_line, warn):
    """Resolve the effective ROS_DOMAIN_ID, or raise ResolutionError."""
    if override_raw is not None:
        state, value = classify_domain_id(override_raw)
        if state != "valid":
            raise ResolutionError(
                f"QUESTIX_ROS_DOMAIN_ID override '{override_raw}' is invalid; "
                "must be an integer in 0-101 or 215-232."
            )
        if value == LEGACY_DOMAIN_ID:
            warn(
                f"Explicit override to legacy/default domain {LEGACY_DOMAIN_ID} "
                "accepted without interactive confirmation."
            )
        return _finalize(warn, value)

    launch_state, launch_value = classify_domain_id(launch_raw)
    bashrc_state, bashrc_value = classify_domain_id(bashrc_raw)

    if launch_state == "missing" and bashrc_state == "missing":
        _require_interactive(
            interactive, "No persisted ROS_DOMAIN_ID found in launch.env or ~/.bashrc."
        )
        value = _prompt_for_new_value(
            warn, read_line, ["No persisted ROS_DOMAIN_ID found in launch.env or ~/.bashrc."]
        )
        return _finalize(warn, value)

    if launch_state == "valid" and bashrc_state == "valid":
        if launch_value == bashrc_value:
            candidate = launch_value
        else:
            _require_interactive(
                interactive,
                f"ROS_DOMAIN_ID conflict: launch.env={launch_value}, "
                f"~/.bashrc={bashrc_value}. Refusing to pick one silently.",
            )
            value = _confirm_or_change(
                warn,
                read_line,
                launch_value,
                [
                    f"ROS_DOMAIN_ID conflict: launch.env={launch_value}, "
                    f"~/.bashrc={bashrc_value}.",
                    "This will not be resolved silently.",
                ],
            )
            return _finalize(warn, value)
    elif launch_state == "valid" and bashrc_state == "missing":
        candidate = launch_value
    elif bashrc_state == "valid" and launch_state == "missing":
        candidate = bashrc_value
    else:
        # At least one side is present but malformed/out-of-range. This is
        # deliberately NOT treated the same as "one side simply unset" -
        # a corrupt persisted value must never be silently ignored.
        diagnostics = []
        if launch_state == "invalid":
            diagnostics.append(f"launch.env has a malformed/out-of-range ROS_DOMAIN_ID: {launch_raw!r}")
        if bashrc_state == "invalid":
            diagnostics.append(
                f"~/.bashrc managed block has a malformed/out-of-range ROS_DOMAIN_ID: {bashrc_raw!r}"
            )
        valid_side_value = (
            launch_value if launch_state == "valid"
            else bashrc_value if bashrc_state == "valid"
            else None
        )
        if valid_side_value is not None:
            diagnostics.append(
                "One persisted source is valid and the other is invalid; this "
                "is not treated as a simple missing value."
            )
            _require_interactive(interactive, " ".join(diagnostics))
            value = _confirm_or_change(warn, read_line, valid_side_value, diagnostics)
            return _finalize(warn, value)
        diagnostics.append("Both persisted sources are invalid.")
        _require_interactive(interactive, " ".join(diagnostics))
        value = _prompt_for_new_value(warn, read_line, diagnostics)
        return _finalize(warn, value)

    if candidate == LEGACY_DOMAIN_ID:
        _require_interactive(
            interactive,
            f"Persisted ROS_DOMAIN_ID is {LEGACY_DOMAIN_ID} (legacy/default); "
            "keeping or changing it requires an explicit decision.",
        )
        value = _confirm_or_change(
            warn,
            read_line,
            candidate,
            [
                f"Persisted ROS_DOMAIN_ID is {LEGACY_DOMAIN_ID} (legacy/default "
                "bootstrap value). Keep it, or change to a robot-specific ID?",
            ],
        )
        return _finalize(warn, value)

    return _finalize(warn, candidate)


def build_arg_parser():
    parser = argparse.ArgumentParser(
        description="Resolve the effective ROS_DOMAIN_ID for QUESTiX kitting."
    )
    parser.add_argument("--launch-env-path", default=DEFAULT_LAUNCH_ENV_PATH)
    parser.add_argument("--bashrc-path", default=os.path.expanduser("~/.bashrc"))
    parser.add_argument(
        "--override",
        default=None,
        help="Defaults to $QUESTIX_ROS_DOMAIN_ID if unset.",
    )
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="Force non-interactive mode regardless of stdin.",
    )
    return parser


def main(argv=None):
    args = build_arg_parser().parse_args(argv)
    override = args.override
    if override is None:
        override = os.environ.get("QUESTIX_ROS_DOMAIN_ID")
    interactive = (not args.non_interactive) and sys.stdin.isatty()

    check_ephemeral_range(eprint)

    try:
        if override is not None:
            # An explicit override is authoritative on its own; it must not
            # depend on launch.env/bashrc being present or even readable.
            value = resolve(override, None, None, interactive, sys.stdin.readline, eprint)
        else:
            launch_raw = read_launch_env_domain_id(args.launch_env_path, eprint)
            bashrc_raw = read_bashrc_domain_id(args.bashrc_path, eprint)
            value = resolve(None, launch_raw, bashrc_raw, interactive, sys.stdin.readline, eprint)
    except ResolutionError as exc:
        eprint(f"ERROR: {exc}")
        return 1

    print(value)
    return 0


if __name__ == "__main__":
    sys.exit(main())
