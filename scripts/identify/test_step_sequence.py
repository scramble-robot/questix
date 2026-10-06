#!/usr/bin/env python3
"""step_sequence.py の検算（ROS なし）: 他の送り手の検出とスケジュール。"""
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(__file__))
import pytest  # noqa: E402

from step_sequence import (  # noqa: E402
    EXIT_EMERGENCY_STOP, EXIT_ESTOP_NOT_RECEIVED, EstopGuard, ForeignTwistDetector, build_schedule,
    max_rpm_problems, parse_schedule, rpm_to_linear, start_gate_problems, start_refusal, twist_values)


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


def test_schedule_with_per_level_holds():
    sched = build_schedule(parse_schedule("3:60,5:60,10:30"), 0.0, "pos", 1, 3.0)
    assert sched == [(0, 3.0), (3, 60.0), (0, 3.0), (5, 60.0), (0, 3.0), (10, 30.0), (0, 3.0)]


def test_parse_schedule_rejects_bad_items():
    for text in ("3", "0:10", "3:0", "", "a:1"):
        with pytest.raises(ValueError):
            parse_schedule(text)


def test_lead_in_goes_to_slow_levels_without_passing_zero():
    sched = build_schedule([(1, 150.0), (5, 60.0)], 0.0, "both", 1, 3.0,
                           lead_in_rpm=4, lead_in_sec=1.0)
    assert sched == [(0, 3.0), (4, 1.0), (1, 150.0), (0, 3.0), (5, 60.0),
                     (0, 3.0), (-4, 1.0), (-1, 150.0), (0, 3.0), (-5, 60.0), (0, 3.0)]


def test_start_gate_matches_drive_stop_gate():
    # min_command_rpm=5: 走行は 5 rpm 以上、止まった状態からの動き出しは 7 rpm 以上
    assert start_gate_problems([(0, 3.0), (10, 30.0), (0, 3.0)], 5) == []
    assert len(start_gate_problems([(0, 3.0), (5, 60.0)], 5)) == 1  # 動き出せない
    assert len(start_gate_problems([(0, 3.0), (3, 60.0)], 5)) == 1  # 停止指令になる
    # min_command_rpm=0 でも下限は 1 rpm、動き出しは 3 rpm 以上
    assert start_gate_problems([(0, 3.0), (3, 60.0)], 0) == []
    assert len(start_gate_problems([(0, 3.0), (2, 60.0)], 0)) == 1
    # 助走で 3 rpm 以上に入ってから 1 rpm へ下げるのは通る
    assert start_gate_problems([(0, 3.0), (4, 1.0), (1, 150.0), (0, 3.0)], 0) == []


def _wheel_rpms(lx, az, args):
    """drive_component の差動二輪の換算（v_left = v - w*sep/2, v_right = v + w*sep/2）."""
    unit = rpm_to_linear(1, args.wheel_radius)
    left = (lx - az * args.wheel_separation / 2.0) / unit
    right = (lx + az * args.wheel_separation / 2.0) / unit
    return left, right


def test_pivot_keeps_one_wheel_still():
    args = SimpleNamespace(turn=False, pattern="pivot-left", wheel_radius=0.1, wheel_separation=0.5)
    left, right = _wheel_rpms(*twist_values(5, args), args)
    assert left == pytest.approx(0.0, abs=1e-9)
    assert right == pytest.approx(5.0)
    args.pattern = "pivot-right"
    left, right = _wheel_rpms(*twist_values(-3, args), args)
    assert left == pytest.approx(-3.0)
    assert right == pytest.approx(0.0, abs=1e-9)


def test_spin_and_straight_patterns():
    args = SimpleNamespace(turn=False, pattern="spin", wheel_radius=0.1, wheel_separation=0.5)
    left, right = _wheel_rpms(*twist_values(10, args), args)
    assert left == pytest.approx(-10.0) and right == pytest.approx(10.0)
    args.pattern = "straight"
    left, right = _wheel_rpms(*twist_values(10, args), args)
    assert left == pytest.approx(10.0) and right == pytest.approx(10.0)


def test_estop_guard_needs_a_fresh_release():
    guard = EstopGuard(timeout_sec=1.0)
    assert not guard.ok(0.0)  # 何も受信していない
    guard.update(False, 0.0)
    assert guard.ok(0.5)
    assert not guard.ok(1.6)  # 受信が途絶えた
    assert "途絶" in guard.reason


def test_estop_guard_stays_stopped_after_a_press():
    guard = EstopGuard(timeout_sec=1.0)
    guard.update(False, 0.0)
    guard.update(True, 0.1)
    assert not guard.ok(0.2)
    guard.update(False, 0.3)  # 解除されても、残りのステップは再開しない
    assert not guard.ok(0.4)
    assert "押下" in guard.reason


def test_start_refusal_separates_press_from_no_message():
    guard = EstopGuard(timeout_sec=1.0)
    code, reason = start_refusal(guard, 2.0)  # 2 秒聞いて 1 件も受信していない
    assert code == EXIT_ESTOP_NOT_RECEIVED and "1 件も" in reason
    guard.update(False, 2.5)  # 遅れて届いた解除
    assert start_refusal(guard, 2.6) is None
    assert guard.count == 1 and guard.first_at == 2.5
    code, reason = start_refusal(guard, 4.0)  # 開始前に途絶えた（押下ではない）
    assert code == EXIT_ESTOP_NOT_RECEIVED and "途絶" in reason
    pressed = EstopGuard(timeout_sec=1.0)
    pressed.update(True, 0.1)
    code, reason = start_refusal(pressed, 0.2)
    assert code == EXIT_EMERGENCY_STOP and "押下" in reason


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok   - {name}")
    print("OK")


def test_max_rpm_problems_refuses_clipped_levels():
    """max_motor_rpm（と仕様上限 475）を超えるレベルは、同定の入力が変わるので拒否する."""
    schedule = [(0, 3.0), (300, 4.0), (0, 3.0), (-400, 4.0), (0, 3.0)]
    assert max_rpm_problems(schedule, 475) == []
    assert len(max_rpm_problems(schedule, 330)) == 1  # -400 だけ
    assert len(max_rpm_problems(schedule, 200)) == 2
    assert len(max_rpm_problems([(500, 1.0)], 900)) == 1  # 仕様上限 475 で切り詰められる
