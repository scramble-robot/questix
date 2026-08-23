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


# ----------------------------------------------------------------------------- 解析 API
def analyze(data, mode="velocity", dt=None, max_delay=4, min_segment=25, r2_threshold=0.9):
    """Run the identification on one dataset and return a plain dict (used by CLI and batch_fit).

    戻り値:
      dt, mode, sides{left,right}: {overall: fit, per_level: {level: {tau, delay, r2, n}}},
      suggested: {velocity_run_model_tau_sec, velocity_run_model_delay_ticks, drive_fsm_run_enter_rpm}
    """
    t = data["t"]
    dt = dt if dt else float(np.median(np.diff(t)))
    sides = {}
    for side in ("left", "right"):
        overall, per_level = summarize(data, side, mode, dt, max_delay, min_segment)
        levels = {}
        for lv, fits in per_level.items():
            levels[float(lv)] = dict(
                tau=float(np.nanmean([f["tau"] for f in fits])),
                delay=int(round(np.mean([f["delay"] for f in fits]))),
                r2=float(np.mean([f["r2"] for f in fits])),
                n=len(fits),
            )
        sides[side] = dict(overall=overall, per_level=levels)

    def min_good_level(side):
        ok = [lv for lv, v in sides[side]["per_level"].items() if v["r2"] >= r2_threshold]
        return min(ok) if ok else None

    goods = [x for x in (min_good_level("left"), min_good_level("right")) if x is not None]
    run_enter = int(max(goods)) if len(goods) == 2 else None
    tau_avg = float(np.nanmean([sides[s]["overall"]["tau"] for s in ("left", "right")]))
    delay_avg = int(round(np.mean([sides[s]["overall"]["delay"] for s in ("left", "right")])))
    return dict(dt=dt, mode=mode, sides=sides, n_samples=len(t),
                suggested=dict(velocity_run_model_tau_sec=tau_avg,
                               velocity_run_model_delay_ticks=delay_avg,
                               drive_fsm_run_enter_rpm=run_enter))


def print_report(res):
    """Print the analysis result as a human-readable table."""
    print(f"samples={res['n_samples']}  dt={res['dt']*1000:.1f} ms  mode={res['mode']}")
    for side in ("left", "right"):
        o = res["sides"][side]["overall"]
        print(f"\n[{side}] overall: a={o['a']:.4f} b={o['b']:.4f} c={o['c']:+.3f} "
              f"delay={o['delay']} tick tau={o['tau']*1000:.1f} ms R2={o['r2']:.3f}")
        print(f"  {'level':>7} {'n':>3} {'tau[ms]':>8} {'delay':>5} {'R2':>6}")
        for lv in sorted(res["sides"][side]["per_level"]):
            v = res["sides"][side]["per_level"][lv]
            print(f"  {lv:7.0f} {v['n']:3d} {v['tau']*1000:8.1f} {v['delay']:5d} {v['r2']:6.3f}")


def to_yaml_lines(res):
    """Render the analysis result as YAML lines (no PyYAML dependency)."""
    lines = ["# 生成: scripts/identify/fit_models.py", f"mode: {res['mode']}", f"dt_sec: {res['dt']:.5f}"]
    for side in ("left", "right"):
        o = res["sides"][side]["overall"]
        lines += [f"{side}:", f"  a: {o['a']:.6f}", f"  b: {o['b']:.6f}", f"  c: {o['c']:.4f}",
                  f"  delay_ticks: {o['delay']}", f"  tau_sec: {o['tau']:.5f}", f"  r2: {o['r2']:.4f}",
                  "  per_level:"]
        for lv in sorted(res["sides"][side]["per_level"]):
            v = res["sides"][side]["per_level"][lv]
            lines.append(f"    {int(lv)}: {{tau_sec: {v['tau']:.5f}, delay_ticks: {v['delay']}, "
                         f"r2: {v['r2']:.4f}}}")
    sg = res["suggested"]
    lines.append("suggested:")
    lines.append(f"  velocity_run_model_tau_sec: {sg['velocity_run_model_tau_sec']:.4f}")
    lines.append(f"  velocity_run_model_delay_ticks: {sg['velocity_run_model_delay_ticks']}")
    re_ = sg["drive_fsm_run_enter_rpm"]
    lines.append(f"  drive_fsm_run_enter_rpm: {re_ if re_ is not None else 'null  # R2 基準を満たすレベルなし'}")
    return lines


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
    res = analyze(data, args.mode, args.dt, args.max_delay, args.min_segment, args.r2_threshold)
    print_report(res)
    with open(args.out, "w") as f:
        f.write("\n".join(to_yaml_lines(res)) + "\n")
    print(f"\nwrote {args.out}")
    if res["suggested"]["drive_fsm_run_enter_rpm"] is None:
        print("注意: R² 基準を満たすレベルが無い（一次遅れで当てはまらない）。Phase E は no-go。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
