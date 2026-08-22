#!/usr/bin/env python3
# Unit tests for scripts/resolve_ros_domain_id.py.
#
# Run with: python3 -m unittest scripts.test_resolve_ros_domain_id -v
# (from the repository root), or: python3 scripts/test_resolve_ros_domain_id.py

import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import resolve_ros_domain_id as rdi  # noqa: E402


SCRIPT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "resolve_ros_domain_id.py")


def scripted_read_line(answers):
    """Return a read_line() callable that yields each answer once, then ''."""
    queue = list(answers)

    def read_line():
        if queue:
            return queue.pop(0) + "\n"
        return ""

    return read_line


class RangeValidationTests(unittest.TestCase):
    def test_boundary_and_gap_values(self):
        expectations = {
            "0": "valid",
            "11": "valid",
            "42": "valid",
            "101": "valid",
            "102": "invalid",
            "214": "invalid",
            "215": "valid",
            "232": "valid",
            "233": "invalid",
            "-1": "invalid",
            "abc": "invalid",
        }
        for raw, expected in expectations.items():
            with self.subTest(raw=raw):
                state, _ = rdi.classify_domain_id(raw)
                self.assertEqual(state, expected)

    def test_missing_is_distinct_from_invalid(self):
        state, value = rdi.classify_domain_id(None)
        self.assertEqual(state, "missing")
        self.assertIsNone(value)


class ParsingTests(unittest.TestCase):
    def _write(self, tmpdir, name, content):
        path = os.path.join(tmpdir, name)
        with open(path, "wb") as fh:
            fh.write(content.encode("utf-8"))
        return path

    def test_launch_env_basic(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(tmp, "launch.env", "ENABLE_LIDAR=false\nROS_DOMAIN_ID=11\n")
            warnings = []
            self.assertEqual(rdi.read_launch_env_domain_id(path, warnings.append), "11")
            self.assertEqual(warnings, [])

    def test_launch_env_missing_file(self):
        self.assertIsNone(rdi.read_launch_env_domain_id("/nonexistent/launch.env", lambda m: None))

    def test_launch_env_commented_out_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(tmp, "launch.env", "#ROS_DOMAIN_ID=99\n")
            self.assertIsNone(rdi.read_launch_env_domain_id(path, lambda m: None))

    def test_launch_env_whitespace_around_value_is_tolerated(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(tmp, "launch.env", "  ROS_DOMAIN_ID=11  \n")
            self.assertEqual(rdi.read_launch_env_domain_id(path, lambda m: None).strip(), "11")

    def test_launch_env_crlf(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(tmp, "launch.env", "ENABLE_LIDAR=false\r\nROS_DOMAIN_ID=11\r\n")
            self.assertEqual(rdi.read_launch_env_domain_id(path, lambda m: None), "11")

    def test_launch_env_duplicate_uses_last_and_warns(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(tmp, "launch.env", "ROS_DOMAIN_ID=11\nROS_DOMAIN_ID=12\n")
            warnings = []
            value = rdi.read_launch_env_domain_id(path, warnings.append)
            self.assertEqual(value, "12")
            self.assertTrue(any("2 ROS_DOMAIN_ID assignments" in w for w in warnings))

    def test_bashrc_reads_only_managed_block(self):
        with tempfile.TemporaryDirectory() as tmp:
            content = (
                "export ROS_DOMAIN_ID=999\n"  # unrelated user line outside the block
                f"{rdi.BASHRC_BEGIN_MARKER}\n"
                "export ROS_DOMAIN_ID=11\n"
                f"{rdi.BASHRC_END_MARKER}\n"
            )
            path = self._write(tmp, "bashrc", content)
            self.assertEqual(rdi.read_bashrc_domain_id(path, lambda m: None), "11")

    def test_bashrc_missing_block_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(tmp, "bashrc", "export ROS_DOMAIN_ID=11\nalias ll='ls -la'\n")
            self.assertIsNone(rdi.read_bashrc_domain_id(path, lambda m: None))

    def test_bashrc_duplicate_managed_block_uses_last_and_warns(self):
        with tempfile.TemporaryDirectory() as tmp:
            content = (
                f"{rdi.BASHRC_BEGIN_MARKER}\nexport ROS_DOMAIN_ID=11\n{rdi.BASHRC_END_MARKER}\n"
                f"{rdi.BASHRC_BEGIN_MARKER}\nexport ROS_DOMAIN_ID=12\n{rdi.BASHRC_END_MARKER}\n"
            )
            path = self._write(tmp, "bashrc", content)
            warnings = []
            value = rdi.read_bashrc_domain_id(path, warnings.append)
            self.assertEqual(value, "12")
            self.assertTrue(any("2 ANSIBLE MANAGED BLOCK" in w for w in warnings))


class EphemeralRangeTests(unittest.TestCase):
    def test_standard_range_no_warning(self):
        m = mock.mock_open(read_data="32768\t60999\n")
        warnings = []
        with mock.patch("builtins.open", m):
            rdi.check_ephemeral_range(warnings.append)
        self.assertEqual(warnings, [])

    def test_custom_range_warns(self):
        m = mock.mock_open(read_data="1024\t65000\n")
        warnings = []
        with mock.patch("builtins.open", m):
            rdi.check_ephemeral_range(warnings.append)
        self.assertEqual(len(warnings), 1)
        self.assertIn("standard Linux ephemeral port range", warnings[0])

    def test_unreadable_warns_but_does_not_raise(self):
        with mock.patch("builtins.open", side_effect=OSError("nope")):
            warnings = []
            rdi.check_ephemeral_range(warnings.append)
        self.assertEqual(len(warnings), 1)


class ResolveLogicTests(unittest.TestCase):
    def test_both_unset_interactive_prompts(self):
        warnings = []
        read_line = scripted_read_line(["11"])
        value = rdi.resolve(None, None, None, True, read_line, warnings.append)
        self.assertEqual(value, 11)

    def test_both_unset_non_interactive_fails(self):
        with self.assertRaises(rdi.ResolutionError):
            rdi.resolve(None, None, None, False, scripted_read_line([]), lambda m: None)

    def test_legacy_42_confirmation_path_keep(self):
        warnings = []
        read_line = scripted_read_line([""])  # blank -> keep 42
        value = rdi.resolve(None, "42", "42", True, read_line, warnings.append)
        self.assertEqual(value, 42)

    def test_legacy_42_confirmation_path_change(self):
        read_line = scripted_read_line(["11"])
        value = rdi.resolve(None, "42", "42", True, read_line, lambda m: None)
        self.assertEqual(value, 11)

    def test_legacy_42_non_interactive_fails(self):
        with self.assertRaises(rdi.ResolutionError):
            rdi.resolve(None, "42", "42", False, scripted_read_line([]), lambda m: None)

    def test_matching_non_legacy_preserved_without_prompt(self):
        def boom():
            raise AssertionError("must not prompt")

        value = rdi.resolve(None, "11", "11", True, boom, lambda m: None)
        self.assertEqual(value, 11)

    def test_launch_only_resolves_without_prompt(self):
        def boom():
            raise AssertionError("must not prompt")

        value = rdi.resolve(None, "11", None, True, boom, lambda m: None)
        self.assertEqual(value, 11)

    def test_bashrc_only_resolves_without_prompt(self):
        def boom():
            raise AssertionError("must not prompt")

        value = rdi.resolve(None, None, "11", True, boom, lambda m: None)
        self.assertEqual(value, 11)

    def test_conflict_11_vs_42_interactive(self):
        read_line = scripted_read_line(["11"])
        value = rdi.resolve(None, "11", "42", True, read_line, lambda m: None)
        self.assertEqual(value, 11)

    def test_conflict_11_vs_12_interactive(self):
        read_line = scripted_read_line(["12"])
        value = rdi.resolve(None, "11", "12", True, read_line, lambda m: None)
        self.assertEqual(value, 12)

    def test_conflict_non_interactive_fails(self):
        with self.assertRaises(rdi.ResolutionError):
            rdi.resolve(None, "11", "12", False, scripted_read_line([]), lambda m: None)

    def test_launch_invalid_bashrc_valid_no_silent_fallback(self):
        with self.assertRaises(rdi.ResolutionError):
            rdi.resolve(None, "abc", "11", False, scripted_read_line([]), lambda m: None)
        read_line = scripted_read_line(["11"])
        value = rdi.resolve(None, "abc", "11", True, read_line, lambda m: None)
        self.assertEqual(value, 11)

    def test_launch_valid_bashrc_invalid_no_silent_fallback(self):
        with self.assertRaises(rdi.ResolutionError):
            rdi.resolve(None, "11", "abc", False, scripted_read_line([]), lambda m: None)
        read_line = scripted_read_line(["11"])
        value = rdi.resolve(None, "11", "abc", True, read_line, lambda m: None)
        self.assertEqual(value, 11)

    def test_both_invalid_interactive_prompts_new_value(self):
        read_line = scripted_read_line(["11"])
        value = rdi.resolve(None, "abc", "-1", True, read_line, lambda m: None)
        self.assertEqual(value, 11)

    def test_both_invalid_non_interactive_fails(self):
        with self.assertRaises(rdi.ResolutionError):
            rdi.resolve(None, "abc", "-1", False, scripted_read_line([]), lambda m: None)

    def test_valid_override_accepted(self):
        def boom():
            raise AssertionError("must not prompt")

        value = rdi.resolve("12", "99999", "99999", False, boom, lambda m: None)
        self.assertEqual(value, 12)

    def test_override_42_accepted_without_confirmation(self):
        def boom():
            raise AssertionError("must not prompt")

        warnings = []
        value = rdi.resolve("42", None, None, False, boom, warnings.append)
        self.assertEqual(value, 42)
        self.assertTrue(any("without interactive confirmation" in w for w in warnings))

    def test_invalid_override_fails_immediately(self):
        def boom():
            raise AssertionError("must not prompt")

        with self.assertRaises(rdi.ResolutionError):
            rdi.resolve("999", "11", "11", True, boom, lambda m: None)

    def test_domain_zero_warns_but_accepts(self):
        warnings = []
        value = rdi.resolve("0", None, None, False, scripted_read_line([]), warnings.append)
        self.assertEqual(value, 0)
        self.assertTrue(any("overlaps the ROS 2 default domain" in w for w in warnings))

    def test_domain_zero_from_persisted_state_warns(self):
        warnings = []

        def boom():
            raise AssertionError("must not prompt")

        value = rdi.resolve(None, "0", "0", True, boom, warnings.append)
        self.assertEqual(value, 0)
        self.assertTrue(any("overlaps the ROS 2 default domain" in w for w in warnings))


class EofHandlingTests(unittest.TestCase):
    """B-01: EOF ("") must never be conflated with a blank Enter ("\\n")."""

    def test_1_persisted_42_interactive_eof_raises(self):
        with self.assertRaises(rdi.ResolutionError):
            rdi.resolve(None, "42", "42", True, scripted_read_line([]), lambda m: None)

    def test_2_conflict_interactive_eof_raises(self):
        with self.assertRaises(rdi.ResolutionError):
            rdi.resolve(None, "11", "12", True, scripted_read_line([]), lambda m: None)

    def test_3_both_missing_interactive_eof_raises(self):
        with self.assertRaises(rdi.ResolutionError):
            rdi.resolve(None, None, None, True, scripted_read_line([]), lambda m: None)

    def test_4_blank_enter_confirming_42_still_keeps_42(self):
        # scripted_read_line([""]) yields "\n" (Enter with no text), which is
        # distinct from scripted_read_line([]) yielding "" (EOF) above.
        value = rdi.resolve(None, "42", "42", True, scripted_read_line([""]), lambda m: None)
        self.assertEqual(value, 42)

    def test_eof_during_invalid_persisted_confirmation_raises(self):
        with self.assertRaises(rdi.ResolutionError):
            rdi.resolve(None, "abc", "11", True, scripted_read_line([]), lambda m: None)

    def test_eof_during_both_invalid_prompt_raises(self):
        with self.assertRaises(rdi.ResolutionError):
            rdi.resolve(None, "abc", "-1", True, scripted_read_line([]), lambda m: None)


class UnreadableFileTests(unittest.TestCase):
    """B-02: unreadable persisted files must fail closed, distinct from missing."""

    def test_5_unreadable_launch_env_without_override_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "launch.env")
            with open(path, "w") as fh:
                fh.write("ROS_DOMAIN_ID=11\n")
            os.chmod(path, 0o000)
            try:
                if os.access(path, os.R_OK):
                    self.skipTest("running as a user that bypasses file permissions (e.g. root)")
                with self.assertRaises(rdi.ResolutionError):
                    rdi.read_launch_env_domain_id(path, lambda m: None)
            finally:
                os.chmod(path, 0o644)

    def test_6_unreadable_bashrc_without_override_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bashrc")
            with open(path, "w") as fh:
                fh.write(f"{rdi.BASHRC_BEGIN_MARKER}\nexport ROS_DOMAIN_ID=11\n{rdi.BASHRC_END_MARKER}\n")
            os.chmod(path, 0o000)
            try:
                if os.access(path, os.R_OK):
                    self.skipTest("running as a user that bypasses file permissions (e.g. root)")
                with self.assertRaises(rdi.ResolutionError):
                    rdi.read_bashrc_domain_id(path, lambda m: None)
            finally:
                os.chmod(path, 0o644)

    def test_6b_undecodable_file_fails_without_traceback(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "launch.env")
            with open(path, "wb") as fh:
                fh.write(b"ROS_DOMAIN_ID=\xff\xfe11\n")
            with self.assertRaises(rdi.ResolutionError):
                rdi.read_launch_env_domain_id(path, lambda m: None)

    def test_7_nonexistent_files_are_still_treated_as_missing(self):
        self.assertIsNone(
            rdi.read_launch_env_domain_id("/nonexistent/launch.env", lambda m: None)
        )
        self.assertIsNone(
            rdi.read_bashrc_domain_id("/nonexistent/bashrc", lambda m: None)
        )

    def test_8_valid_override_usable_without_persisted_state(self):
        def boom():
            raise AssertionError("must not prompt")

        # override path in resolve() never inspects launch_raw/bashrc_raw.
        value = rdi.resolve("12", None, None, False, boom, lambda m: None)
        self.assertEqual(value, 12)

    def test_8b_valid_override_cli_ignores_unreadable_persisted_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            launch_env = os.path.join(tmp, "launch.env")
            bashrc = os.path.join(tmp, "bashrc")
            with open(launch_env, "w") as fh:
                fh.write("ROS_DOMAIN_ID=11\n")
            os.chmod(launch_env, 0o000)
            try:
                if os.access(launch_env, os.R_OK):
                    self.skipTest("running as a user that bypasses file permissions (e.g. root)")
                env = dict(os.environ)
                env["QUESTIX_ROS_DOMAIN_ID"] = "12"
                result = subprocess.run(
                    [
                        sys.executable, SCRIPT_PATH,
                        "--launch-env-path", launch_env,
                        "--bashrc-path", bashrc,
                        "--non-interactive",
                    ],
                    env=env,
                    input="",
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "12\n")
            finally:
                os.chmod(launch_env, 0o644)

    def test_9_invalid_override_fails_immediately(self):
        def boom():
            raise AssertionError("must not prompt")

        with self.assertRaises(rdi.ResolutionError):
            rdi.resolve("abc", None, None, False, boom, lambda m: None)


class CliContractTests(unittest.TestCase):
    def _run(self, env_overrides=None, extra_args=None, stdin_data=""):
        env = dict(os.environ)
        env.pop("QUESTIX_ROS_DOMAIN_ID", None)
        if env_overrides:
            env.update(env_overrides)
        args = [sys.executable, SCRIPT_PATH]
        if extra_args:
            args.extend(extra_args)
        return subprocess.run(
            args,
            env=env,
            input=stdin_data,
            capture_output=True,
            text=True,
            timeout=10,
        )

    def test_stdout_is_final_integer_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            launch_env = os.path.join(tmp, "launch.env")  # does not exist
            bashrc = os.path.join(tmp, "bashrc")  # does not exist
            result = self._run(
                env_overrides={"QUESTIX_ROS_DOMAIN_ID": "12"},
                extra_args=[
                    "--launch-env-path", launch_env,
                    "--bashrc-path", bashrc,
                    "--non-interactive",
                ],
            )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "12\n")

    def test_invalid_override_fails_with_empty_stdout(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self._run(
                env_overrides={"QUESTIX_ROS_DOMAIN_ID": "abc"},
                extra_args=[
                    "--launch-env-path", os.path.join(tmp, "launch.env"),
                    "--bashrc-path", os.path.join(tmp, "bashrc"),
                    "--non-interactive",
                ],
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("invalid", result.stderr)

    def test_non_interactive_unresolved_state_fails_instead_of_hanging(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self._run(
                extra_args=[
                    "--launch-env-path", os.path.join(tmp, "launch.env"),
                    "--bashrc-path", os.path.join(tmp, "bashrc"),
                    "--non-interactive",
                ],
                stdin_data="",
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
