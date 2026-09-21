"""Tests for the classroom trial evidence path of the rosbag recorder.

Covers the parts that can be verified without a robot, with the emphasis on
*attribution*: that each piece of evidence belongs to the trial it claims to
describe. Live recording, SIGINT finalize, low-disk auto-stop and MCAP
readability remain Raspberry Pi 5 validation items.
"""

import ast
import contextlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from test_support import install_stubs  # noqa: E402

install_stubs()

from fastapi import HTTPException  # noqa: E402  (import after stub installation)
from robot_manager import recorder, trial  # noqa: E402

DRIVE_DUMP_BEFORE = "/drive_component:\n  ros__parameters:\n    max_speed: 1.0\n"
DRIVE_DUMP_AFTER = "/drive_component:\n  ros__parameters:\n    max_speed: 1.5\n"
JOY_DUMP = "/joy_controller:\n  ros__parameters:\n    deadzone: 0.1\n"
BAG_INFO_OK = (
    "Files:             robot1_0.mcap\n"
    "Storage id:        mcap\n"
    "Topic information: Topic: /target_twist | Type: geometry_msgs/msg/Twist | Count: 300 |"
    " Serialization Format: cdr\n"
    "                   Topic: /drive_status | Type: std_msgs/msg/String | Count: 30 |"
    " Serialization Format: cdr\n"
)

DEFAULT_TOPICS = ["/target_twist", "/drive_status", "/joy", "/parameter_events"]
DEFAULT_NODES = ["/drive_component", "/joy_controller"]
FAKE_SHA = "a" * 40
FAKE_EFFECTIVE_ENV = {"ROS_DISTRO": "jazzy", "ROS_DOMAIN_ID": "42",
                      "RMW_IMPLEMENTATION": "rmw_fastrtps_cpp"}


class FakeProc:
    """Stand-in for the ``ros2 bag record`` process."""

    def __init__(self, exits_immediately=False, returncode=0):
        self.pid = 424242
        self._code = returncode
        self._alive = not exits_immediately

    def poll(self):
        return None if self._alive else self._code

    def wait(self, timeout=None):
        self._alive = False
        return self._code

    @property
    def returncode(self):
        return None if self._alive else self._code


class CapturedThread:
    """Thread substitute that records targets instead of running them."""

    started: list = []

    def __init__(self, target=None, args=(), daemon=None, **kwargs):
        self.target = target
        self.args = args

    def start(self):
        CapturedThread.started.append((self.target, self.args))

    def is_alive(self):
        return False

    @classmethod
    def pending(cls, wanted):
        """Return True when a call to `wanted` was captured but not yet run."""
        return any(target is wanted for target, _args in cls.started)

    @classmethod
    def run_pending(cls, wanted):
        """Run the captured calls whose target is `wanted` and drop them."""
        remaining = []
        for target, args in cls.started:
            if target is wanted:
                target(*args)
            else:
                remaining.append((target, args))
        cls.started = remaining


def fake_run_ros(topics=None, nodes=None, drive_dumps=None, joy_dump=JOY_DUMP,
                 bag_info=BAG_INFO_OK, topic_list_code=0, bag_info_code=0):
    """Build a `trial.run_ros` substitute answering the read-only ROS queries."""
    topics = DEFAULT_TOPICS if topics is None else topics
    nodes = DEFAULT_NODES if nodes is None else nodes
    dumps = list(drive_dumps if drive_dumps is not None else [DRIVE_DUMP_BEFORE, DRIVE_DUMP_AFTER])
    calls: list = []

    def run_ros(runtime, argv, timeout=None):
        calls.append(list(argv))
        key = tuple(argv[:3])
        if key == ("ros2", "topic", "list"):
            if topic_list_code != 0:
                return topic_list_code, "", "workspace setup not found"
            return 0, "\n".join(topics) + "\n", ""
        if key == ("ros2", "node", "list"):
            return 0, "\n".join(nodes) + "\n", ""
        if key == ("ros2", "param", "dump"):
            if argv[3] == trial.JOY_NODE:
                return (0, joy_dump, "") if joy_dump else (1, "", "node not found")
            return (0, dumps.pop(0), "") if dumps else (1, "", "no dump left")
        if key == ("ros2", "bag", "info"):
            return bag_info_code, bag_info, "" if bag_info_code == 0 else "unreadable bag"
        raise AssertionError(f"unexpected ROS command: {argv}")

    run_ros.calls = calls
    return run_ros


class TrialFixture(unittest.TestCase):
    """Base class wiring recorder globals, config and subprocess seams."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.output_dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.addCleanup(self._reset_state)
        CapturedThread.started = []
        self._reset_state()

    def _reset_state(self):
        # A test that never stops its trial still owns the recorder.log handle.
        if isinstance(recorder._trial, dict) and recorder._trial.get("log") is not None:
            with contextlib.suppress(OSError):
                recorder._trial["log"].close()
        recorder._proc = None
        recorder._bag_name = None
        recorder._bag_path = None
        recorder._started_at = None
        recorder._last_stop_reason = None
        recorder._last_finalize_reason = None
        recorder._mode = None
        recorder._trial = None
        recorder._last_trial = None
        recorder._starting = False
        recorder._capturing = False
        recorder._finalize_thread = None

    def config(self, **overrides):
        config = {
            "VEHICLE_NAME": "robot1",
            "OUTPUT_DIR": str(self.output_dir),
            "EXCLUDE_TOPICS": "/camera/image_raw",
            "MIN_FREE_GB": "0",
            "MAX_SPLIT_MB": "0",
            "MAX_DURATION_SEC": "0",
        }
        config.update(overrides)
        return config

    @contextlib.contextmanager
    def wired(self, run_ros=None, proc=None, launch_env=None, config=None,
              source_repo=None, effective_env=None):
        """Patch config, launch.env, ROS queries, Popen, signals and threads."""
        proc = proc or FakeProc()
        run_ros = run_ros or fake_run_ros()
        launch_env = launch_env or {"ROBOT_WS": "/home/ubuntu/robot_ws", "ROS_DOMAIN_ID": "42"}
        popen_calls: list = []

        def popen(argv, **kwargs):
            popen_calls.append({"argv": argv, "kwargs": kwargs})
            return proc

        resolved = source_repo if source_repo is not None else {
            "root": Path("/home/ubuntu/robot_ws/src/questix"),
            "origin": "robot_ws/src",
            "searched": ["/home/ubuntu/robot_ws/src/questix"],
        }

        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(recorder, "_read_config",
                                             return_value=config or self.config()))
            stack.enter_context(patch.object(recorder, "_read_env_file",
                                             return_value=dict(launch_env)))
            stack.enter_context(patch.object(trial, "run_ros", run_ros))
            stack.enter_context(patch.object(trial, "resolve_source_repo",
                                             return_value=resolved))
            stack.enter_context(patch.object(trial, "git_source_identity", return_value={
                "repo_root": str(resolved["root"]), "commit": FAKE_SHA, "branch": "main",
                "dirty": "clean", "describe": "v1.0.0",
            }))
            stack.enter_context(patch.object(
                trial, "query_effective_env",
                return_value=(dict(effective_env or FAKE_EFFECTIVE_ENV), []),
            ))
            stack.enter_context(patch.object(recorder.subprocess, "Popen", popen))
            stack.enter_context(patch.object(recorder.time, "sleep", lambda *_: None))
            stack.enter_context(patch.object(recorder.os, "getpgid", lambda pid: pid))
            stack.enter_context(patch.object(recorder.os, "killpg", lambda pid, sig: None))
            stack.enter_context(patch.object(recorder.threading, "Thread", CapturedThread))
            yield {"proc": proc, "popen": popen_calls, "run_ros": run_ros}

    def staging_for(self, bag_name):
        return self.output_dir / trial.staging_name(bag_name)

    def stagings(self):
        return sorted(p.name for p in self.output_dir.iterdir()
                      if p.name.startswith(trial.STAGING_PREFIX))


# ---------------------------------------------------------------------------
# Metadata validation / PII
# ---------------------------------------------------------------------------

class MetadataValidationTests(unittest.TestCase):
    """Classroom metadata is whitelisted; PII has no schema slot at all."""

    def test_full_metadata_is_accepted_and_typed(self):
        meta = trial.validate_metadata({
            "trial_id": "t001", "team_id": "teamA", "robot_id": "robot1",
            "condition_label": "最高速 1.5 m/s", "floor": "体育館",
            "payload_kg": "2.5", "battery_voltage": 24.6, "memo": "1行目\n2行目",
        })
        self.assertEqual(meta["trial_id"], "t001")
        self.assertEqual(meta["payload_kg"], 2.5)
        self.assertEqual(meta["battery_voltage"], 24.6)
        self.assertEqual(meta["condition_label"], "最高速 1.5 m/s")

    def test_schema_has_no_pii_fields(self):
        joined = " ".join(trial.METADATA_FIELDS).lower()
        for banned in ("name", "student", "mail", "school", "class_number"):
            self.assertNotIn(banned, joined)

    def test_pii_fields_are_rejected(self):
        for field in ("student_name", "email", "school_name", "student_number"):
            with self.assertRaises(ValueError) as raised:
                trial.validate_metadata({"trial_id": "t1", field: "秘密"})
            self.assertIn(field, str(raised.exception))

    def test_shell_metacharacters_are_rejected(self):
        for value in ("t1; rm -rf /", "$(id)", "a b", "`whoami`", "../escape"):
            with self.assertRaises(ValueError):
                trial.validate_metadata({"trial_id": value})

    def test_control_characters_and_lengths_are_rejected(self):
        with self.assertRaises(ValueError):
            trial.validate_metadata({"condition_label": "bad\x00label"})
        with self.assertRaises(ValueError):
            trial.validate_metadata({"condition_label": "x" * 65})
        with self.assertRaises(ValueError):
            trial.validate_metadata({"memo": "m" * 501})

    def test_numeric_ranges_are_enforced(self):
        for payload in ("-1", "501", "abc", "inf"):
            with self.assertRaises(ValueError):
                trial.validate_metadata({"payload_kg": payload})
        with self.assertRaises(ValueError):
            trial.validate_metadata({"battery_voltage": "101"})

    def test_blank_values_are_dropped(self):
        self.assertEqual(trial.validate_metadata({"team_id": "  ", "memo": ""}), {})

    def test_generated_trial_id_is_safe(self):
        self.assertRegex(trial.new_trial_id(), r"^t\d{8}_\d{6}$")


# ---------------------------------------------------------------------------
# Runtime environment authority
# ---------------------------------------------------------------------------

class RuntimeEnvTests(unittest.TestCase):
    """launch.env is the authority for the classroom recording environment."""

    def test_launch_env_domain_is_used(self):
        rt = trial.resolve_runtime_env(
            {"ROBOT_WS": "/home/ubuntu/robot_ws", "ROS_DOMAIN_ID": "42"},
            {"ROS_DOMAIN_ID": "7"},
        )
        self.assertEqual(rt.ros_domain_id, "42")
        self.assertEqual(rt.env["ROS_DOMAIN_ID"], "42")
        self.assertEqual(rt.domain_source, "launch.env")
        self.assertEqual(rt.warnings, [])

    def test_process_env_is_the_fallback(self):
        rt = trial.resolve_runtime_env({"ROBOT_WS": "/ws"}, {"ROS_DOMAIN_ID": "7"})
        self.assertEqual(rt.ros_domain_id, "7")
        self.assertEqual(rt.domain_source, "process_env")
        self.assertTrue(rt.warnings)

    def test_absent_domain_is_unset_with_warning(self):
        rt = trial.resolve_runtime_env({"ROBOT_WS": "/ws"}, {})
        self.assertIsNone(rt.ros_domain_id)
        self.assertNotIn("ROS_DOMAIN_ID", rt.env)
        self.assertEqual(rt.domain_source, "ros_default")

    def test_invalid_values_are_rejected(self):
        with self.assertRaises(ValueError):
            trial.resolve_runtime_env({"ROBOT_WS": "relative/ws"}, {})
        with self.assertRaises(ValueError):
            trial.resolve_runtime_env({"ROBOT_WS": "/ws", "ROS_DOMAIN_ID": "999"}, {})
        with self.assertRaises(ValueError):
            trial.resolve_runtime_env({"ROBOT_WS": "/ws; rm -rf /"}, {})

    def test_domain_id_reaches_the_child_process(self):
        rt = trial.resolve_runtime_env({"ROBOT_WS": "/ws", "ROS_DOMAIN_ID": "42"}, dict(os.environ))
        rt.prelude = ""  # skip sourcing: this asserts environment propagation only
        code, out, _err = trial.run_ros(rt, ["printenv", "ROS_DOMAIN_ID"])
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "42")


class WorkspaceSourceGateTests(unittest.TestCase):
    """Both ROS overlays are mandatory on the classroom path (real bash)."""

    @contextlib.contextmanager
    def _env(self, ros_setup_body="", ws_setup_body=None):
        with tempfile.TemporaryDirectory() as tmp:
            ros_setup = Path(tmp) / "ros_setup.bash"
            ros_setup.write_text(ros_setup_body)
            workspace = Path(tmp) / "ws"
            workspace.mkdir()
            if ws_setup_body is not None:
                install = workspace / "install"
                install.mkdir()
                (install / "setup.bash").write_text(ws_setup_body)
            with patch.object(trial, "ROS_SETUP", str(ros_setup)):
                yield trial.resolve_runtime_env({"ROBOT_WS": str(workspace)}, {})

    def test_prelude_requires_both_overlays(self):
        prelude = trial.build_prelude("/home/ubuntu/robot_ws")
        self.assertIn("/opt/ros/jazzy/setup.bash", prelude)
        self.assertIn("/home/ubuntu/robot_ws/install/setup.bash", prelude)
        for code in (90, 91, 92, 93):
            self.assertIn(f"exit {code}", prelude)

    def test_missing_ros_setup_exits_90(self):
        rt = trial.resolve_runtime_env({"ROBOT_WS": "/ws"}, {})
        code, _out, err = trial.run_shell(rt, "echo should_not_run")
        self.assertEqual(code, 90)
        self.assertIn("ROS setup not found", err)

    def test_missing_workspace_setup_exits_92(self):
        with self._env() as rt:
            code, out, err = trial.run_shell(rt, "echo should_not_run")
        self.assertEqual(code, 92)
        self.assertIn("workspace setup not found", err)
        self.assertNotIn("should_not_run", out)
        self.assertIn("install/setup.bash がありません", trial.explain_prelude_exit(code))

    def test_failing_workspace_setup_exits_93(self):
        with self._env(ws_setup_body="return 1\n") as rt:
            code, out, _err = trial.run_shell(rt, "echo should_not_run")
        self.assertEqual(code, 93)
        self.assertNotIn("should_not_run", out)

    def test_failing_ros_setup_exits_91(self):
        with self._env(ros_setup_body="return 1\n", ws_setup_body="") as rt:
            code, _out, _err = trial.run_shell(rt, "echo should_not_run")
        self.assertEqual(code, 91)

    def test_both_overlays_present_runs_the_command(self):
        with self._env(ws_setup_body="export QUESTIX_WS_SOURCED=1\n") as rt:
            code, out, _err = trial.run_shell(rt, "printenv QUESTIX_WS_SOURCED")
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "1")

    def test_unknown_exit_code_reports_the_command_error(self):
        self.assertEqual(trial.explain_prelude_exit(1, "boom\n"), "boom")


class EffectiveEnvTests(unittest.TestCase):
    """The recorded ROS environment is the one that exists after sourcing."""

    def test_post_source_values_are_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            ros_setup = Path(tmp) / "ros_setup.bash"
            ros_setup.write_text("export ROS_DISTRO=jazzy\nexport RMW_IMPLEMENTATION=rmw_test\n")
            workspace = Path(tmp) / "ws"
            (workspace / "install").mkdir(parents=True)
            (workspace / "install" / "setup.bash").write_text("")
            with patch.object(trial, "ROS_SETUP", str(ros_setup)):
                rt = trial.resolve_runtime_env(
                    {"ROBOT_WS": str(workspace), "ROS_DOMAIN_ID": "42"}, dict(os.environ)
                )
                effective, warnings = trial.query_effective_env(rt)

        # ROS_DISTRO comes from setup.bash, so it is only visible after sourcing.
        self.assertEqual(effective["ROS_DISTRO"], "jazzy")
        self.assertEqual(effective["RMW_IMPLEMENTATION"], "rmw_test")
        self.assertEqual(effective["ROS_DOMAIN_ID"], "42")
        self.assertEqual(warnings, [])

    def test_domain_id_overridden_by_setup_is_warned_about(self):
        with tempfile.TemporaryDirectory() as tmp:
            ros_setup = Path(tmp) / "ros_setup.bash"
            ros_setup.write_text("export ROS_DOMAIN_ID=7\n")
            workspace = Path(tmp) / "ws"
            (workspace / "install").mkdir(parents=True)
            (workspace / "install" / "setup.bash").write_text("")
            with patch.object(trial, "ROS_SETUP", str(ros_setup)):
                rt = trial.resolve_runtime_env(
                    {"ROBOT_WS": str(workspace), "ROS_DOMAIN_ID": "42"}, dict(os.environ)
                )
                effective, warnings = trial.query_effective_env(rt)

        self.assertEqual(effective["ROS_DOMAIN_ID"], "7")
        self.assertTrue(any("ROS_DOMAIN_ID" in w for w in warnings))

    def test_unusable_environment_is_reported_as_a_warning(self):
        rt = trial.resolve_runtime_env({"ROBOT_WS": "/nonexistent_ws"}, {})
        effective, warnings = trial.query_effective_env(rt)
        self.assertEqual(effective, {})
        self.assertTrue(warnings)


# ---------------------------------------------------------------------------
# Source provenance
# ---------------------------------------------------------------------------

def make_repo(path: Path, questix: bool = True) -> Path:
    """Create a git checkout, optionally carrying the QUESTiX source markers."""
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@e",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@e")
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(path)], check=True, env=env)
    if questix:
        for marker in trial.SOURCE_MARKERS:
            target = path / marker
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("marker\n")
    else:
        (path / "README.md").write_text("other\n")
    subprocess.run(["git", "-C", str(path), "add", "-A"], check=True, env=env)
    subprocess.run(["git", "-C", str(path), "commit", "-q", "-m", "init"], check=True, env=env)
    return path


class SourceIdentityTests(unittest.TestCase):
    """The exact commit is recorded; the diff body never is."""

    def test_clean_checkout_reports_exact_sha_and_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(Path(tmp) / "questix")
            identity = trial.git_source_identity(repo)
            self.assertRegex(identity["commit"], r"^[0-9a-f]{40}$")
            self.assertTrue(trial.has_exact_commit(identity))
            self.assertEqual(identity["branch"], "main")
            self.assertEqual(identity["dirty"], "clean")

    def test_dirty_checkout_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(Path(tmp) / "questix")
            (repo / "README.md").write_text("changed\n")
            self.assertEqual(trial.git_source_identity(repo)["dirty"], "dirty")

    def test_detached_head_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(Path(tmp) / "questix")
            head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"],
                                  capture_output=True, text=True, check=True).stdout.strip()
            subprocess.run(["git", "-C", str(repo), "checkout", "-q", head], check=True)
            self.assertEqual(trial.git_source_identity(repo)["branch"], "detached")

    def test_non_repository_is_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            identity = trial.git_source_identity(Path(tmp) / "nope")
            self.assertEqual(identity["commit"], "unknown")
            self.assertEqual(identity["dirty"], "unknown")
            self.assertFalse(trial.has_exact_commit(identity))

    def test_rendered_text_has_no_diff_body(self):
        text = trial.source_identity_text(
            {"commit": "b" * 40, "branch": "main", "dirty": "dirty", "origin": "robot_ws/src",
             "describe": "v1", "repo_root": "/repo"},
            {"hostname": "questix", "ros_domain_id": "42"},
        )
        self.assertIn("b" * 40, text)
        self.assertIn("origin: robot_ws/src", text)
        self.assertIn("ros_domain_id: 42", text)
        self.assertNotIn("diff --git", text)


class SourceResolutionTests(unittest.TestCase):
    """The active QUESTiX checkout is the authority, not the installed copy."""

    def test_workspace_root_itself_can_be_the_checkout(self):
        with tempfile.TemporaryDirectory() as tmp:
            # ROBOT_WS is the checkout; src/ exists (Ansible creates it) but is empty.
            workspace = make_repo(Path(tmp) / "robot_ws")
            (workspace / "src").mkdir()
            installed = Path(tmp) / "opt" / "robot_manager"
            installed.mkdir(parents=True)

            found = trial.resolve_source_repo(str(workspace), {}, installed)

            self.assertEqual(found["root"], workspace)
            self.assertEqual(found["origin"], "robot_ws")
            identity = trial.git_source_identity(found["root"])
            self.assertRegex(identity["commit"], r"^[0-9a-f]{40}$")
            self.assertTrue(trial.has_exact_commit(identity))
            self.assertEqual(identity["dirty"], "clean")

    def test_explicit_path_wins_over_the_workspace_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = make_repo(Path(tmp) / "robot_ws")
            pinned = make_repo(Path(tmp) / "pinned")

            found = trial.resolve_source_repo(
                str(workspace), {trial.SOURCE_DIR_ENV_KEY: str(pinned)}, Path(tmp)
            )

        self.assertEqual(found["root"], pinned)
        self.assertEqual(found["origin"], f"launch.env:{trial.SOURCE_DIR_ENV_KEY}")

    def test_non_questix_workspace_root_falls_back_to_src(self):
        with tempfile.TemporaryDirectory() as tmp:
            # ROBOT_WS is a git checkout, but of something else.
            workspace = make_repo(Path(tmp) / "robot_ws", questix=False)
            repo = make_repo(workspace / "src" / "questix")
            installed = Path(tmp) / "installed"
            installed.mkdir()

            found = trial.resolve_source_repo(str(workspace), {}, installed)

        self.assertEqual(found["root"], repo)
        self.assertEqual(found["origin"], "robot_ws/src")

    def test_duplicate_candidates_are_searched_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "robot_ws"
            (workspace / "src").mkdir(parents=True)
            installed = Path(tmp) / "installed"
            installed.mkdir()

            found = trial.resolve_source_repo(
                str(workspace), {trial.SOURCE_DIR_ENV_KEY: str(workspace)}, installed
            )

        self.assertIsNone(found["root"])
        self.assertEqual(len(found["searched"]), len(set(found["searched"])))

    def test_installed_manager_path_falls_back_to_the_workspace_checkout(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "robot_ws"
            repo = make_repo(workspace / "src" / "questix")
            # Mimics /opt/questix_robot/robot_manager: a copy, not a checkout.
            installed = Path(tmp) / "opt" / "questix_robot" / "robot_manager"
            installed.mkdir(parents=True)

            found = trial.resolve_source_repo(str(workspace), {}, installed)

            self.assertEqual(found["root"], repo)
            self.assertEqual(found["origin"], "robot_ws/src")
            identity = trial.git_source_identity(found["root"])
            self.assertTrue(trial.has_exact_commit(identity))

    def test_non_questix_workspace_entries_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "robot_ws"
            make_repo(workspace / "src" / "aaa_other", questix=False)
            repo = make_repo(workspace / "src" / "questix")
            installed = Path(tmp) / "installed"
            installed.mkdir()

            found = trial.resolve_source_repo(str(workspace), {}, installed)

        self.assertEqual(found["root"], repo)

    def test_explicit_launch_env_path_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "robot_ws"
            make_repo(workspace / "src" / "questix")
            pinned = make_repo(Path(tmp) / "pinned")

            found = trial.resolve_source_repo(
                str(workspace), {trial.SOURCE_DIR_ENV_KEY: str(pinned)}, Path(tmp)
            )

        self.assertEqual(found["root"], pinned)
        self.assertEqual(found["origin"], f"launch.env:{trial.SOURCE_DIR_ENV_KEY}")

    def test_invalid_explicit_path_is_rejected(self):
        with self.assertRaises(ValueError):
            trial.resolve_source_repo("/ws", {trial.SOURCE_DIR_ENV_KEY: "relative"}, Path("/tmp"))

    def test_unresolvable_source_is_reported_not_guessed(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Neither the workspace root nor anything under src/ is a checkout.
            workspace = Path(tmp) / "robot_ws"
            (workspace / "src" / "not_a_repo").mkdir(parents=True)
            installed = Path(tmp) / "installed"
            installed.mkdir()

            found = trial.resolve_source_repo(str(workspace), {}, installed)

        self.assertIsNone(found["root"])
        self.assertEqual(found["origin"], "unresolved")
        self.assertTrue(found["searched"])

    def test_a_subdirectory_of_the_checkout_resolves_to_its_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(Path(tmp) / "questix")
            inner = repo / "scripts" / "robot_manager"
            inner.mkdir(parents=True)

            found = trial.resolve_source_repo("/nonexistent_ws", {}, inner)

        self.assertEqual(found["root"], repo)
        self.assertEqual(found["origin"], "robot_manager_tree")


# ---------------------------------------------------------------------------
# Preflight / integrity / evidence helpers
# ---------------------------------------------------------------------------

class PreflightTests(unittest.TestCase):
    """Required drive path must exist; optional topics never block a trial."""

    def test_missing_required_is_detected(self):
        pre = trial.classify_preflight(["/joy_controller"], ["/drive_status"])
        self.assertEqual(sorted(pre["missing_required"]),
                         ["/drive_component", "/target_twist"])

    def test_optional_absence_is_recorded_not_fatal(self):
        pre = trial.classify_preflight(["/drive_component"], ["/target_twist", "/drive_status"])
        self.assertEqual(pre["missing_required"], [])
        self.assertIn("/joy", pre["optional_missing"])
        self.assertFalse(pre["joy_node_present"])

    def test_parameter_events_is_optional(self):
        self.assertIn("/parameter_events", trial.OPTIONAL_TOPICS)
        self.assertNotIn("/parameter_events", trial.REQUIRED_TOPICS)


class IntegrityTests(unittest.TestCase):
    """Bag integrity is judged tolerantly but never silently."""

    def test_topic_counts_are_parsed(self):
        counts = trial.parse_bag_info_topics(BAG_INFO_OK)
        self.assertEqual(counts["/target_twist"], 300)
        self.assertEqual(counts["/drive_status"], 30)

    def test_ok_requires_messages_on_required_topics(self):
        result = trial.evaluate_integrity(True, {"/target_twist": 1, "/drive_status": 1}, True)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["warnings"], [])

    def test_empty_required_topic_is_a_warning(self):
        result = trial.evaluate_integrity(True, {"/target_twist": 0, "/drive_status": 5}, True)
        self.assertEqual(result["status"], "warning")

    def test_unclean_finalize_is_never_ok(self):
        result = trial.evaluate_integrity(True, {"/target_twist": 3, "/drive_status": 5}, False)
        self.assertEqual(result["status"], "warning")

    def test_unreadable_bag_is_failed(self):
        self.assertEqual(trial.evaluate_integrity(False, {}, True)["status"], "failed")

    def test_unparsable_output_degrades_to_warning(self):
        result = trial.evaluate_integrity(True, trial.parse_bag_info_topics("unexpected"), True)
        self.assertEqual(result["status"], "warning")


class EvidenceFileTests(unittest.TestCase):
    """Sidecar writing, naming and staging semantics."""

    def test_yaml_quotes_and_escapes(self):
        text = trial.to_yaml({"memo": 'a"b\nc', "n": 3, "ok": True, "none": None})
        self.assertIn('memo: "a\\"b\\nc"', text)
        self.assertIn("n: 3", text)
        self.assertIn("ok: true", text)
        self.assertIn("none: null", text)

    def test_atomic_write_leaves_no_partial_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "questix_trial.yaml"
            trial.atomic_write_text(target, "a: 1\n")
            self.assertEqual(target.read_text(), "a: 1\n")
            self.assertEqual([p.name for p in Path(tmp).iterdir()], ["questix_trial.yaml"])

    def test_bag_name_collision_falls_back_to_trial_id_then_counter(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            self.assertEqual(trial.unique_bag_name(out, "robot_1", "t1"), "robot_1")
            (out / "robot_1").mkdir()
            self.assertEqual(trial.unique_bag_name(out, "robot_1", "t1"), "robot_1_t1")
            (out / "robot_1_t1").mkdir()
            self.assertEqual(trial.unique_bag_name(out, "robot_1", "t1"), "robot_1_t1_2")

    def test_generic_collision_uses_counter(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / "robot_1").mkdir()
            self.assertEqual(trial.unique_bag_name(out, "robot_1"), "robot_1_2")

    def test_staging_is_created_exclusively(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            first = trial.create_staging_dir(out, "robot_1")
            second = trial.create_staging_dir(out, "robot_1")
            self.assertNotEqual(first, second)
            self.assertTrue(first.is_dir() and second.is_dir())
            self.assertTrue(first.name.startswith(trial.STAGING_PREFIX))
            self.assertTrue(first.name.endswith(trial.STAGING_SUFFIX))

    def test_stale_staging_is_never_reused(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            stale = out / trial.staging_name("robot_1")
            stale.mkdir()
            (stale / "questix_trial.yaml").write_text("old: true\n")

            fresh = trial.create_staging_dir(out, "robot_1")

            self.assertNotEqual(fresh, stale)
            self.assertEqual(list(fresh.iterdir()), [])
            self.assertTrue((stale / "questix_trial.yaml").exists())

    def test_sidecars_move_into_bag_and_never_replace_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            staging = Path(tmp) / trial.staging_name("robot_1")
            bag = Path(tmp) / "robot_1"
            staging.mkdir()
            bag.mkdir()
            (staging / trial.TRIAL_FILE).write_text("schema_version: 1\n")
            (staging / "metadata.yaml").write_text("forged\n")
            (bag / "metadata.yaml").write_text("rosbag2 owned\n")

            result = trial.move_sidecars(staging, bag)

            self.assertIn(trial.TRIAL_FILE, result["moved"])
            self.assertEqual((bag / "metadata.yaml").read_text(), "rosbag2 owned\n")
            self.assertIn("metadata.yaml", result["skipped"])
            self.assertTrue(result["staging_kept"])

    def test_staging_is_kept_when_bag_directory_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            staging = Path(tmp) / trial.staging_name("robot_1")
            staging.mkdir()
            (staging / trial.TRIAL_FILE).write_text("schema_version: 1\n")

            result = trial.move_sidecars(staging, Path(tmp) / "absent_bag")

            self.assertTrue(result["staging_kept"])
            self.assertTrue((staging / trial.TRIAL_FILE).exists())

    def test_parameter_diff_is_empty_when_unchanged(self):
        self.assertEqual(trial.unified_diff_text("a\n", "a\n", "b", "a"), "")
        self.assertIn("-max_speed", trial.unified_diff_text(
            "max_speed: 1.0\n", "max_speed: 1.5\n", "before", "after"))

    def test_exit_reason_classification(self):
        self.assertEqual(trial.classify_exit_reason(0, 60, 60.0), "max_duration")
        self.assertEqual(trial.classify_exit_reason(0, 0, 60.0), "process_exited")
        self.assertEqual(trial.classify_exit_reason(1, 60, 5.0), "process_exited")


# ---------------------------------------------------------------------------
# Classroom trial start
# ---------------------------------------------------------------------------

class TrialStartTests(TrialFixture):
    """The recorder process is only started once the trial can be evidenced."""

    def test_missing_required_topic_does_not_start_a_process(self):
        run_ros = fake_run_ros(topics=["/drive_status"])
        with self.wired(run_ros=run_ros) as w:
            with self.assertRaises(HTTPException) as raised:
                recorder._start_trial({"trial_id": "t001"})

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("/target_twist", raised.exception.detail)
        self.assertEqual(w["popen"], [])
        self.assertIsNone(recorder._proc)
        self.assertFalse(recorder._starting)
        self.assertEqual(self.stagings(), [])

    def test_unusable_ros_environment_does_not_start_a_process(self):
        with self.wired(run_ros=fake_run_ros(topic_list_code=91)) as w:
            with self.assertRaises(HTTPException) as raised:
                recorder._start_trial({"trial_id": "t002"})

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(w["popen"], [])
        self.assertEqual(self.stagings(), [])

    def test_missing_workspace_overlay_does_not_start_a_process(self):
        with self.wired(run_ros=fake_run_ros(topic_list_code=92)) as w:
            with self.assertRaises(HTTPException) as raised:
                recorder._start_trial({"trial_id": "t002b"})

        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("install/setup.bash", raised.exception.detail)
        self.assertEqual(w["popen"], [])
        self.assertEqual(self.stagings(), [])

    def test_unresolved_source_repository_does_not_start_a_process(self):
        unresolved = {"root": None, "origin": "unresolved", "searched": ["/ws/src"]}
        with self.wired(source_repo=unresolved) as w:
            with self.assertRaises(HTTPException) as raised:
                recorder._start_trial({"trial_id": "t003a"})

        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn(trial.SOURCE_DIR_ENV_KEY, raised.exception.detail)
        self.assertEqual(w["popen"], [])
        self.assertEqual(self.stagings(), [])

    def test_source_without_exact_sha_does_not_start_a_process(self):
        with self.wired() as w:
            with patch.object(trial, "git_source_identity", return_value={
                "repo_root": "/repo", "commit": "unknown", "branch": "unknown",
                "dirty": "unknown", "describe": "unknown",
            }):
                with self.assertRaises(HTTPException) as raised:
                    recorder._start_trial({"trial_id": "t003b"})

        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("commit SHA", raised.exception.detail)
        self.assertEqual(w["popen"], [])

    def test_pii_field_is_refused_before_any_work(self):
        with self.wired() as w:
            with self.assertRaises(HTTPException) as raised:
                recorder._start_trial({"trial_id": "t003", "student_name": "山田"})

        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(w["popen"], [])

    def test_concurrent_start_is_rejected(self):
        with self.wired():
            recorder._start_trial({"trial_id": "t004"})
            with self.assertRaises(HTTPException) as raised:
                recorder._start_trial({"trial_id": "t005"})
        self.assertEqual(raised.exception.status_code, 409)

    def test_low_disk_refuses_the_trial(self):
        with self.wired(config=self.config(MIN_FREE_GB="999999")) as w:
            with self.assertRaises(HTTPException) as raised:
                recorder._start_trial({"trial_id": "t006"})
        self.assertEqual(raised.exception.status_code, 507)
        self.assertEqual(w["popen"], [])

    def test_start_writes_evidence_and_uses_resolved_environment(self):
        with self.wired() as w:
            result = recorder._start_trial({
                "trial_id": "t010", "team_id": "teamA", "condition_label": "baseline",
                "payload_kg": "1.5",
            })

        staging = self.staging_for(result["bag_name"])
        self.assertTrue(result["recording"])
        self.assertEqual(result["mode"], "classroom")
        self.assertEqual(recorder._mode, "classroom")
        for name in (trial.TOPIC_LIST_FILE, trial.SOURCE_FILE, trial.DRIVE_PARAMS_BEFORE,
                     trial.JOY_PARAMS_BEFORE, trial.RECORDER_LOG_FILE, trial.TRIAL_FILE):
            self.assertTrue((staging / name).exists(), name)

        document = (staging / trial.TRIAL_FILE).read_text(encoding="utf-8")
        self.assertIn('status: "recording"', document)
        self.assertIn(f"schema_version: {trial.SCHEMA_VERSION}", document)
        self.assertIn('ros_domain_id: "42"', document)
        self.assertIn(FAKE_SHA, document)
        self.assertIn('origin: "robot_ws/src"', document)
        self.assertIn('condition_label: "baseline"', document)
        self.assertNotIn("student", document)

        # P1: the environment recorded is the post-source one.
        self.assertIn("effective_env", document)
        self.assertIn('ROS_DISTRO: "jazzy"', document)
        self.assertIn("effective_ROS_DISTRO: jazzy",
                      (staging / trial.SOURCE_FILE).read_text(encoding="utf-8"))

        kwargs = w["popen"][0]["kwargs"]
        self.assertEqual(kwargs["env"]["ROS_DOMAIN_ID"], "42")
        self.assertIs(kwargs["stderr"], subprocess.STDOUT)
        self.assertNotEqual(kwargs["stdout"], subprocess.DEVNULL)
        script = w["popen"][0]["argv"][2]
        self.assertIn("ros2 bag record -a -s mcap", script)
        self.assertIn("exit 92", script)

    def test_absent_joy_node_skips_joy_snapshot(self):
        run_ros = fake_run_ros(nodes=["/drive_component"], topics=["/target_twist",
                                                                   "/drive_status"])
        with self.wired(run_ros=run_ros):
            result = recorder._start_trial({"trial_id": "t011"})

        staging = self.staging_for(result["bag_name"])
        self.assertFalse((staging / trial.JOY_PARAMS_BEFORE).exists())
        self.assertEqual(result["warnings"], [])

    def test_parameter_dump_failure_is_a_warning_not_a_failure(self):
        run_ros = fake_run_ros(drive_dumps=[])
        with self.wired(run_ros=run_ros):
            result = recorder._start_trial({"trial_id": "t012"})

        self.assertTrue(result["recording"])
        self.assertTrue(any("parameter取得に失敗" in w for w in result["warnings"]))

    def test_repeated_trial_id_gets_its_own_staging(self):
        with self.wired():
            first = recorder._start_trial({"trial_id": "t013"})
            (self.output_dir / first["bag_name"]).mkdir(exist_ok=True)
            recorder._proc = None
            recorder._trial["log"].close()
            recorder._trial = None
            second = recorder._start_trial({"trial_id": "t013"})

        self.assertNotEqual(first["bag_name"], second["bag_name"])
        self.assertNotEqual(first["evidence_dir"], second["evidence_dir"])
        self.assertEqual(len(self.stagings()), 2)

    def test_retry_after_a_failed_start_does_not_reuse_its_staging(self):
        with self.wired(proc=FakeProc(exits_immediately=True, returncode=127)):
            with self.assertRaises(HTTPException):
                recorder._start_trial({"trial_id": "t014"})
        failed = self.stagings()
        self.assertEqual(len(failed), 1)

        with self.wired():
            result = recorder._start_trial({"trial_id": "t014"})

        self.assertEqual(len(self.stagings()), 2)
        self.assertNotIn(Path(result["evidence_dir"]).name, failed)
        self.assertEqual(list(Path(result["evidence_dir"]).glob(trial.DRIVE_PARAMS_AFTER)), [])
        document = (self.output_dir / failed[0] / trial.TRIAL_FILE).read_text(encoding="utf-8")
        self.assertIn('status: "start_failed"', document)

    def test_immediate_exit_keeps_partial_evidence(self):
        with self.wired(proc=FakeProc(exits_immediately=True, returncode=127)):
            with self.assertRaises(HTTPException) as raised:
                recorder._start_trial({"trial_id": "t015"})

        staging = self.output_dir / self.stagings()[0]
        self.assertEqual(raised.exception.status_code, 500)
        self.assertTrue(staging.is_dir())
        document = (staging / trial.TRIAL_FILE).read_text(encoding="utf-8")
        self.assertIn('status: "start_failed"', document)
        self.assertEqual(recorder._last_stop_reason, "start_failed")
        self.assertIsNone(recorder._proc)


# ---------------------------------------------------------------------------
# Stop / finalize ordering (evidence attribution)
# ---------------------------------------------------------------------------

class TrialStopOrderingTests(TrialFixture):
    """The after-run snapshot belongs to the trial that just ended."""

    def _start(self, run_ros=None, stack=None):
        started = recorder._start_trial({"trial_id": "t100", "condition_label": "baseline"})
        bag_dir = self.output_dir / started["bag_name"]
        bag_dir.mkdir(exist_ok=True)
        (bag_dir / "metadata.yaml").write_text("rosbag2: owned\n")
        (bag_dir / "robot1_0.mcap").write_bytes(b"\x89MCAP")
        return started, bag_dir, self.staging_for(started["bag_name"])

    def test_after_snapshot_is_complete_when_stop_returns(self):
        with self.wired():
            _started, bag_dir, staging = self._start()
            recorder.stop_recording()

            # Synchronous part: the parameters of the trial that just ended.
            self.assertTrue((staging / trial.DRIVE_PARAMS_AFTER).exists())
            self.assertTrue((staging / trial.PARAM_DIFF_FILE).exists())
            self.assertEqual((staging / trial.DRIVE_PARAMS_AFTER).read_text(), DRIVE_DUMP_AFTER)
            # Asynchronous part: not started yet.
            self.assertFalse((staging / trial.BAG_INFO_FILE).exists())
            self.assertTrue(CapturedThread.pending(recorder._finalize_trial))
            self.assertFalse(recorder._capturing)

            CapturedThread.run_pending(recorder._finalize_trial)

        self.assertTrue((bag_dir / trial.BAG_INFO_FILE).exists())
        self.assertTrue((bag_dir / trial.DRIVE_PARAMS_AFTER).exists())

    def test_a_new_trial_cannot_start_during_the_snapshot(self):
        seen = {}
        original = recorder._capture_after_evidence

        def capture_with_intruder(ctx):
            try:
                recorder._start_trial({"trial_id": "t_intruder"})
            except HTTPException as exc:
                seen["status"] = exc.status_code
                seen["detail"] = exc.detail
            return original(ctx)

        with self.wired():
            self._start()
            with patch.object(recorder, "_capture_after_evidence", capture_with_intruder):
                recorder.stop_recording()

        self.assertEqual(seen["status"], 409)
        self.assertIn("parameter記録中", seen["detail"])
        self.assertFalse(recorder._capturing)

    def test_snapshot_failure_still_stops_and_warns(self):
        run_ros = fake_run_ros(drive_dumps=[DRIVE_DUMP_BEFORE])  # no dump left for "after"
        with self.wired(run_ros=run_ros):
            _started, _bag_dir, staging = self._start()
            result = recorder.stop_recording()
            CapturedThread.run_pending(recorder._finalize_trial)

        self.assertFalse(result["recording"])
        self.assertFalse((staging / trial.DRIVE_PARAMS_AFTER).exists())
        self.assertTrue(any("parameter取得に失敗" in w for w in recorder._last_trial["warnings"]))

    def test_auto_stop_takes_the_snapshot_before_releasing_the_slot(self):
        with self.wired():
            self._start()
            with recorder._lock:
                pending = recorder._stop_locked("auto_stopped_low_disk")
            self.assertTrue(recorder._capturing)
            recorder._after_stop(pending)
            self.assertFalse(recorder._capturing)
            staging = self.staging_for(pending["ctx"]["bag_name"])
            self.assertTrue((staging / trial.DRIVE_PARAMS_AFTER).exists())
            CapturedThread.run_pending(recorder._finalize_trial)

        self.assertEqual(recorder._last_stop_reason, "auto_stopped_low_disk")
        self.assertEqual(recorder._last_trial["stop_reason"], "auto_stopped_low_disk")

    def test_process_exit_reaped_by_status_snapshots_before_returning(self):
        proc = FakeProc()
        with self.wired(proc=proc):
            _started, bag_dir, staging = self._start()
            proc._alive = False  # the recorder exited on its own

            with patch.object(recorder, "_read_config", return_value=self.config()):
                status = recorder.get_status()

            self.assertFalse(status["recording"])
            self.assertTrue((staging / trial.DRIVE_PARAMS_AFTER).exists())
            CapturedThread.run_pending(recorder._finalize_trial)

        self.assertEqual(recorder._last_stop_reason, "process_exited")
        self.assertTrue((bag_dir / trial.DRIVE_PARAMS_AFTER).exists())

    def test_max_duration_exit_is_classified_for_a_trial(self):
        proc = FakeProc()
        config = self.config(MAX_DURATION_SEC="1")
        with self.wired(proc=proc, config=config):
            self._start()
            proc._alive = False
            recorder._started_at -= 5
            with patch.object(recorder, "_read_config", return_value=config):
                recorder.get_status()
            CapturedThread.run_pending(recorder._finalize_trial)

        self.assertEqual(recorder._last_stop_reason, "max_duration")

    def test_shutdown_stops_and_finalizes(self):
        with self.wired():
            _started, bag_dir, _staging = self._start()
            recorder.shutdown_recording()
            CapturedThread.run_pending(recorder._finalize_trial)

        self.assertEqual(recorder._last_stop_reason, "shutdown")
        self.assertTrue((bag_dir / trial.TRIAL_FILE).exists())


class TrialFinalizeTests(TrialFixture):
    """Stopping a trial produces the after-run evidence next to the bag."""

    def _run_trial(self, run_ros=None, create_bag=True):
        with self.wired(run_ros=run_ros) as w:
            started = recorder._start_trial({"trial_id": "t100", "condition_label": "baseline"})
            bag_dir = self.output_dir / started["bag_name"]
            if create_bag:
                bag_dir.mkdir(exist_ok=True)
                (bag_dir / "metadata.yaml").write_text("rosbag2: owned\n")
                (bag_dir / "robot1_0.mcap").write_bytes(b"\x89MCAP")
            recorder.stop_recording()
            CapturedThread.run_pending(recorder._finalize_trial)
        return started, bag_dir, w

    def test_sidecars_land_in_the_bag_with_ok_integrity(self):
        started, bag_dir, _w = self._run_trial()

        for name in (trial.TRIAL_FILE, trial.SOURCE_FILE, trial.TOPIC_LIST_FILE,
                     trial.DRIVE_PARAMS_BEFORE, trial.DRIVE_PARAMS_AFTER,
                     trial.JOY_PARAMS_BEFORE, trial.JOY_PARAMS_AFTER,
                     trial.PARAM_DIFF_FILE, trial.BAG_INFO_FILE, trial.RECORDER_LOG_FILE):
            self.assertTrue((bag_dir / name).exists(), name)

        self.assertEqual((bag_dir / "metadata.yaml").read_text(), "rosbag2: owned\n")
        self.assertEqual(self.stagings(), [])
        self.assertIn("max_speed", (bag_dir / trial.PARAM_DIFF_FILE).read_text())

        document = (bag_dir / trial.TRIAL_FILE).read_text(encoding="utf-8")
        self.assertIn('status: "finalized"', document)
        self.assertIn('stop_reason: "user_stopped"', document)
        self.assertIn('finalize: "clean"', document)
        self.assertIn('status: "ok"', document)

        summary = recorder._last_trial
        self.assertEqual(summary["integrity_status"], "ok")
        self.assertEqual(summary["bag_name"], started["bag_name"])
        self.assertFalse(summary["finalizing"])
        self.assertEqual(recorder._last_stop_reason, "user_stopped")
        self.assertEqual(recorder._last_finalize_reason, "clean")

    def test_unreadable_bag_is_reported_as_failed(self):
        _started, bag_dir, _w = self._run_trial(
            run_ros=fake_run_ros(bag_info_code=1, bag_info="")
        )
        self.assertEqual(recorder._last_trial["integrity_status"], "failed")
        self.assertTrue((bag_dir / trial.BAG_INFO_FILE).exists())

    def test_missing_required_topic_in_bag_is_a_warning(self):
        info = "Topic information: Topic: /drive_status | Type: x | Count: 5 |\n"
        self._run_trial(run_ros=fake_run_ros(bag_info=info))
        summary = recorder._last_trial
        self.assertEqual(summary["integrity_status"], "warning")
        self.assertTrue(any("/target_twist" in w for w in summary["warnings"]))

    def test_missing_bag_directory_keeps_evidence_in_staging(self):
        _started, _bag_dir, _w = self._run_trial(create_bag=False)
        staging = self.output_dir / self.stagings()[0]
        self.assertTrue((staging / trial.TRIAL_FILE).exists())
        self.assertTrue((staging / trial.DRIVE_PARAMS_AFTER).exists())
        self.assertEqual(recorder._last_trial["integrity_status"], "failed")

    def test_status_reports_the_active_trial(self):
        with self.wired():
            recorder._start_trial({"trial_id": "t101", "condition_label": "payload+1kg"})
            with patch.object(recorder, "_read_config", return_value=self.config()):
                status = recorder._status_payload()

        self.assertEqual(status["mode"], "classroom")
        self.assertEqual(status["trial"]["trial_id"], "t101")
        self.assertEqual(status["trial"]["condition_label"], "payload+1kg")


# ---------------------------------------------------------------------------
# Generic recorder regression
# ---------------------------------------------------------------------------

class GenericRecorderRegressionTests(TrialFixture):
    """The generic recording path keeps its previous behaviour."""

    def test_generic_start_has_no_metadata_and_discards_output(self):
        with self.wired() as w:
            result = recorder.start_recording()

        self.assertEqual(result["mode"], "generic")
        self.assertTrue(result["bag_name"].startswith("robot1_"))
        self.assertIsNone(recorder._trial)
        kwargs = w["popen"][0]["kwargs"]
        self.assertIs(kwargs["stdout"], subprocess.DEVNULL)
        self.assertIs(kwargs["stderr"], subprocess.DEVNULL)
        self.assertNotIn("env", kwargs)
        script = w["popen"][0]["argv"][2]
        self.assertIn("source /opt/ros/jazzy/setup.bash", script)
        self.assertNotIn("exit 92", script)
        self.assertIn('-x "(/camera/image_raw)"', script)
        self.assertEqual(self.stagings(), [])

    def test_generic_recording_never_dumps_parameters(self):
        with self.wired() as w:
            recorder.start_recording()
            recorder.stop_recording()

        self.assertFalse(CapturedThread.pending(recorder._finalize_trial))
        self.assertEqual([c for c in w["run_ros"].calls if c[:3] == ["ros2", "param", "dump"]], [])

    def test_generic_stop_reason_is_unchanged(self):
        with self.wired():
            recorder.start_recording()
            recorder.stop_recording()
        self.assertFalse(CapturedThread.pending(recorder._finalize_trial))
        self.assertEqual(recorder._last_stop_reason, "stopped")

    def test_generic_self_exit_reason_is_unchanged(self):
        proc = FakeProc()
        config = self.config(MAX_DURATION_SEC="1")
        with self.wired(proc=proc, config=config):
            recorder.start_recording()
            proc._alive = False
            recorder._started_at -= 5
            with patch.object(recorder, "_read_config", return_value=config):
                recorder.get_status()
        self.assertEqual(recorder._last_stop_reason, "process_exited")

    def test_bag_list_and_delete_work_with_sidecars(self):
        bag = self.output_dir / "robot1_20260921_100000"
        bag.mkdir()
        (bag / "metadata.yaml").write_text("rosbag2\n")
        (bag / "robot1_0.mcap").write_bytes(b"\x89MCAP")
        for name in (trial.TRIAL_FILE, trial.SOURCE_FILE, trial.BAG_INFO_FILE):
            (bag / name).write_text("evidence\n")
        trial.create_staging_dir(self.output_dir, "robot1_20260921_110000")

        with patch.object(recorder, "_read_config", return_value=self.config()):
            listing = recorder.list_bags()
            names = [b["name"] for b in listing["bags"]]
            self.assertEqual(names, [bag.name])
            self.assertTrue(listing["bags"][0]["has_mcap"])
            self.assertGreater(listing["bags"][0]["size_bytes"], 0)

    def test_staging_directory_cannot_be_deleted_through_the_api(self):
        staging = trial.create_staging_dir(self.output_dir, "robot1_20260921_120000")
        with patch.object(recorder, "_read_config", return_value=self.config()):
            with self.assertRaises(HTTPException) as raised:
                recorder.delete_bag(_Ref(staging.name))
        self.assertEqual(raised.exception.status_code, 400)
        self.assertTrue(staging.is_dir())

    def test_delete_removes_a_bag_with_sidecars(self):
        bag = self.output_dir / "robot1_20260921_110000"
        bag.mkdir()
        (bag / "robot1_0.mcap").write_bytes(b"\x89MCAP")
        (bag / trial.TRIAL_FILE).write_text("schema_version: 1\n")
        with patch.object(recorder, "_read_config", return_value=self.config()):
            self.assertEqual(recorder.delete_bag(_Ref(bag.name)), {"deleted": bag.name})
        self.assertFalse(bag.exists())


class _Ref:
    """Minimal BagRef substitute (the API model needs no behaviour here)."""

    def __init__(self, bag_name):
        self.bag_name = bag_name


# ---------------------------------------------------------------------------
# Passive contract
# ---------------------------------------------------------------------------

class PassiveContractTests(unittest.TestCase):
    """The classroom logger must never gain control authority."""

    READ_ONLY_COMMANDS = {
        ("ros2", "topic", "list"),
        ("ros2", "node", "list"),
        ("ros2", "param", "dump"),
        ("ros2", "bag", "info"),
        ("ros2", "bag", "record"),
    }

    FORBIDDEN = (
        "topic pub", "param set", "param load", "service call", "lifecycle set",
        "action send_goal", "bag play",
    )

    def _sources(self):
        base = Path(__file__).resolve().parent
        for name in ("recorder.py", "trial.py"):
            yield name, (base / name).read_text(encoding="utf-8")

    def test_no_command_publishing_code_exists(self):
        for name, text in self._sources():
            lowered = text.lower()
            for token in self.FORBIDDEN:
                self.assertNotIn(token, lowered, f"{name} must stay passive ({token})")

    def test_every_ros_invocation_is_read_only(self):
        for name, text in self._sources():
            tree = ast.parse(text)
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                called = getattr(node.func, "attr", getattr(node.func, "id", ""))
                if called not in ("run_ros", "_build_record_command"):
                    continue
                for arg in node.args:
                    if not isinstance(arg, ast.List):
                        continue
                    literals = [e.value for e in arg.elts if isinstance(e, ast.Constant)]
                    if literals and literals[0] == "ros2":
                        self.assertIn(tuple(literals[:3]), self.READ_ONLY_COMMANDS,
                                      f"{name}: {literals}")

    def test_raw_shell_is_only_used_for_the_environment_probe(self):
        base = Path(__file__).resolve().parent
        self.assertNotIn("run_shell(", (base / "recorder.py").read_text(encoding="utf-8"))
        for token in ("printf", "printenv"):
            self.assertIn(token, trial._ENV_DUMP_SCRIPT)
        self.assertNotIn("ros2", trial._ENV_DUMP_SCRIPT)

    def test_recorder_command_is_record_only(self):
        text = (Path(__file__).resolve().parent / "recorder.py").read_text(encoding="utf-8")
        self.assertIn('args = ["ros2", "bag", "record", "-a", "-s", "mcap"', text)


if __name__ == "__main__":
    unittest.main()
