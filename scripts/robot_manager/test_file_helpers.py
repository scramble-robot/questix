"""Regression tests for Robot Manager file helpers."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# Runnable from any working directory: the package lives in scripts/, the shared
# test shims next to this file.
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from test_support import install_stubs  # noqa: E402

install_stubs()

from fastapi import HTTPException  # noqa: E402  (import after stub installation)
from robot_manager import logs, recorder  # noqa: E402


class ReadEnvFileTests(unittest.TestCase):
    """Cover missing, readable, and unreadable environment files."""

    def test_missing_file_returns_empty_dict(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(recorder._read_env_file(Path(tmp) / "missing.env"), {})

    def test_valid_file_is_parsed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "robot.env"
            path.write_text("# comment\nROBOT_WS=/home/robot/ws\nINVALID-LINE\nENABLED=true\n")

            self.assertEqual(
                recorder._read_env_file(path),
                {"ROBOT_WS": "/home/robot/ws", "ENABLED": "true"},
            )

    def test_utf8_comment_file_is_parsed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "robot.env"
            path.write_text(
                "# 録画設定\nROBOT_WS=/home/robot/ws\n",
                encoding="utf-8",
            )

            self.assertEqual(
                recorder._read_env_file(path),
                {"ROBOT_WS": "/home/robot/ws"},
            )

    def test_invalid_utf8_is_reported_as_decode_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "robot.env"
            path.write_bytes(b"ROBOT_WS=/home/robot/\xff\n")

            with self.assertRaises(OSError) as raised:
                recorder._read_env_file(path)

        self.assertIn("failed to decode environment file", str(raised.exception))
        self.assertIsInstance(raised.exception.__cause__, UnicodeError)

    def test_permission_error_is_not_silenced(self):
        path = Path("/private/robot.env")
        with patch.object(Path, "read_text", side_effect=PermissionError("denied")):
            with self.assertRaises(OSError) as raised:
                recorder._read_env_file(path)

        self.assertIn("failed to read environment file", str(raised.exception))
        self.assertIsInstance(raised.exception.__cause__, PermissionError)

    def test_api_error_does_not_expose_config_path(self):
        with patch.object(
            recorder,
            "_read_config",
            side_effect=OSError("failed to read /private/rosbag.env"),
        ):
            with self.assertRaises(HTTPException) as raised:
                recorder._read_config_for_api()

        self.assertEqual(raised.exception.status_code, 500)
        self.assertEqual(raised.exception.detail, "録画設定を読み込めません")
        self.assertNotIn("/private", raised.exception.detail)


class CopyTailTests(unittest.TestCase):
    """Cover full copies and bounded tail copies."""

    def test_small_file_is_copied_in_full(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "source.log"
            dest = Path(tmp) / "dest.log"
            src.write_bytes(b"small log\n")

            self.assertFalse(logs._copy_tail(src, dest, 100))
            self.assertEqual(dest.read_bytes(), b"small log\n")

    def test_large_file_keeps_marker_and_tail(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "source.log"
            dest = Path(tmp) / "dest.log"
            src.write_bytes(b"0123456789")

            self.assertTrue(logs._copy_tail(src, dest, 4))
            output = dest.read_bytes()
            self.assertIn(b"older entries omitted", output)
            self.assertTrue(output.endswith(b"6789"))

    def test_utf8_tail_starts_at_character_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "source.log"
            dest = Path(tmp) / "dest.log"
            src.write_text("甲乙丙丁", encoding="utf-8")

            self.assertTrue(logs._copy_tail(src, dest, 8))
            output = dest.read_bytes()
            decoded = output.decode("utf-8")
            marker, tail = output.split(b"\n", 1)

            self.assertIn(b"older entries omitted", marker)
            self.assertTrue(decoded.endswith("丙丁"))
            self.assertEqual(tail.decode("utf-8"), "丙丁")
            self.assertLessEqual(len(tail), 8)

    def test_zero_limit_writes_only_truncation_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "source.log"
            dest = Path(tmp) / "dest.log"
            src.write_bytes(b"content")

            self.assertTrue(logs._copy_tail(src, dest, 0))
            output = dest.read_bytes()
            self.assertIn(b"older entries omitted", output)
            self.assertNotIn(b"content", output)


if __name__ == "__main__":
    unittest.main()
