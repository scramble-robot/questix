#!/usr/bin/env python3
"""drive_mode_check.py の検算（ROS なし）: 集計・判定・フレームの組み立て。"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import drive_mode_check as dmc  # noqa: E402


def wheel(*samples, min_stamp_ns=0):
    summary = dmc.WheelSummary()
    for stamp, mode in samples:
        dmc.add_sample(summary, stamp, mode, 0, 0.0, 0, min_stamp_ns)
    return summary


def test_expected_mode_follows_drive_component():
    assert dmc.expected_mode("velocity") == 2
    assert dmc.expected_mode("current") == 1
    # drive_component は未知の値を velocity として扱う
    assert dmc.expected_mode("typo") == 2


def test_crc_matches_ddt_protocol():
    # ddt_protocol::packModeFrame と同じ CRC（drive_component が送る値）
    sent, spec = dmc.mode_frames(4, 2)
    assert sent == [4, 0xA0, 0, 0, 0, 0, 0, 0, 2, 0x24]
    assert spec == [4, 0xA0, 0, 0, 0, 0, 0, 0, 0, 2]
    assert dmc.mode_frames(5, 2)[0][-1] == 0x80
    assert dmc.mode_frames(4, 1)[0][-1] == 0xC6


def test_repeated_and_unreceived_frames_are_not_counted():
    # 同じ受信時刻は 1 フレーム、受信時刻 0 は未受信
    summary = wheel((0, 2), (100, 2), (100, 2), (200, 2))
    assert summary.frames == 2


def test_frames_older_than_the_window_are_ignored():
    # 非常停止の前に受けたフレーム（古い受信時刻）は解除の後の判定に使わない
    summary = wheel((50, 2), (150, 1), min_stamp_ns=100)
    assert summary.frames == 1
    assert dmc.dominant_mode(summary) == 1


def test_judge():
    assert dmc.judge(wheel((1, 2), (2, 2)), 2) == dmc.OK
    assert dmc.judge(wheel((1, 2), (2, 1)), 2) == dmc.MISMATCH
    assert dmc.judge(wheel((1, 2)), 1) == dmc.MISMATCH
    assert dmc.judge(wheel(), 2) == dmc.NO_FEEDBACK


def test_exit_code_puts_mismatch_first():
    assert dmc.exit_code([dmc.OK, dmc.OK]) == 0
    assert dmc.exit_code([dmc.OK, dmc.NO_FEEDBACK]) == 2
    assert dmc.exit_code([dmc.NO_FEEDBACK, dmc.MISMATCH]) == 1
    assert dmc.exit_code([]) == 2


def test_describe_marks_the_result():
    assert " OK " in dmc.describe("left", wheel((1, 2)), 2)
    assert " NG " in dmc.describe("left", wheel((1, 2)), 1)
    assert "判定不能" in dmc.describe("left", wheel(), 2)
