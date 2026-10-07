#!/usr/bin/env python3
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""record.sh の記録から、定速区間ごとの車輪の電流と速度の揺れを集計する.

目的: 共振ダンピングを「床の上（機体の慣性が載っている）のときだけ」効かせるための判定量を
選ぶ。床では機体を動かすのでモータ電流が大きく振れ、車輪を浮かせると電流はほぼ 0 になる、
という見込みを実測で確かめ、しきい値を決める。

区間は /target_twist（補正前の目標）が一定の範囲で、変化から --settle 秒を捨てる
（ripple_by_twist.py と同じ区切り）。各輪について、区間内の新しいフィードバックだけで:
  - 電流 |I| の平均、電流の RMS（平均まわり）、|I| の 95 パーセンタイル [A]
  - 速度（velocity_rpm_raw）の平均と p2p [rpm]
  - 送った指令（target_rpm）の tick ごとの変化の RMS [rpm]（補正の細かさ）
  - 進行方向の最低速度 [rpm] と、ほぼ止まっている（進行方向に --stall-rpm 以下）フレームの割合
    （スティックスリップなら周期ごとに車輪が止まりかける）
  - 電流が区間の平均と逆向きのフレームの割合（逆トルク = ブレーキがかかっている割合）。
    電流の符号規約に依らないよう、区間の平均電流（摩擦に逆らって進める向き）を基準にする
  - フィードバックの間隔の最大 [ms] と、--gap-ms を超えた欠けの回数。フィードバックは
    指令 1 回に 1 回返るので、欠けは「指令がモータに届かなかった / 制御 tick が遅れた」を表す

ROS 2（rosbag2_py）が必要。numpy は使わない。

使い方:
  python3 scripts/identify/current_stats.py ~/ident_data/ident_*_20261007_22*/bag
"""
from __future__ import annotations

import argparse
import math
import os
import sys

from ripple_by_twist import read_geometry, wheel_reference_rpm

SIDES = ("left", "right")


def _open(path):
    try:
        import rosbag2_py
        from rclpy.serialization import deserialize_message
        from rosidl_runtime_py.utilities import get_message
    except ImportError as exc:
        raise SystemExit(f"rosbag2 の読み込みに ROS 2 環境が必要です: {exc}")
    reader = rosbag2_py.SequentialReader()
    reader.open(rosbag2_py.StorageOptions(uri=path, storage_id=""),
                rosbag2_py.ConverterOptions("", ""))
    types = {t.name: t.type for t in reader.get_all_topics_and_types()}
    return reader, types, deserialize_message, get_message


def read_bag(path):
    """(/target_twist の [(t, (v, w))], 輪ごとの [(t, rpm, current, command)]) を返す。"""
    reader, types, deserialize_message, get_message = _open(path)
    for topic in ("/drive_status", "/target_twist"):
        if topic not in types:
            raise SystemExit(f"{path}: {topic} がありません")
    status_type = get_message(types["/drive_status"])
    twist_type = get_message(types["/target_twist"])
    twists = []
    frames = {side: [] for side in SIDES}
    last_stamp = {side: None for side in SIDES}
    while reader.has_next():
        name, raw, stamp_ns = reader.read_next()
        if name == "/target_twist":
            msg = deserialize_message(raw, twist_type)
            twists.append((stamp_ns * 1e-9, (float(msg.linear.x), float(msg.angular.z))))
        elif name == "/drive_status":
            msg = deserialize_message(raw, status_type)
            for side in SIDES:
                fb = getattr(msg, side)
                stamp = fb.header.stamp.sec + fb.header.stamp.nanosec * 1e-9
                # 同じフレームは publish のたびに数 µs ずれた受信時刻で載る（5 ms 以内は同じ）
                if stamp <= 0.0 or (last_stamp[side] is not None
                                    and abs(stamp - last_stamp[side]) < 0.005):
                    continue
                last_stamp[side] = stamp
                frames[side].append((stamp, float(fb.velocity_rpm_raw), float(fb.current_amp),
                                     float(fb.target_rpm)))
    return twists, frames


def segments(twists, settle, min_sec):
    """目標が一定の区間 [(t0, t1, (v, w))]（変化から settle 秒を捨てる、0 の区間は除く）。"""
    out = []
    i = 0
    while i < len(twists):
        j = i
        while j + 1 < len(twists) and twists[j + 1][1] == twists[i][1]:
            j += 1
        t0 = twists[i][0] + settle
        t1 = twists[j][0]
        if twists[i][1] != (0.0, 0.0) and t1 - t0 >= min_sec:
            out.append((t0, t1, twists[i][1]))
        i = j + 1
    return out


def stats(samples, stall_rpm=2.0, gap_sec=0.03):
    """区間内のフレームの集計（フレームが少なければ None）。"""
    if len(samples) < 10:
        return None
    rpm = [s[1] for s in samples]
    cur = [s[2] for s in samples]
    cmd = [s[3] for s in samples]
    mean_cur = sum(cur) / len(cur)
    abs_cur = sorted(abs(c) for c in cur)
    steps = [b - a for a, b in zip(cmd, cmd[1:])]
    direction = 1.0 if sum(rpm) >= 0.0 else -1.0
    forward = [r * direction for r in rpm]
    drive_sign = 1.0 if mean_cur >= 0.0 else -1.0
    gaps = [b[0] - a[0] for a, b in zip(samples, samples[1:])]
    return {
        "n": len(samples),
        "abs_i_mean": sum(abs_cur) / len(abs_cur),
        "i_rms": math.sqrt(sum((c - mean_cur) ** 2 for c in cur) / len(cur)),
        "abs_i_p95": abs_cur[int(0.95 * (len(abs_cur) - 1))],
        "rpm_mean": sum(rpm) / len(rpm),
        "rpm_p2p": max(rpm) - min(rpm),
        "cmd_step_rms": math.sqrt(sum(s * s for s in steps) / len(steps)) if steps else 0.0,
        "min_forward_rpm": min(forward),
        "stall_pct": 100.0 * sum(1 for r in forward if r <= stall_rpm) / len(forward),
        "reverse_i_pct": 100.0 * sum(1 for c in cur if c * drive_sign < 0.0) / len(cur),
        "max_gap_ms": 1000.0 * max(gaps),
        "gaps": sum(1 for g in gaps if g > gap_sec),
    }


def damping_gain(bag_path):
    """記録の前の velocity_damping_gain_sec（読めなければ None）。"""
    path = os.path.join(os.path.dirname(os.path.abspath(bag_path.rstrip("/"))),
                        "drive_component_params_before.yaml")
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if "velocity_damping_gain_sec:" in line:
                    return float(line.split(":", 1)[1])
    except (OSError, ValueError):
        pass
    return None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("bags", nargs="+", help="rosbag2 ディレクトリ（複数可）")
    ap.add_argument("--settle", type=float, default=1.0)
    ap.add_argument("--min-sec", type=float, default=2.0)
    ap.add_argument("--stall-rpm", type=float, default=2.0,
                    help="進行方向にこれ以下を「ほぼ停止」と数える [rpm]")
    ap.add_argument("--gap-ms", type=float, default=30.0,
                    help="フィードバックの間隔がこれを超えたら欠けと数える [ms]（制御周期 20 ms）")
    args = ap.parse_args(argv)
    for bag in args.bags:
        radius, separation, _ = read_geometry(bag, 0.05, 0.5)
        twists, frames = read_bag(bag)
        gain = damping_gain(bag)
        name = os.path.basename(os.path.dirname(os.path.abspath(bag.rstrip("/"))))
        print(f"\n=== {name}  velocity_damping_gain_sec={gain}")
        print("  輪    目標rpm  実測rpm  p2p  |I|平均  I_RMS  |I|p95  指令変化RMS  フレーム"
              "  最低rpm  停止%  逆電流%  最大間隔ms  欠け")
        for t0, t1, (v, w) in segments(twists, args.settle, args.min_sec):
            refs = dict(zip(SIDES, wheel_reference_rpm(v, w, radius, separation)))
            for side in SIDES:
                s = stats([f for f in frames[side] if t0 <= f[0] <= t1], args.stall_rpm,
                          args.gap_ms / 1000.0)
                if s is None:
                    continue
                print(f"  {side:5s} {refs[side]:7.0f}  {s['rpm_mean']:7.1f} {s['rpm_p2p']:5.0f}"
                      f"  {s['abs_i_mean']:6.2f} {s['i_rms']:6.2f} {s['abs_i_p95']:6.2f}"
                      f"  {s['cmd_step_rms']:10.2f}  {s['n']:6d}"
                      f"  {s['min_forward_rpm']:7.0f} {s['stall_pct']:6.1f} {s['reverse_i_pct']:7.1f}"
                      f"  {s['max_gap_ms']:9.0f} {s['gaps']:5d}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
