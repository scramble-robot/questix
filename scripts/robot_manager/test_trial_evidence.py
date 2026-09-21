"""Tests for the classroom trial evidence path of the rosbag recorder.

Covers the parts that can be verified without a robot: metadata validation (and
the absence of any PII slot), runtime environment resolution, preflight refusal,
evidence staging, integrity judgement, collision-safe bag naming, the generic
recorder regression surface, and the passive-contract invariant.

Live recording, SIGINT finalize, low-disk auto-stop and MCAP readability remain
Raspberry Pi 5 validation items.
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
                return topic_list_code, "", "command not found: ros2"
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
    def wired(self, run_ros=None, proc=None, launch_env=None, config=None):
        """Patch config, launch.env, ROS queries, Popen, signals and threads."""
        proc = proc or FakeProc()
        run_ros = run_ros or fake_run_ros()
        launch_env = launch_env or {"ROBOT_WS": "/home/ubuntu/robot_ws", "ROS_DOMAIN_ID": "42"}
        popen_calls: list = []

        def popen(argv, **kwargs):
            popen_calls.append({"argv": argv, "kwargs": kwargs})
            return proc

        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(recorder, "_read_config",
                                             return_value=config or self.config()))
            stack.enter_context(patch.object(recorder, "_read_env_file",
                                             return_value=dict(launch_env)))
            stack.enter_context(patch.object(trial, "run_ros", run_ros))
            stack.enter_context(patch.object(trial, "git_source_identity", return_value={
                "repo_root": "/repo", "commit": "a" * 40, "branch": "main",
                "dirty": "clean", "describe": "v1.0.0",
            }))
            stack.enter_context(patch.object(recorder.subprocess, "Popen", popen))
            stack.enter_context(patch.object(recorder.time, "sleep", lambda *_: None))
            stack.enter_context(patch.object(recorder.os, "getpgid", lambda pid: pid))
            stack.enter_context(patch.object(recorder.os, "killpg", lambda pid, sig: None))
            stack.enter_context(patch.object(recorder.threading, "Thread", CapturedThread))
            yield {"proc": proc, "popen": popen_calls, "run_ros": run_ros}

    def staging_of(self, trial_id):
        return trial.staging_dir(self.output_dir, trial_id)


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

    def test_prelude_sources_ros_and_workspace(self):
        prelude = trial.build_prelude("/home/ubuntu/robot_ws")
        self.assertIn("/opt/ros/jazzy/setup.bash", prelude)
        self.assertIn("/home/ubuntu/robot_ws/install/setup.bash", prelude)
        self.assertIn("exit 90", prelude)

    def test_domain_id_reaches_the_child_process(self):
        rt = trial.resolve_runtime_env({"ROBOT_WS": "/ws", "ROS_DOMAIN_ID": "42"}, dict(os.environ))
        rt.prelude = ""  # skip sourcing: this asserts environment propagation only
        code, out, _err = trial.run_ros(rt, ["printenv", "ROS_DOMAIN_ID"])
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "42")

    def test_discovery_settings_are_reported(self):
        settings = trial.discovery_settings(
            {"ROS_DISTRO": "jazzy", "RMW_IMPLEMENTATION": "rmw_fastrtps_cpp", "PATH": "/bin"}
        )
        self.assertEqual(settings, {"ROS_DISTRO": "jazzy",
                                    "RMW_IMPLEMENTATION": "rmw_fastrtps_cpp"})


# ---------------------------------------------------------------------------
# Source provenance
# ---------------------------------------------------------------------------

class SourceIdentityTests(unittest.TestCase):
    """The exact commit is recorded; the diff body never is."""

    def _repo(self, tmp: Path) -> Path:
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@e",
                   GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@e")
        subprocess.run(["git", "init", "-q", "-b", "main", str(tmp)], check=True, env=env)
        (tmp / "f.txt").write_text("a\n")
        subprocess.run(["git", "-C", str(tmp), "add", "f.txt"], check=True, env=env)
        subprocess.run(["git", "-C", str(tmp), "commit", "-q", "-m", "init"], check=True, env=env)
        return tmp

    def test_clean_checkout_reports_exact_sha_and_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = self._repo(Path(tmp))
            identity = trial.git_source_identity(repo)
            self.assertRegex(identity["commit"], r"^[0-9a-f]{40}$")
            self.assertEqual(identity["branch"], "main")
            self.assertEqual(identity["dirty"], "clean")

    def test_dirty_checkout_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = self._repo(Path(tmp))
            (repo / "f.txt").write_text("changed\n")
            self.assertEqual(trial.git_source_identity(repo)["dirty"], "dirty")

    def test_detached_head_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = self._repo(Path(tmp))
            head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"],
                                  capture_output=True, text=True, check=True).stdout.strip()
            subprocess.run(["git", "-C", str(repo), "checkout", "-q", head], check=True)
            self.assertEqual(trial.git_source_identity(repo)["branch"], "detached")

    def test_non_repository_is_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            identity = trial.git_source_identity(Path(tmp) / "nope")
            self.assertEqual(identity["commit"], "unknown")
            self.assertEqual(identity["dirty"], "unknown")

    def test_rendered_text_has_no_diff_body(self):
        text = trial.source_identity_text(
            {"commit": "b" * 40, "branch": "main", "dirty": "dirty",
             "describe": "v1", "repo_root": "/repo"},
            {"hostname": "questix", "ros_domain_id": "42"},
        )
        self.assertIn("b" * 40, text)
        self.assertIn("ros_domain_id: 42", text)
        self.assertNotIn("diff --git", text)


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

    def test_sidecars_move_into_bag_and_never_replace_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            staging = Path(tmp) / ".trial_t1.tmp"
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
            staging = Path(tmp) / ".trial_t1.tmp"
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
# Classroom trial start / finalize through the recorder
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
        self.assertFalse(self.staging_of("t001").exists())

    def test_unresolvable_ros_environment_does_not_start_a_process(self):
        with self.wired(run_ros=fake_run_ros(topic_list_code=91)) as w:
            with self.assertRaises(HTTPException) as raised:
                recorder._start_trial({"trial_id": "t002"})

        self.assertEqual(raised.exception.status_code, 503)
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

        staging = self.staging_of("t010")
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
        self.assertIn("a" * 40, document)
        self.assertIn('condition_label: "baseline"', document)
        self.assertNotIn("student", document)

        kwargs = w["popen"][0]["kwargs"]
        self.assertEqual(kwargs["env"]["ROS_DOMAIN_ID"], "42")
        self.assertIs(kwargs["stderr"], subprocess.STDOUT)
        self.assertNotEqual(kwargs["stdout"], subprocess.DEVNULL)
        script = w["popen"][0]["argv"][2]
        self.assertIn("ros2 bag record -a -s mcap", script)
        self.assertIn("exit 91", script)

    def test_absent_joy_node_skips_joy_snapshot(self):
        run_ros = fake_run_ros(nodes=["/drive_component"], topics=["/target_twist",
                                                                   "/drive_status"])
        with self.wired(run_ros=run_ros):
            result = recorder._start_trial({"trial_id": "t011"})

        staging = self.staging_of("t011")
        self.assertFalse((staging / trial.JOY_PARAMS_BEFORE).exists())
        self.assertEqual(result["warnings"], [])

    def test_parameter_dump_failure_is_a_warning_not_a_failure(self):
        run_ros = fake_run_ros(drive_dumps=[])
        with self.wired(run_ros=run_ros):
            result = recorder._start_trial({"trial_id": "t012"})

        self.assertTrue(result["recording"])
        self.assertTrue(any("parameter取得に失敗" in w for w in result["warnings"]))

    def test_bag_name_avoids_an_existing_directory(self):
        with self.wired():
            first = recorder._start_trial({"trial_id": "t013"})
            (self.output_dir / first["bag_name"]).mkdir(exist_ok=True)
            recorder._proc = None
            recorder._trial["log"].close()
            recorder._trial = None
            second = recorder._start_trial({"trial_id": "t013b"})

        self.assertNotEqual(first["bag_name"], second["bag_name"])

    def test_immediate_exit_keeps_partial_evidence(self):
        with self.wired(proc=FakeProc(exits_immediately=True, returncode=127)):
            with self.assertRaises(HTTPException) as raised:
                recorder._start_trial({"trial_id": "t014"})

        staging = self.staging_of("t014")
        self.assertEqual(raised.exception.status_code, 500)
        self.assertTrue(staging.is_dir())
        document = (staging / trial.TRIAL_FILE).read_text(encoding="utf-8")
        self.assertIn('status: "start_failed"', document)
        self.assertEqual(recorder._last_stop_reason, "start_failed")
        self.assertIsNone(recorder._proc)


class TrialFinalizeTests(TrialFixture):
    """Stopping a trial produces the after-run evidence next to the bag."""

    def _run_trial(self, run_ros=None, create_bag=True, stop_reason="user_stopped"):
        with self.wired(run_ros=run_ros) as w:
            started = recorder._start_trial({"trial_id": "t100", "condition_label": "baseline"})
            bag_dir = self.output_dir / started["bag_name"]
            if create_bag:
                bag_dir.mkdir(exist_ok=True)
                (bag_dir / "metadata.yaml").write_text("rosbag2: owned\n")
                (bag_dir / "robot1_0.mcap").write_bytes(b"\x89MCAP")
            if stop_reason == "user_stopped":
                recorder.stop_recording()
            else:
                with recorder._lock:
                    recorder._stop_locked(stop_reason)
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
        self.assertFalse(self.staging_of("t100").exists())
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
        self._run_trial(create_bag=False)
        staging = self.staging_of("t100")
        self.assertTrue(staging.is_dir())
        self.assertTrue((staging / trial.TRIAL_FILE).exists())
        self.assertEqual(recorder._last_trial["integrity_status"], "failed")

    def test_low_disk_stop_reason_is_preserved(self):
        self._run_trial(stop_reason="auto_stopped_low_disk")
        self.assertEqual(recorder._last_stop_reason, "auto_stopped_low_disk")
        self.assertEqual(recorder._last_trial["stop_reason"], "auto_stopped_low_disk")

    def test_status_reports_the_active_trial(self):
        with self.wired():
            recorder._start_trial({"trial_id": "t101", "condition_label": "payload+1kg"})
            with patch.object(recorder, "_read_config", return_value=self.config()):
                status = recorder._status_payload()

        self.assertEqual(status["mode"], "classroom")
        self.assertEqual(status["trial"]["trial_id"], "t101")
        self.assertEqual(status["trial"]["condition_label"], "payload+1kg")


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
        self.assertIn('-x "(/camera/image_raw)"', script)
        self.assertFalse(any(p.name.startswith(trial.STAGING_PREFIX)
                             for p in self.output_dir.iterdir()))

    def test_generic_stop_does_not_schedule_a_finalize(self):
        with self.wired():
            recorder.start_recording()
            CapturedThread.started = []
            recorder.stop_recording()
        self.assertEqual(CapturedThread.started, [])
        self.assertEqual(recorder._last_stop_reason, "user_stopped")

    def test_bag_list_and_delete_work_with_sidecars(self):
        bag = self.output_dir / "robot1_20260921_100000"
        bag.mkdir()
        (bag / "metadata.yaml").write_text("rosbag2\n")
        (bag / "robot1_0.mcap").write_bytes(b"\x89MCAP")
        for name in (trial.TRIAL_FILE, trial.SOURCE_FILE, trial.BAG_INFO_FILE):
            (bag / name).write_text("evidence\n")
        trial.staging_dir(self.output_dir, "t200").mkdir()

        with patch.object(recorder, "_read_config", return_value=self.config()):
            listing = recorder.list_bags()
            names = [b["name"] for b in listing["bags"]]
            self.assertEqual(names, [bag.name])
            self.assertTrue(listing["bags"][0]["has_mcap"])
            self.assertGreater(listing["bags"][0]["size_bytes"], 0)

    def test_staging_directory_cannot_be_deleted_through_the_api(self):
        staging = trial.staging_dir(self.output_dir, "t201")
        staging.mkdir()
        ref = _ref(staging.name)
        with patch.object(recorder, "_read_config", return_value=self.config()):
            with self.assertRaises(HTTPException) as raised:
                recorder.delete_bag(ref)
        self.assertEqual(raised.exception.status_code, 400)
        self.assertTrue(staging.is_dir())

    def test_delete_removes_a_bag_with_sidecars(self):
        bag = self.output_dir / "robot1_20260921_110000"
        bag.mkdir()
        (bag / "robot1_0.mcap").write_bytes(b"\x89MCAP")
        (bag / trial.TRIAL_FILE).write_text("schema_version: 1\n")
        with patch.object(recorder, "_read_config", return_value=self.config()):
            self.assertEqual(recorder.delete_bag(_ref(bag.name)), {"deleted": bag.name})
        self.assertFalse(bag.exists())


class _Ref:
    """Minimal BagRef substitute (the API model needs no behaviour here)."""

    def __init__(self, bag_name):
        self.bag_name = bag_name


def _ref(name):
    return _Ref(name)


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
        "action send_goal", "bag play", "/target_twist\", \"pub",
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
                func = node.func
                called = getattr(func, "attr", getattr(func, "id", ""))
                if called not in ("run_ros", "_build_record_command"):
                    continue
                for arg in node.args:
                    if not isinstance(arg, ast.List):
                        continue
                    literals = [e.value for e in arg.elts if isinstance(e, ast.Constant)]
                    if literals and literals[0] == "ros2":
                        self.assertIn(tuple(literals[:3]), self.READ_ONLY_COMMANDS,
                                      f"{name}: {literals}")

    def test_recorder_command_is_record_only(self):
        text = (Path(__file__).resolve().parent / "recorder.py").read_text(encoding="utf-8")
        self.assertIn('args = ["ros2", "bag", "record", "-a", "-s", "mcap"', text)


if __name__ == "__main__":
    unittest.main()
