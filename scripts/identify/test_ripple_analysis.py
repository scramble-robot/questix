#!/usr/bin/env python3
"""ripple_analysis.py の検算: 合成データで回転同期成分と一定周波数成分を分離・分類できるか.

合成する車輪速度（前進が正）:
  v(t) = 指令 + A1 sin(2π θ(t) + φ)   … 1 回転に 1 回の揺れ（回転同期、1 次）
              + A2 sin(2π 1.8 t)      … 回転数によらない 1.8 Hz の揺れ（仮定値。実機の床の上では約 1.5〜1.75 Hz）
ワイヤ値は整数 rpm に量子化し、右輪は符号を反転、位置は 0..32767 で巻き戻る。
/drive_control_sample 形式では 1 割の tick を「新しいフレームなし（同じフレームの繰り返し）」に、
5% の tick を欠落させる。ROS 2 も rosbag2 も使わない（CSV 経路だけ）。
"""
import csv
import math
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(__file__))
import ripple_analysis as ra  # noqa: E402

DT = 0.02  # 50 Hz の制御 tick
LEVELS = (30, 45, 60, 90)  # rpm（回転周波数 0.5〜1.5 Hz。1.8 Hz と重ならない）
HOLD = 20.0  # 各レベルの保持 [s]
GAP = 2.0  # レベル間の 0 [s]
FIXED_HZ = 1.8


def simulate(a1=4.0, a2=6.0, levels=LEVELS, seed=0):
    """両輪の真の速度・回転角とワイヤ値を tick ごとに作る."""
    rng = np.random.default_rng(seed)
    schedule = []
    for level in levels:
        schedule += [0.0] * int(GAP / DT) + [float(level)] * int(HOLD / DT)
    schedule += [0.0] * int(GAP / DT)
    ticks = []
    theta = {"left": 0.0, "right": 0.3}  # [rev]
    phase = {"left": 0.4, "right": 1.9}
    for k, command in enumerate(schedule):
        t = 100.0 + k * DT
        row = {"t": t, "command": command}
        for side in ra.SIDES:
            v = command
            if command != 0.0:
                v += a1 * math.sin(2 * math.pi * theta[side] + phase[side])
                v += a2 * math.sin(2 * math.pi * FIXED_HZ * t)
            theta[side] += v / 60.0 * DT
            sign = ra.FORWARD_SIGN[side]
            row[side] = {
                "rpm_wire": int(round(sign * v + rng.normal(0, 0.3))),
                "position_wire": int(round(sign * theta[side] * ra.POSITION_COUNTS))
                % ra.POSITION_COUNTS,
                "command_wire": int(round(sign * command)),
            }
        ticks.append(row)
    return ticks


def control_sample_rows(ticks, dup_every=10, drop_every=20):
    """/drive_control_sample 形式の行。dup_every ごとに重複、drop_every ごとに欠落を入れる."""
    rows = []
    count = {s: 0 for s in ra.SIDES}
    last = {s: None for s in ra.SIDES}
    for seq, tick in enumerate(ticks):
        row = {"stamp": tick["t"], "seq": seq}
        duplicate = seq % dup_every == 5
        for side in ra.SIDES:
            w = tick[side]
            if duplicate and last[side] is not None:
                frame = last[side]
                new = 0
            else:
                count[side] += 1
                frame = {"count": count[side], "stamp": tick["t"] - 0.004, **w}
                last[side] = frame
                new = 1
            row.update({
                f"{side}_feedback_new": new,
                f"{side}_feedback_count": frame["count"],
                f"{side}_feedback_stamp": frame["stamp"],
                f"{side}_velocity_rpm_raw": frame["rpm_wire"],
                f"{side}_position_raw": frame["position_wire"],
                f"{side}_current_raw": 0,
                f"{side}_command_rpm": w["command_wire"],
                f"{side}_ref_rpm": w["command_wire"],
            })
        if seq % drop_every == 7:
            continue  # このサンプルは欠落（フレームは受信済みだが記録に載らない）
        rows.append(row)
    return rows


def write_csv(path, rows, columns):
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)


@pytest.fixture(scope="module")
def sample_result(tmp_path_factory):
    rows = control_sample_rows(simulate())
    path = tmp_path_factory.mktemp("ripple") / "samples.csv"
    write_csv(path, rows, ra.SAMPLE_CSV_COLUMNS)
    data = ra.load_csv(str(path))
    return data, ra.analyze(data)


def test_duplicates_and_losses_are_counted(sample_result):
    data, _ = sample_result
    stats = data["stats"]
    ticks = len(simulate())
    assert stats["samples"] == ticks - len(range(7, ticks, 20))
    assert stats["seq_gaps"] == len(range(7, ticks, 20))
    assert stats["lost_samples"] == stats["seq_gaps"]
    # 重複（new=0）の行は除かれ、欠落したサンプルに載っていたフレームは missing として数える
    for side in ra.SIDES:
        assert stats["duplicates_removed"][side] > 0.08 * ticks
        assert stats["frames_missing"][side] > 0
        t = data["wheels"][side]["t"]
        assert np.all(np.diff(t) > 0)  # 同じフレームが 2 回入っていない


def test_segments_are_the_constant_levels(sample_result):
    _, result = sample_result
    for side in ra.SIDES:
        segments = result["wheels"][side]["segments"]
        assert [round(s["command_rpm"]) for s in segments] == list(LEVELS)
        for s, level in zip(segments, LEVELS):
            assert s["mean_rpm"] == pytest.approx(level, abs=1.0)  # 前進が正（右も）
            assert s["rotation_hz"] == pytest.approx(level / 60.0, rel=0.03)
            # 位置から求めた回転角が速度と合う（巻き戻しと欠落をまたいでつながっている）
            assert s["angle_speed_ratio"] == pytest.approx(1.0, abs=0.03)


def test_the_two_components_are_separated(sample_result):
    _, result = sample_result
    for side in ra.SIDES:
        for s in result["wheels"][side]["segments"]:
            order1 = s["orders"][0]
            assert order1["amp_rpm"] == pytest.approx(4.0, abs=1.0), s["mean_rpm"]
            assert order1["resolvable"]
            higher = [o["amp_rpm"] for o in s["orders"][1:]]
            assert max(higher) < 1.0  # 合成していない次数はほぼ 0
            residual = s["residual_peak"]
            assert residual["freq_hz"] == pytest.approx(FIXED_HZ, abs=0.06)
            assert residual["amp_rpm"] == pytest.approx(6.0, rel=0.25)


def test_the_components_are_classified(sample_result):
    _, result = sample_result
    for side in ra.SIDES:
        summary = result["wheels"][side]
        # 生の卓越周波数は 1.8 Hz（A2 > A1）: 回転数によらず一定
        assert summary["dominant"]["kind"] == "fixed_frequency"
        assert summary["dominant"]["constant_hz"] == pytest.approx(FIXED_HZ, abs=0.06)
        assert summary["non_synchronous"]["kind"] == "fixed_frequency"
        assert summary["order1"]["segments_resolvable"] == len(LEVELS)


def test_a_dominant_rotation_ripple_is_rotation_synchronous(tmp_path):
    rows = control_sample_rows(simulate(a1=8.0, a2=1.5, seed=1))
    path = tmp_path / "samples.csv"
    write_csv(path, rows, ra.SAMPLE_CSV_COLUMNS)
    result = ra.analyze(ra.load_csv(str(path)))
    dominant = result["wheels"]["left"]["dominant"]
    assert dominant["kind"] == "rotation_synchronous"
    assert dominant["proportional_order"] == pytest.approx(1.0, abs=0.05)


def test_components_below_the_encoder_error_are_not_resolvable(tmp_path):
    # 1 次 0.2 rpm @ 30 rpm: エンコーダ誤差の閾値 1% × 1 次 × 30 rpm = 0.3 rpm を下回る
    rows = control_sample_rows(simulate(a1=0.2, a2=0.0, levels=(30, 60), seed=2))
    path = tmp_path / "samples.csv"
    write_csv(path, rows, ra.SAMPLE_CSV_COLUMNS)
    result = ra.analyze(ra.load_csv(str(path)))
    first = result["wheels"]["left"]["segments"][0]
    assert first["orders"][0]["amp_rpm"] < 0.3
    assert not first["orders"][0]["resolvable"]
    assert ra.resolvable(1.8, 1.0, 1.0) is False  # 閾値 0.6 × 1.8 = 1.08 rpm
    assert ra.resolvable(1.8, 1.2, 1.0) is True


def test_left_and_right_sum_and_difference(sample_result):
    _, result = sample_result
    forward = result["wheels"]["forward"]
    turn = result["wheels"]["turn"]
    assert len(forward["segments"]) == len(LEVELS)
    # 1.8 Hz の揺れは左右同相: 前後（和）に残り、旋回（差）では打ち消し合う
    for f_seg, t_seg in zip(forward["segments"], turn["segments"]):
        assert f_seg["residual_peak"]["freq_hz"] == pytest.approx(FIXED_HZ, abs=0.06)
        assert f_seg["residual_peak"]["amp_rpm"] > 4.0
        assert abs(t_seg["mean_rpm"]) < 1.0
        assert t_seg["rotation_hz"] > 0.4  # 車輪は回っている
    turn_peaks = [s["time_peak"] for s in turn["segments"]]
    near_fixed = [p["amp_rpm"] for p in turn_peaks if abs(p["freq_hz"] - FIXED_HZ) < 0.1]
    assert all(a < 1.5 for a in near_fixed)


def test_lab_csv_is_read_with_its_own_columns(tmp_path):
    # QUESTiX LAB の -messages.csv: 20 Hz に間引かれ、位置は無く、同じフレームが 2 行に出ることがある
    ticks = simulate(seed=3)
    rows = []
    for k, tick in enumerate(ticks):
        if k % 5 not in (0, 3):  # 50 Hz -> 20 Hz
            continue
        # 10 tick に 1 回、前の行と同じフレームをもう一度出す（ブリッジの間引きで起きる重複）
        frame = ticks[k - 3] if k % 10 == 3 else tick
        row = {"time_s": f"{tick['t'] - 100:.3f}", "stream": "drive", "stamp_s": tick["t"]}
        for side in ra.SIDES:
            row[f"{side}_raw_rpm_native"] = frame[side]["rpm_wire"]
            row[f"{side}_target_rpm_native"] = frame[side]["command_wire"]
            row[f"{side}_feedback_stamp_s"] = f"{frame['t']:.6f}"
            row[f"{side}_current_a"] = 0.0
        rows.append(row)
        rows.append({"time_s": row["time_s"], "stream": "twist", "stamp_s": tick["t"]})
    columns = ["time_s", "stream", "stamp_s"] + [
        f"{side}_{name}" for side in ra.SIDES
        for name in ("raw_rpm_native", "target_rpm_native", "feedback_stamp_s", "current_a")]
    path = tmp_path / "lab-messages.csv"
    with open(path, "w", newline="", encoding="utf-8") as f:
        f.write("﻿")
        writer = csv.DictWriter(f, fieldnames=columns, restval="")
        writer.writeheader()
        writer.writerows(rows)
    data = ra.load_csv(str(path))
    assert data["source"] == "lab_csv"
    assert data["angle_source"] == "speed_integral"
    assert data["stats"]["duplicates_removed"]["left"] > 0
    result = ra.analyze(data)
    left = result["wheels"]["left"]
    assert len(left["segments"]) == len(LEVELS)
    for s in left["segments"]:
        assert s["orders"][0]["amp_rpm"] == pytest.approx(4.0, abs=1.2)
        assert s["residual_peak"]["freq_hz"] == pytest.approx(FIXED_HZ, abs=0.08)
    assert left["non_synchronous"]["kind"] == "fixed_frequency"


def test_unwrap_follows_the_speed_across_the_boundary_and_gaps():
    # 2 rev/s で 0..32767 を何度もまたぎ、途中 3 フレーム欠ける
    t = np.array([0.0, 0.02, 0.04, 0.12, 0.14, 0.16, 0.3])
    rev_true = 2.0 * t + 0.95
    position = np.round(rev_true * ra.POSITION_COUNTS) % ra.POSITION_COUNTS
    rpm = np.full(len(t), 120.0)
    rev = ra.unwrap_position(t, position, rpm)
    assert np.allclose(rev - rev[0], rev_true - rev_true[0], atol=1e-4)
    # 逆回転（右輪の前進）も
    rev_back = ra.unwrap_position(t, (ra.POSITION_COUNTS - position) % ra.POSITION_COUNTS, -rpm)
    assert np.allclose(rev_back - rev_back[0], -(rev_true - rev_true[0]), atol=1e-4)


def test_classify_needs_two_speeds():
    assert ra.classify([(1.0, 1.8)])["kind"] == "insufficient"
    assert ra.classify([(1.0, 1.8), (1.1, 1.8)])["kind"] == "insufficient"  # 範囲が狭い
    assert ra.classify([(0.5, 1.8), (1.0, 1.81), (1.5, 1.79)])["kind"] == "fixed_frequency"
    assert ra.classify([(0.5, 0.5), (1.0, 1.0), (1.5, 1.52)])["kind"] == "rotation_synchronous"
    assert ra.classify([(0.5, 0.9), (1.0, 3.0), (1.5, 0.4)])["kind"] == "unclear"


def _steady_wheel(rotation_rps, ripple_rpm, order, seconds=20.0, dt=DT):
    """一定の回転 + order 次の揺れ（回転角の位相）だけを持つ 1 輪（前進が正）."""
    t = 100.0 + np.arange(0.0, seconds, dt)
    rev = rotation_rps * (t - t[0])
    rpm = rotation_rps * 60.0 + ripple_rpm * np.sin(2 * math.pi * order * rev)
    return {"t": t, "rpm": rpm, "rev": rev, "current": np.full(len(t), np.nan),
            "command": np.full(len(t), rotation_rps * 60.0)}


def test_a_tracked_order_below_the_nyquist_frequency_is_fit_directly():
    # 30 rpm（0.5 rev/s）の 20 次 = 10 Hz、50 Hz の記録の上限 25 Hz より下
    wheel = _steady_wheel(0.5, 0.7, 20)
    seg = ra.analyze_segment(wheel, 0, len(wheel["t"]), track_orders=(20,))
    assert seg["nyquist_hz"] == pytest.approx(25.0, rel=1e-6)
    item = seg["tracked_orders"][0]
    assert item["order"] == 20 and not item["aliased"]
    assert item["freq_hz"] == pytest.approx(10.0, rel=1e-6)
    assert item["amp_rpm"] == pytest.approx(0.7, rel=0.02)
    assert seg["time_peak"]["freq_hz"] == pytest.approx(10.0, abs=0.06)
    assert seg["time_peak"]["tracked_order"] == 20
    assert seg["time_peak"]["aliased"] is False
    # 同期平均は 8 次までなので、20 次は残差に残る
    assert seg["residual_max_order"] <= ra.MAX_ORDER
    assert seg["residual_peak"]["tracked_order"] == 20


def test_a_tracked_order_above_the_nyquist_frequency_is_marked_as_aliased():
    # 120 rpm（2 rev/s）の 20 次 = 40 Hz → 50 Hz の記録では |40 − 50| = 10 Hz に見える
    wheel = _steady_wheel(2.0, 0.5, 20)
    seg = ra.analyze_segment(wheel, 0, len(wheel["t"]), track_orders=(20,))
    item = seg["tracked_orders"][0]
    assert item["aliased"] is True
    assert item["freq_hz"] == pytest.approx(40.0, rel=1e-6)
    assert item["observed_hz"] == pytest.approx(10.0, abs=1e-6)
    assert not item["ill_conditioned"]
    assert item["amp_rpm"] == pytest.approx(0.5, rel=0.05)
    assert seg["time_peak"]["freq_hz"] == pytest.approx(10.0, abs=0.06)
    assert seg["time_peak"]["tracked_order"] == 20
    assert seg["time_peak"]["aliased"] is True
    assert "20次の折り返し" in ra._tracked_note(seg["time_peak"])


def test_alias_frequency_folds_into_the_observable_band():
    assert ra.alias_frequency(6.66, 50.0) == pytest.approx(6.66)
    assert ra.alias_frequency(26.5, 50.0) == pytest.approx(23.5)
    assert ra.alias_frequency(49.67, 50.0) == pytest.approx(0.33)
    assert ra.alias_frequency(60.0, 50.0) == pytest.approx(10.0)


def test_insufficient_says_whether_segments_or_resolvable_peaks_are_missing():
    few_segments = ra.classify([(1.0, 1.8)], segments=1, peaks=1)
    assert "定速区間が 2 つ未満" in few_segments["reason"]
    few_peaks = ra.classify([(1.0, 1.8)], segments=16, peaks=16)
    assert few_peaks["kind"] == "insufficient"
    assert "判別できるピークが 1 個" in few_peaks["reason"]
    assert "定速区間 16" in few_peaks["reason"]
