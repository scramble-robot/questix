#!/usr/bin/env python3
"""step_sequence.py の検算（ROS なし）: 他の送り手の検出とスケジュール。"""
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(__file__))
from step_sequence import ForeignTwistDetector, build_schedule, twist_values  # noqa: E402


def test_own_values_are_not_foreign():
    args = SimpleNamespace(turn=False, wheel_radius=0.1, wheel_separation=0.5)
    det = ForeignTwistDetector(grace_sec=0.2)
    det.expect(*twist_values(0, args), now=0.0)
    det.expect(*twist_values(100, args), now=1.0)
    assert not det.is_foreign(*twist_values(100, args), now=1.05)
    # 切り替え直後に遅れて届いた 1 つ前の値も自分のもの
    assert not det.is_foreign(*twist_values(0, args), now=1.1)


def test_controller_neutral_during_step_is_foreign():
    # コントローラ接続中の中立（0）がステップ中に割り込む = 同定データが汚れる典型例
    args = SimpleNamespace(turn=False, wheel_radius=0.1, wheel_separation=0.5)
    det = ForeignTwistDetector(grace_sec=0.2)
    det.expect(*twist_values(0, args), now=0.0)
    det.expect(*twist_values(100, args), now=3.0)
    # 猶予を過ぎてから届いた 0 は 1 つ前の値と同じでも他者
    assert det.is_foreign(0.0, 0.0, now=3.5)
    assert det.is_foreign(0.3, 0.0, now=3.05)  # スティック操作は猶予中でも他者


def test_other_axes_mark_foreign():
    det = ForeignTwistDetector()
    det.expect(0.0, 0.0, now=0.0)
    assert det.is_foreign(0.0, 0.0, now=0.0, other_axes_zero=False)


def test_turn_values_use_angular_only():
    args = SimpleNamespace(turn=True, wheel_radius=0.1, wheel_separation=0.5)
    lx, az = twist_values(60, args)
    assert lx == 0.0
    assert az > 0.0


def test_schedule_brackets_levels_with_zero():
    sched = build_schedule([50, 100], 4.0, "both", 1, 3.0)
    assert sched[0] == (0, 3.0)
    assert sched[-1] == (0, 3.0)
    assert [r for r, _ in sched if r != 0] == [50, 100, -50, -100]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok   - {name}")
    print("OK")
