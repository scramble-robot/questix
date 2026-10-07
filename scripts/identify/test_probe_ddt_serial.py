#!/usr/bin/env python3
"""probe_ddt_serial.py の検算（ROS・実機なし）: フレームの組み立てと応答の分類。"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import probe_ddt_serial as probe  # noqa: E402
from drive_mode_check import crc8_maxim  # noqa: E402


def reply(motor_id, mode=2, speed=0):
    data = [motor_id, mode, 0, 0, (speed >> 8) & 0xFF, speed & 0xFF, 0, 0, 0]
    return bytes(data + [crc8_maxim(data)])


def test_stop_frame_matches_drive_component():
    # ddt_protocol::packVelocityFrame(4, 0, accel_time=1, brake=false) と同じ並び
    frame = probe.stop_frame(4)
    assert frame[:9] == [4, 0x64, 0, 0, 0, 0, 1, 0, 0]
    assert frame[9] == crc8_maxim(frame[:9])


def test_parse_ids():
    assert probe.parse_ids("4,5") == [4, 5]
    assert probe.parse_ids("1-3, 7") == [1, 2, 3, 7]


def test_frame_is_found_after_leading_noise():
    data = b"\x00\xff" + reply(5, speed=-12)
    frame = probe.find_frame(data, 5)
    assert probe.decode(frame)["speed_rpm"] == -12
    assert probe.find_frame(data, 4) is None


def test_classify():
    sent = probe.stop_frame(4)
    assert probe.classify(sent, reply(4), 4) == "ok"
    assert probe.classify(sent, b"", 4) == "none"
    assert probe.classify(sent, bytes(sent), 4) == "echo"
    assert probe.classify(sent, b"\x55\xaa", 4) == "garbage"
    # 別の ID の正しい応答は、この ID の応答ではない
    assert probe.classify(sent, reply(5), 4) == "garbage"


def test_echo_followed_by_the_reply_is_ok():
    # 変換器のエコーの後に本当の応答が続く場合は、応答のほうを読む
    sent = probe.stop_frame(4)
    data = bytes(sent) + reply(4, speed=7)
    assert probe.classify(sent, data, 4) == "ok"
    assert probe.decode(probe.find_frame(data, 4, sent))["speed_rpm"] == 7
