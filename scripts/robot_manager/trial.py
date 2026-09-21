"""Classroom trial evidence helpers for the robot_manager rosbag recorder.

The classroom A/B workflow (observe → change one variable → retry → compare →
decide → return to baseline) needs a recorded bag to stay meaningful after the
lesson. This module produces the *evidence* that travels with the bag: exact
source identity, the effective parameters before and after the run, the runtime
ROS environment, the topic list at start, and a bag integrity check.

Design constraints (see issue #150):

* **Completely passive.** Nothing here publishes a command, sets a parameter,
  triggers a lifecycle transition, clears an E-stop or opens a serial device.
  Every ROS call is a read (``topic list`` / ``node list`` / ``param dump`` /
  ``bag info``).
* **No second recording authority.** ``recorder.py`` owns the single
  ``ros2 bag record`` process, its lock and its state; this module only writes
  sidecar files next to the bag that recorder produces.
* **rosbag2 owns ``metadata.yaml``.** Sidecars never overwrite it.
"""

import os
import re
import shlex
import socket
import subprocess
from dataclasses import dataclass, field
from datetime import datetime
from difflib import unified_diff
from pathlib import Path
from typing import Optional

# Bumped whenever the questix_trial.yaml layout changes incompatibly.
SCHEMA_VERSION = 1

# Evidence is staged under a dot-prefixed directory so the bag list (which skips
# dot entries) never shows it, then moved into the bag directory once rosbag2
# has created it.
STAGING_PREFIX = ".trial_"
STAGING_SUFFIX = ".evidence.tmp"

TRIAL_FILE = "questix_trial.yaml"
SOURCE_FILE = "source_identity.txt"
TOPIC_LIST_FILE = "topic_list.txt"
DRIVE_PARAMS_BEFORE = "drive_params_before.yaml"
DRIVE_PARAMS_AFTER = "drive_params_after.yaml"
JOY_PARAMS_BEFORE = "joy_params_before.yaml"
JOY_PARAMS_AFTER = "joy_params_after.yaml"
PARAM_DIFF_FILE = "parameter_diff.txt"
BAG_INFO_FILE = "bag_info.txt"
RECORDER_LOG_FILE = "recorder.log"

# rosbag2 owns this file; a sidecar must never replace it.
ROSBAG_OWNED_FILES = frozenset({"metadata.yaml"})

DRIVE_NODE = "/drive_component"
JOY_NODE = "/joy_controller"

# A classroom trial is worthless without the drive command/feedback path, so
# these must exist before the recorder process is started.
REQUIRED_NODES = (DRIVE_NODE,)
REQUIRED_TOPICS = ("/target_twist", "/drive_status")
# Recorded when present; their absence is normal (no joystick, no LiDAR, ...).
OPTIONAL_TOPICS = (
    "/joy",
    "/joy_gated",
    "/odom",
    "/emergency_stop",
    "/diagnostics",
    "/parameter_events",
)

ROS_SETUP = "/opt/ros/jazzy/setup.bash"

# Timeouts for the read-only ROS queries (a discovery hiccup must not hang the
# web request or leave the finalize thread running forever).
QUERY_TIMEOUT_SEC = 15
BAG_INFO_TIMEOUT_SEC = 60

# ---------------------------------------------------------------------------
# Metadata validation
# ---------------------------------------------------------------------------

# Only these fields are accepted and stored. Anything else — in particular a
# student name, student number, e-mail address or school name — is rejected at
# the API boundary so it cannot reach disk. There is deliberately no schema slot
# for personally identifiable information.
METADATA_FIELDS = (
    "trial_id",
    "team_id",
    "robot_id",
    "condition_label",
    "floor",
    "payload_kg",
    "battery_voltage",
    "memo",
)

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_SHORT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_MEMO_CONTROL_RE = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]")

_LABEL_MAX = 64
_FLOOR_MAX = 32
_MEMO_MAX = 500
_PAYLOAD_MAX_KG = 500.0
_BATTERY_MAX_V = 100.0

_ABS_PATH_RE = re.compile(r"^/[a-zA-Z0-9_/.~-]*$")


def new_trial_id(now: Optional[datetime] = None) -> str:
    """Return a default trial id derived from the current local time."""
    return f"t{(now or datetime.now()):%Y%m%d_%H%M%S}"


def _clean_text(value: object) -> Optional[str]:
    """Return value as a stripped string, or None when it is empty/absent."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _validate_label(name: str, value: str, max_len: int) -> str:
    if _CONTROL_RE.search(value):
        raise ValueError(f"{name} に使用できない制御文字が含まれています")
    if len(value) > max_len:
        raise ValueError(f"{name} は {max_len} 文字以内にしてください")
    return value


def _validate_number(name: str, value: object, maximum: float) -> float:
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        raise ValueError(f"{name} は数値で入力してください")
    if number != number or number in (float("inf"), float("-inf")):
        raise ValueError(f"{name} は有限の数値で入力してください")
    if not (0.0 <= number <= maximum):
        raise ValueError(f"{name} は 0〜{maximum:g} の範囲で入力してください")
    return number


def validate_metadata(raw: dict) -> dict:
    """Validate classroom metadata, returning only the accepted fields.

    Unknown keys are rejected rather than ignored: the reject is the mechanism
    that keeps PII (names, student numbers, e-mail addresses) out of the
    evidence files. Values are also length/character checked because they end up
    in a YAML sidecar — they are never interpolated into a shell command.
    """
    if not isinstance(raw, dict):
        raise ValueError("trial metadata が不正です")

    unknown = [k for k in raw if k not in METADATA_FIELDS]
    if unknown:
        raise ValueError(
            "使用できない項目です（氏名・学籍番号・メール等の個人情報は保存しません）: "
            + ", ".join(sorted(unknown))
        )

    meta: dict = {}

    trial_id = _clean_text(raw.get("trial_id"))
    if trial_id is not None:
        if not _ID_RE.match(trial_id):
            raise ValueError("trial_id は英数字 / '_' / '-' の1〜64文字にしてください")
        meta["trial_id"] = trial_id

    for key in ("team_id", "robot_id"):
        value = _clean_text(raw.get(key))
        if value is not None:
            if not _SHORT_ID_RE.match(value):
                raise ValueError(f"{key} は英数字 / '_' / '-' の1〜32文字にしてください")
            meta[key] = value

    condition = _clean_text(raw.get("condition_label"))
    if condition is not None:
        meta["condition_label"] = _validate_label("condition_label", condition, _LABEL_MAX)

    floor = _clean_text(raw.get("floor"))
    if floor is not None:
        meta["floor"] = _validate_label("floor", floor, _FLOOR_MAX)

    if _clean_text(raw.get("payload_kg")) is not None:
        meta["payload_kg"] = _validate_number("payload_kg", raw["payload_kg"], _PAYLOAD_MAX_KG)

    if _clean_text(raw.get("battery_voltage")) is not None:
        meta["battery_voltage"] = _validate_number(
            "battery_voltage", raw["battery_voltage"], _BATTERY_MAX_V
        )

    memo = _clean_text(raw.get("memo"))
    if memo is not None:
        if _MEMO_CONTROL_RE.search(memo):
            raise ValueError("memo に使用できない制御文字が含まれています")
        if len(memo) > _MEMO_MAX:
            raise ValueError(f"memo は {_MEMO_MAX} 文字以内にしてください")
        meta["memo"] = memo

    return meta


# ---------------------------------------------------------------------------
# Runtime environment resolution
# ---------------------------------------------------------------------------

@dataclass
class RuntimeEnv:
    """Resolved ROS runtime for one classroom trial.

    ``questix_robot.service`` reads ``launch.env``; the robot_manager service
    does not, so the classroom path resolves it explicitly at every start and
    uses the same environment for discovery, parameter dumps, ``ros2 bag record``
    and ``ros2 bag info``.
    """

    robot_ws: str
    ros_domain_id: Optional[str]
    domain_source: str
    env: dict
    prelude: str
    warnings: list = field(default_factory=list)


def workspace_setup(robot_ws: str) -> str:
    """Return the path of the workspace overlay a classroom trial must source."""
    return f"{robot_ws.rstrip('/')}/install/setup.bash"


def build_prelude(robot_ws: str) -> str:
    """Return the bash prelude that sources ROS 2 and the robot workspace.

    Both overlays are mandatory and every failure exits with its own code
    *before* anything else runs, so a classroom trial can never record from an
    environment that is not the robot's. The preflight query runs through this
    same prelude, which is why a broken environment is reported before any
    recorder process (or even the evidence staging directory) exists.
    """
    ws_setup = workspace_setup(robot_ws)
    return (
        f"if [ ! -f {shlex.quote(ROS_SETUP)} ]; then "
        f'echo "ROS setup not found: {ROS_SETUP}" >&2; exit 90; fi; '
        f"source {shlex.quote(ROS_SETUP)} || exit 91; "
        f"if [ ! -f {shlex.quote(ws_setup)} ]; then "
        f'echo "workspace setup not found: {ws_setup}" >&2; exit 92; fi; '
        f"source {shlex.quote(ws_setup)} || exit 93; "
    )


# Exit codes reserved by build_prelude(); anything else came from the command.
PRELUDE_EXIT_REASONS = {
    90: f"{ROS_SETUP} がありません",
    91: f"{ROS_SETUP} を source できません",
    92: "${ROBOT_WS}/install/setup.bash がありません (ワークスペースをビルドしてください)",
    93: "${ROBOT_WS}/install/setup.bash を source できません",
}


def explain_prelude_exit(code: int, stderr: str = "") -> str:
    """Describe why the ROS environment could not be prepared."""
    known = PRELUDE_EXIT_REASONS.get(code)
    if known:
        return known
    detail = (stderr or "").strip().splitlines()
    return detail[-1] if detail else f"code {code}"


def resolve_runtime_env(launch_env: dict, base_env: Optional[dict] = None) -> RuntimeEnv:
    """Resolve ROBOT_WS / ROS_DOMAIN_ID from launch.env into a child environment.

    The returned ``env`` is what every child process of a classroom trial gets,
    so the recorder joins the same ROS graph as the robot rather than whatever
    domain the web service happened to inherit.
    """
    base = dict(os.environ if base_env is None else base_env)
    warnings: list = []

    robot_ws = (launch_env.get("ROBOT_WS") or "").strip()
    if not robot_ws:
        robot_ws = base.get("ROBOT_WS", "/home/ubuntu/robot_ws")
        warnings.append("launch.env に ROBOT_WS がないため既定値を使用しました")
    if not _ABS_PATH_RE.match(robot_ws):
        raise ValueError("launch.env の ROBOT_WS が不正です")

    domain = (launch_env.get("ROS_DOMAIN_ID") or "").strip()
    source = "launch.env"
    if not domain:
        domain = (base.get("ROS_DOMAIN_ID") or "").strip()
        source = "process_env" if domain else "ros_default"
        warnings.append(
            "launch.env に ROS_DOMAIN_ID がないため "
            + ("プロセス環境の値" if source == "process_env" else "ROS既定値")
            + "を使用しました"
        )
    if domain:
        if not domain.isdigit() or not (0 <= int(domain) <= 232):
            raise ValueError("ROS_DOMAIN_ID が不正です (0-232)")

    env = dict(base)
    env["ROBOT_WS"] = robot_ws
    if domain:
        env["ROS_DOMAIN_ID"] = domain
    else:
        env.pop("ROS_DOMAIN_ID", None)

    return RuntimeEnv(
        robot_ws=robot_ws,
        ros_domain_id=domain or None,
        domain_source=source,
        env=env,
        prelude=build_prelude(robot_ws),
        warnings=warnings,
    )


def run_shell(runtime: RuntimeEnv, body: str, timeout: int = QUERY_TIMEOUT_SEC):
    """Run `body` after the runtime prelude. Returns ``(returncode, stdout, stderr)``.

    ``body`` is always a constant defined in this module or a shell-quoted
    read-only command built by :func:`run_ros`; it never carries user input.
    """
    try:
        proc = subprocess.run(
            ["bash", "-lc", runtime.prelude + body],
            env=runtime.env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s"
    except OSError as exc:
        return 127, "", str(exc)
    return proc.returncode, proc.stdout, proc.stderr


def run_ros(runtime: RuntimeEnv, argv: list, timeout: int = QUERY_TIMEOUT_SEC):
    """Run a read-only ROS command inside the resolved runtime environment.

    Returns ``(returncode, stdout, stderr)``. Arguments are shell-quoted; this
    function is only ever given query commands (``topic list``, ``node list``,
    ``param dump``, ``bag info``).
    """
    return run_shell(runtime, "exec " + " ".join(shlex.quote(a) for a in argv), timeout)


# The environment the recorder actually sees, read from inside the sourced
# shell: setup.bash defines ROS_DISTRO and can change the discovery settings, so
# the pre-source environment is not evidence of how the bag was recorded.
EFFECTIVE_ENV_KEYS = (
    "ROS_DISTRO",
    "ROS_DOMAIN_ID",
    "RMW_IMPLEMENTATION",
    "ROS_LOCALHOST_ONLY",
    "ROS_AUTOMATIC_DISCOVERY_RANGE",
    "ROS_STATIC_PEERS",
)

_ENV_DUMP_SCRIPT = (
    "for __questix_key in " + " ".join(EFFECTIVE_ENV_KEYS) + "; do "
    "printf '%s=%s\\n' \"$__questix_key\" \"$(printenv \"$__questix_key\" || true)\"; "
    "done"
)


def query_effective_env(runtime: RuntimeEnv) -> tuple:
    """Read the ROS environment as it exists *after* sourcing, plus any warning.

    Returns ``(env_dict, warnings)``; only non-empty values are reported so an
    unset discovery setting is not recorded as if it had been configured.
    """
    code, out, err = run_shell(runtime, _ENV_DUMP_SCRIPT)
    if code != 0:
        return {}, [f"実行時ROS環境を取得できませんでした: {explain_prelude_exit(code, err)}"]

    effective: dict = {}
    for line in out.splitlines():
        key, _, value = line.partition("=")
        if key in EFFECTIVE_ENV_KEYS and value.strip():
            effective[key] = value.strip()

    warnings: list = []
    expected = runtime.ros_domain_id or "0"
    if effective.get("ROS_DOMAIN_ID", "0") != expected:
        warnings.append(
            "実行時 ROS_DOMAIN_ID が解決値と異なります: "
            f"{effective.get('ROS_DOMAIN_ID', 'unset')} != {expected}"
        )
    return effective, warnings


# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

def parse_name_list(text: str) -> list:
    """Parse the output of ``ros2 topic list`` / ``ros2 node list``."""
    return [line.strip() for line in (text or "").splitlines() if line.strip().startswith("/")]


def classify_preflight(nodes: list, topics: list) -> dict:
    """Split discovered nodes/topics into required, optional and missing sets."""
    node_set = set(nodes)
    topic_set = set(topics)
    missing = [n for n in REQUIRED_NODES if n not in node_set]
    missing += [t for t in REQUIRED_TOPICS if t not in topic_set]
    return {
        "nodes": sorted(node_set),
        "topics": sorted(topic_set),
        "required_present": [n for n in REQUIRED_NODES if n in node_set]
        + [t for t in REQUIRED_TOPICS if t in topic_set],
        "missing_required": missing,
        "optional_present": [t for t in OPTIONAL_TOPICS if t in topic_set],
        "optional_missing": [t for t in OPTIONAL_TOPICS if t not in topic_set],
        "joy_node_present": JOY_NODE in node_set,
    }


# ---------------------------------------------------------------------------
# Source provenance
# ---------------------------------------------------------------------------

def _git(repo_dir: Path, args: list, timeout: int = 10):
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo_dir), *args],
            capture_output=True, text=True, timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip()


# launch.env key that pins the QUESTiX source checkout explicitly. Optional: it
# only has to be set when the workspace layout cannot be discovered.
SOURCE_DIR_ENV_KEY = "QUESTIX_SOURCE_DIR"

# A directory is the QUESTiX source tree when it carries both of these; checked
# at the git top level so a candidate anywhere inside the checkout resolves.
SOURCE_MARKERS = ("launcher/package.xml", "systemd/questix_robot_launcher.sh")


def is_questix_source(root: Path) -> bool:
    """Return True when root is a QUESTiX source checkout."""
    try:
        return all((root / marker).is_file() for marker in SOURCE_MARKERS)
    except OSError:
        return False


def git_toplevel(path: Path) -> Optional[Path]:
    """Return the git work tree root containing path, or None."""
    root = _git(path, ["rev-parse", "--show-toplevel"])
    return Path(root) if root else None


def source_candidates(robot_ws: str, launch_env: dict, manager_dir: Path) -> list:
    """List the places to look for the QUESTiX checkout, most authoritative first.

    The repository's setup guarantees that ``ROBOT_WS`` is configured and that
    ``${ROBOT_WS}/src`` exists — not that the checkout sits at any particular
    path inside it, and not that the workspace root is separate from the
    checkout. So the workspace root itself is a candidate before its ``src``
    children, and no candidate is matched by name: each one has to be a git work
    tree whose top level carries the QUESTiX markers.

    The installed Robot Manager lives in ``/opt/questix_robot/robot_manager``
    (and in site-packages), which is not a git checkout, so its own location is
    the *last* candidate rather than the authority.
    """
    candidates: list = []
    seen: set = set()

    def add(path: Path, origin: str) -> None:
        # The same directory can be reached twice (e.g. QUESTIX_SOURCE_DIR set
        # to ROBOT_WS); keep the first, most authoritative origin only.
        key = str(path)
        if key in seen:
            return
        seen.add(key)
        candidates.append((path, origin))

    explicit = (launch_env.get(SOURCE_DIR_ENV_KEY) or "").strip()
    if explicit:
        if not _ABS_PATH_RE.match(explicit):
            raise ValueError(f"launch.env の {SOURCE_DIR_ENV_KEY} が不正です")
        add(Path(explicit), f"launch.env:{SOURCE_DIR_ENV_KEY}")

    # The workspace the robot actually runs from. It is the checkout itself in
    # some deployments; in others it holds the checkout under src/ (with
    # `colcon build --symlink-install`, src/<repo> is the live source tree).
    workspace = Path(robot_ws.rstrip("/"))
    add(workspace, "robot_ws")
    try:
        children = sorted(p for p in (workspace / "src").iterdir() if p.is_dir())
    except OSError:
        children = []
    for child in children:
        add(child, "robot_ws/src")

    add(manager_dir, "robot_manager_tree")
    return candidates


def resolve_source_repo(robot_ws: str, launch_env: dict, manager_dir: Path) -> dict:
    """Find the QUESTiX checkout the running robot was built from.

    Returns ``{"root", "origin", "searched"}`` with ``root`` None when no
    candidate is both a git checkout and a QUESTiX source tree. An unresolved
    source is reported as such, never silently recorded as "unknown".
    """
    searched: list = []
    for path, origin in source_candidates(robot_ws, launch_env, manager_dir):
        searched.append(str(path))
        root = git_toplevel(path)
        if root is None or not is_questix_source(root):
            continue
        return {"root": root, "origin": origin, "searched": searched}
    return {"root": None, "origin": "unresolved", "searched": searched}


def has_exact_commit(identity: dict) -> bool:
    """Return True when the identity carries a full 40-character commit SHA."""
    return bool(re.fullmatch(r"[0-9a-f]{40}", identity.get("commit", "")))


def git_source_identity(repo_dir: Path) -> dict:
    """Collect the exact source identity of the checkout robot_manager runs from.

    The diff body is deliberately not stored — only whether the tree was dirty,
    so a trial can be traced back to a commit without archiving student or
    developer code in the bag.
    """
    identity = {
        "repo_root": "unknown",
        "commit": "unknown",
        "branch": "unknown",
        "dirty": "unknown",
        "describe": "unknown",
    }
    root = _git(repo_dir, ["rev-parse", "--show-toplevel"])
    if root is None:
        return identity
    identity["repo_root"] = root

    commit = _git(repo_dir, ["rev-parse", "HEAD"])
    if commit and re.fullmatch(r"[0-9a-f]{40}", commit):
        identity["commit"] = commit

    branch = _git(repo_dir, ["rev-parse", "--abbrev-ref", "HEAD"])
    if branch:
        identity["branch"] = "detached" if branch == "HEAD" else branch

    status = _git(repo_dir, ["status", "--porcelain"])
    if status is not None:
        identity["dirty"] = "dirty" if status else "clean"

    describe = _git(repo_dir, ["describe", "--tags", "--always"])
    if describe:
        identity["describe"] = describe

    return identity


def source_identity_text(identity: dict, runtime: dict) -> str:
    """Render the human-readable source_identity.txt sidecar."""
    lines = ["QUESTiX classroom trial — source identity", ""]
    for key in ("repo_root", "origin", "commit", "branch", "dirty", "describe"):
        lines.append(f"{key}: {identity.get(key, 'unknown')}")
    lines.append("")
    for key in sorted(runtime):
        lines.append(f"{key}: {runtime[key]}")
    return "\n".join(lines) + "\n"


def hostname() -> str:
    """Return the host name, or 'unknown' when it cannot be determined."""
    try:
        return socket.gethostname() or "unknown"
    except OSError:
        return "unknown"


# ---------------------------------------------------------------------------
# Integrity
# ---------------------------------------------------------------------------

# Tolerant on purpose: `ros2 bag info` formatting has changed between
# distributions, so only "Topic: <name> ... Count: <n>" is relied upon and a
# parse miss degrades to a warning instead of a hard failure.
_BAG_TOPIC_RE = re.compile(r"Topic:\s*(\S+).*?Count:\s*(\d+)")


def parse_bag_info_topics(text: str) -> dict:
    """Extract ``{topic: message_count}`` from ``ros2 bag info`` output."""
    counts: dict = {}
    for line in (text or "").splitlines():
        m = _BAG_TOPIC_RE.search(line)
        if m:
            try:
                counts[m.group(1)] = int(m.group(2))
            except ValueError:
                continue
    return counts


def evaluate_integrity(bag_info_ok: bool, counts: dict, finalize_clean: bool) -> dict:
    """Judge whether the produced bag is usable as classroom evidence.

    ``ok`` requires a readable bag whose required topics actually carry
    messages; an unclean finalize (SIGTERM/SIGKILL escalation) can never be
    ``ok`` because rosbag2 may not have written its summary.
    """
    warnings: list = []
    if not bag_info_ok:
        return {
            "status": "failed",
            "topic_counts": counts,
            "warnings": ["ros2 bag info を実行できませんでした"],
        }

    if not counts:
        warnings.append("ros2 bag info からトピック件数を読み取れませんでした")
    for topic in REQUIRED_TOPICS:
        if topic not in counts:
            warnings.append(f"必須トピックがバッグにありません: {topic}")
        elif counts[topic] <= 0:
            warnings.append(f"必須トピックのメッセージが0件です: {topic}")
    if not finalize_clean:
        warnings.append("SIGINT で終了できず強制終了したため、バッグが未確定の可能性があります")

    return {
        "status": "ok" if not warnings else "warning",
        "topic_counts": counts,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Minimal YAML writer (avoids adding a PyYAML dependency to the robot image)
# ---------------------------------------------------------------------------

_YAML_ESCAPES = {"\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def _yaml_scalar(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    text = str(value)
    out = []
    for ch in text:
        if ch in _YAML_ESCAPES:
            out.append(_YAML_ESCAPES[ch])
        elif ord(ch) < 0x20 or ord(ch) == 0x7F:
            out.append(f"\\x{ord(ch):02x}")
        else:
            out.append(ch)
    return '"' + "".join(out) + '"'


def to_yaml(data, indent: int = 0) -> str:
    """Serialize nested dicts/lists/scalars as YAML with quoted strings."""
    pad = " " * indent
    if isinstance(data, dict):
        if not data:
            return f"{pad}{{}}\n"
        out = ""
        for key, value in data.items():
            if isinstance(value, (dict, list)) and value:
                out += f"{pad}{key}:\n{to_yaml(value, indent + 2)}"
            elif isinstance(value, (dict, list)):
                out += f"{pad}{key}: {'{}' if isinstance(value, dict) else '[]'}\n"
            else:
                out += f"{pad}{key}: {_yaml_scalar(value)}\n"
        return out
    if isinstance(data, list):
        if not data:
            return f"{pad}[]\n"
        out = ""
        for item in data:
            if isinstance(item, (dict, list)):
                nested = to_yaml(item, indent + 2)
                out += f"{pad}-\n{nested}"
            else:
                out += f"{pad}- {_yaml_scalar(item)}\n"
        return out
    return f"{pad}{_yaml_scalar(data)}\n"


# ---------------------------------------------------------------------------
# Filesystem helpers
# ---------------------------------------------------------------------------

def atomic_write_text(path: Path, text: str) -> None:
    """Write text via a temporary file + rename so readers never see a partial file."""
    tmp = path.with_name(path.name + ".part")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def staging_name(base: str, attempt: int = 1) -> str:
    """Return the hidden staging directory name for a recording session."""
    suffix = "" if attempt <= 1 else f".{attempt}"
    return f"{STAGING_PREFIX}{base}{suffix}{STAGING_SUFFIX}"


def create_staging_dir(output_dir: Path, base: str, limit: int = 100) -> Path:
    """Create and return a staging directory that no other session is using.

    The name is derived from the (already collision-safe) bag name and created
    exclusively, so a stale staging directory left behind by a failed start can
    never be reused and mix its evidence into the next trial.
    """
    for attempt in range(1, limit + 1):
        candidate = output_dir / staging_name(base, attempt)
        try:
            candidate.mkdir(parents=True)
            return candidate
        except FileExistsError:
            continue
    raise OSError("evidence置き場の名前を確保できませんでした")


def unique_bag_name(output_dir: Path, base: str, suffix: str = "", limit: int = 100) -> str:
    """Return a bag directory name under output_dir that does not exist yet.

    rosbag2 refuses to record into an existing directory, and an existing bag
    must never be overwritten, so a collision falls back to the trial id and
    then to a numeric suffix.
    """
    if not (output_dir / base).exists():
        return base
    if suffix:
        candidate = f"{base}_{suffix}"
        if not (output_dir / candidate).exists():
            return candidate
    for n in range(2, limit + 1):
        candidate = f"{base}_{suffix}_{n}" if suffix else f"{base}_{n}"
        if not (output_dir / candidate).exists():
            return candidate
    raise OSError("バッグ名の重複を解消できませんでした")


def move_sidecars(staging: Path, bag_dir: Path) -> dict:
    """Move staged evidence files into the bag directory.

    ``metadata.yaml`` belongs to rosbag2 and is never replaced. Files that
    cannot be moved stay in staging: a partial failure keeps its evidence rather
    than deleting it.
    """
    moved: list = []
    skipped: list = []
    if not bag_dir.is_dir():
        return {"moved": moved, "skipped": skipped, "staging_kept": True}
    for entry in sorted(staging.iterdir()) if staging.is_dir() else []:
        if not entry.is_file():
            skipped.append(entry.name)
            continue
        if entry.name in ROSBAG_OWNED_FILES:
            skipped.append(entry.name)
            continue
        try:
            os.replace(entry, bag_dir / entry.name)
            moved.append(entry.name)
        except OSError:
            skipped.append(entry.name)
    kept = True
    if staging.is_dir() and not skipped:
        try:
            staging.rmdir()
            kept = False
        except OSError:
            kept = True
    return {"moved": moved, "skipped": skipped, "staging_kept": kept}


def unified_diff_text(before: str, after: str, label_before: str, label_after: str) -> str:
    """Return a unified diff of two parameter dumps ('' when they are identical)."""
    diff = list(unified_diff(
        (before or "").splitlines(keepends=True),
        (after or "").splitlines(keepends=True),
        fromfile=label_before,
        tofile=label_after,
    ))
    return "".join(diff)


def classify_exit_reason(
    returncode: Optional[int], max_duration_sec: int, elapsed_sec: float
) -> str:
    """Classify why a recorder process ended on its own.

    ``--max-bag-duration`` makes the recorder exit cleanly once the configured
    duration elapses; anything else is an abnormal exit.
    """
    if max_duration_sec > 0 and elapsed_sec >= max_duration_sec - 2 and returncode in (0, None):
        return "max_duration"
    return "process_exited"
