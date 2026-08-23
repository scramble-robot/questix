#!/usr/bin/env python3
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""ステップ応答から一次遅れ + むだ時間モデルを同定する（design/model_based_drive_control.md Phase A）。

入力:
  --bag <rosbag2 dir>   /drive_status (questix_msgs/DriveStatus) を読む（ROS 2 環境が必要）
  --csv <file>          列: t, left_target, left_meas, right_target, right_meas
                        [, left_current, right_current]（current モード用、単位 A）

モデル（velocity モード）:  ω_{k+1} = a ω_k + (1-a) u_{k-d} + c
  u = 指令 RPM（target_rpm）、ω = 実測 RPM（生値）、d = むだ時間 [tick]、c = 定数外乱。
  d を 0..max_delay で総当たりし、各 d について (a, c) を最小二乗で求め、R² 最大の d を採用。
  τ = -dt / ln(a)。
モデル（current モード）:   ω_{k+1} = a ω_k + b i_{k-d} + c   （i = 電流 [A]）

レベル別の当てはまりも出す（|target| が一定の区間ごとに R² を計算）。RUN 域の閾値
（drive_fsm_run_enter_rpm）は「R² が --r2-threshold 以上になる最小レベル」を目安として提案する。

出力: identified_params.yaml（--out）と標準出力のレポート。
"""
from __future__ import annotations

import argparse
import math
import sys

import numpy as np


# ----------------------------------------------------------------------------- 読み込み
def load_csv(path):
    data = np.genfromtxt(path, delimiter=",", names=True)
    cols = data.dtype.names
    need = ("t", "left_target", "left_meas", "right_target", "right_meas")
    for n in need:
        if n not in cols:
            raise SystemExit(f"CSV に列 {n} がありません（列: {cols}）")
    out = {n: np.asarray(data[n], dtype=float) for n in need}
    for n in ("left_current", "right_current"):
        out[n] = np.asarray(data[n], dtype=float) if n in cols else None
    return out


def load_bag(path, topic="/drive_status"):
    try:
        import rosbag2_py
        from rclpy.serialization import deserialize_message
        from rosidl_runtime_py.utilities import get_message
    except ImportError as e:
        raise SystemExit(f"rosbag2 の読み込みに ROS 2 環境が必要です: {e}")
    reader = rosbag2_py.SequentialReader()
    reader.open(rosbag2_py.StorageOptions(uri=path, storage_id=""),
                rosbag2_py.ConverterOptions("", ""))
    types = {t.name: t.type for t in reader.get_all_topics_and_types()}
    if topic not in types:
        raise SystemExit(f"bag に {topic} がありません: {list(types)}")
    msg_type = get_message(types[topic])
    rows = []
    while reader.has_next():
        name, raw, t_ns = reader.read_next()
        if name != topic:
            continue
        m = deserialize_message(raw, msg_type)
        rows.append((t_ns * 1e-9, m.left.target_rpm, m.left.velocity_rpm, m.right.target_rpm,
                     m.right.velocity_rpm, m.left.current_amp, m.right.current_amp))
    if not rows:
        raise SystemExit("メッセージがありません")
    arr = np.array(rows, dtype=float)
    return {"t": arr[:, 0], "left_target": arr[:, 1], "left_meas": arr[:, 2],
            "right_target": arr[:, 3], "right_meas": arr[:, 4],
            "left_current": arr[:, 5], "right_current": arr[:, 6]}


# ----------------------------------------------------------------------------- 同定
def fit_first_order(omega, u, dt, max_delay=4, unity_gain=True):
    """Fit ω_{k+1} = a ω_k + b u_{k-d} + c by least squares.

    unity_gain=True なら b = 1 - a に拘束（velocity モード）。
    戻り値: dict(a, b, c, delay, tau, r2)
    """
    best = None
    n = len(omega)
    for d in range(0, max_delay + 1):
        k0 = d
        y = omega[k0 + 1:]
        om = omega[k0:-1]
        ud = u[k0 - d:n - 1 - d] if d > 0 else u[k0:-1]
        if unity_gain:
            # y - ud = a (om - ud) + c
            A = np.c_[om - ud, np.ones_like(om)]
            coef, *_ = np.linalg.lstsq(A, y - ud, rcond=None)
            a, c = coef
            b = 1.0 - a
            pred = a * om + b * ud + c
        else:
            A = np.c_[om, ud, np.ones_like(om)]
            coef, *_ = np.linalg.lstsq(A, y, rcond=None)
            a, b, c = coef
            pred = A @ coef
        ss_res = float(np.sum((y - pred) ** 2))
        ss_tot = float(np.sum((y - y.mean()) ** 2)) or 1e-12
        r2 = 1.0 - ss_res / ss_tot
        tau = -dt / math.log(a) if 0.0 < a < 1.0 else float("nan")
        cand = dict(a=float(a), b=float(b), c=float(c), delay=d, tau=tau, r2=r2)
        if best is None or r2 > best["r2"]:
            best = cand
    return best


def segments_by_level(target, min_len):
    """Return segments [(start, end, level), ...] where target is constant（end は排他）."""
    segs = []
    start = 0
    for k in range(1, len(target) + 1):
        if k == len(target) or target[k] != target[start]:
            if k - start >= min_len:
                segs.append((start, k, float(target[start])))
            start = k
    return segs


def fit_per_level(omega, u, dt, max_delay, unity_gain, min_len):
    res = {}
    for s, e, lv in segments_by_level(u, min_len):
        if lv == 0.0:
            continue
        # ステップ直前の数サンプルを含めて過渡を捉える
        s0 = max(0, s - max_delay - 2)
        fit = fit_first_order(omega[s0:e], u[s0:e], dt, max_delay, unity_gain)
        key = abs(lv)
        res.setdefault(key, []).append(fit)
    return res


def summarize(data, side, mode, dt, max_delay, min_len):
    omega = data[f"{side}_meas"]
    if mode == "velocity":
        u = data[f"{side}_target"]
        unity = True
    else:
        u = data[f"{side}_current"]
        if u is None:
            raise SystemExit("current モードには left_current/right_current 列が必要です")
        unity = False
    overall = fit_first_order(omega, u, dt, max_delay, unity)
    per_level = fit_per_level(omega, u, dt, max_delay, unity, min_len)
    return overall, per_level


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--bag")
    src.add_argument("--csv")
    ap.add_argument("--mode", choices=["velocity", "current"], default="velocity")
    ap.add_argument("--dt", type=float, default=None, help="サンプル周期 [s]（省略時は t の中央値）")
    ap.add_argument("--max-delay", type=int, default=4)
    ap.add_argument("--min-segment", type=int, default=25, help="レベル判定に使う最小サンプル数")
    ap.add_argument("--r2-threshold", type=float, default=0.9)
    ap.add_argument("--out", default="identified_params.yaml")
    args = ap.parse_args()

    data = load_bag(args.bag) if args.bag else load_csv(args.csv)
    t = data["t"]
    dt = args.dt if args.dt else float(np.median(np.diff(t)))
    print(f"samples={len(t)}  dt={dt*1000:.1f} ms  mode={args.mode}")

    report = {}
    for side in ("left", "right"):
        overall, per_level = summarize(data, side, args.mode, dt, args.max_delay, args.min_segment)
        report[side] = dict(overall=overall, per_level=per_level)
        print(f"\n[{side}] overall: a={overall['a']:.4f} b={overall['b']:.4f} c={overall['c']:+.3f} "
              f"delay={overall['delay']} tick tau={overall['tau']*1000:.1f} ms R2={overall['r2']:.3f}")
        print(f"  {'level':>7} {'n':>3} {'a':>7} {'tau[ms]':>8} {'delay':>5} {'R2':>6}")
        for lv in sorted(per_level):
            fits = per_level[lv]
            a = np.mean([f["a"] for f in fits])
            tau = np.nanmean([f["tau"] for f in fits])
            d = int(round(np.mean([f["delay"] for f in fits])))
            r2 = np.mean([f["r2"] for f in fits])
            print(f"  {lv:7.0f} {len(fits):3d} {a:7.4f} {tau*1000:8.1f} {d:5d} {r2:6.3f}")

    # RUN 閾値の提案: 両輪で R² >= threshold を満たす最小レベル
    def min_good_level(side):
        ok = [lv for lv, fits in report[side]["per_level"].items()
              if np.mean([f["r2"] for f in fits]) >= args.r2_threshold]
        return min(ok) if ok else None

    suggest = [x for x in (min_good_level("left"), min_good_level("right")) if x is not None]
    run_enter = int(max(suggest)) if len(suggest) == 2 else None

    lines = ["# 生成: scripts/identify/fit_models.py", f"mode: {args.mode}", f"dt_sec: {dt:.5f}"]
    for side in ("left", "right"):
        o = report[side]["overall"]
        lines += [f"{side}:", f"  a: {o['a']:.6f}", f"  b: {o['b']:.6f}", f"  c: {o['c']:.4f}",
                  f"  delay_ticks: {o['delay']}", f"  tau_sec: {o['tau']:.5f}", f"  r2: {o['r2']:.4f}",
                  "  per_level:"]
        for lv in sorted(report[side]["per_level"]):
            fits = report[side]["per_level"][lv]
            lines.append(f"    {int(lv)}: {{tau_sec: {np.nanmean([f['tau'] for f in fits]):.5f}, "
                         f"delay_ticks: {int(round(np.mean([f['delay'] for f in fits])))}, "
                         f"r2: {np.mean([f['r2'] for f in fits]):.4f}}}")
    lines.append("suggested:")
    tau_avg = float(np.nanmean([report[s]["overall"]["tau"] for s in ("left", "right")]))
    delay_avg = int(round(np.mean([report[s]["overall"]["delay"] for s in ("left", "right")])))
    lines.append(f"  velocity_run_model_tau_sec: {tau_avg:.4f}")
    lines.append(f"  velocity_run_model_delay_ticks: {delay_avg}")
    lines.append(f"  drive_fsm_run_enter_rpm: {run_enter if run_enter is not None else 'null  # R2 基準を満たすレベルなし'}")
    with open(args.out, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"\nwrote {args.out}")
    if run_enter is None:
        print("注意: R² 基準を満たすレベルが無い（一次遅れで当てはまらない）。Phase E は no-go。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
