#!/usr/bin/env python3
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""Batch identification over many recorded datasets (design/model_based_drive_control.md Phase A).

record.sh が作る ``ident_<robot>_<floor>_<date>/{meta.yaml, bag/}`` を複数まとめて同定し、
  - summary.csv / summary.md : 個体 × 床 × 電圧ごとの τ, むだ時間, R², RUN 境界の一覧
  - summary.png              : レベル別 τ と R² の 1 枚図（床で色分け）
  - sufficiency.md           : 「十分か」の判定（同条件の繰り返しで τ ±20 %、RUN 域 R² >= 0.9）
を出力する。

使い方:
  python3 batch_fit.py ~/ident_data/ident_*            # ディレクトリ（bag/ + meta.yaml）
  python3 batch_fit.py data/*.csv                      # CSV（同名 .meta.yaml があれば読む）
  python3 batch_fit.py ... --out results/              # 出力先
"""
from __future__ import annotations

import argparse
import csv
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fit_models import analyze, load_bag, load_csv  # noqa: E402


# ----------------------------------------------------------------------------- 入力
def read_meta(path):
    """Read a flat ``key: value`` YAML written by record.sh (no PyYAML dependency)."""
    meta = {}
    if not os.path.exists(path):
        return meta
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or ":" not in line:
                continue
            k, v = line.split(":", 1)
            v = v.strip().strip('"')
            meta[k.strip()] = v
    return meta


def discover(items):
    """Resolve CLI items into [(name, kind, data_path, meta)] with kind in {bag, csv}."""
    out = []
    for it in items:
        it = it.rstrip("/")
        if os.path.isdir(it):
            if os.path.exists(os.path.join(it, "metadata.yaml")):  # 生の rosbag2 ディレクトリ
                meta = read_meta(os.path.join(os.path.dirname(it), "meta.yaml"))
                out.append((os.path.basename(os.path.dirname(it)) or os.path.basename(it), "bag", it, meta))
            elif os.path.isdir(os.path.join(it, "bag")):
                out.append((os.path.basename(it), "bag", os.path.join(it, "bag"),
                            read_meta(os.path.join(it, "meta.yaml"))))
            else:
                print(f"skip (no bag): {it}", file=sys.stderr)
        elif it.endswith(".csv"):
            out.append((os.path.splitext(os.path.basename(it))[0], "csv", it,
                        read_meta(os.path.splitext(it)[0] + ".meta.yaml")))
        else:
            print(f"skip (unknown): {it}", file=sys.stderr)
    return out


# ----------------------------------------------------------------------------- 集計
def condition_key(meta):
    """Group key for repeat detection: robot × floor × payload."""
    return (meta.get("robot_id", "?"), meta.get("floor", "?"), meta.get("payload_kg", "?"))


def sufficiency(rows, tau_tol=0.2, r2_threshold=0.9):
    """Judge per condition whether data are sufficient (repeat spread, R2 at RUN levels)."""
    groups = {}
    for r in rows:
        groups.setdefault(r["cond"], []).append(r)
    lines = ["# 十分性判定", "",
             f"基準: 同条件の繰り返し >= 2、τ のばらつき（max/min-1）<= {tau_tol:.0%}、"
             f"RUN 境界以上のレベルで R² >= {r2_threshold}", ""]
    lines.append("| robot | floor | payload | n | τ [ms] (min..max) | spread | run_enter | 判定 |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for cond, rs in sorted(groups.items()):
        taus = [r["tau_ms"] for r in rs if np.isfinite(r["tau_ms"])]
        spread = (max(taus) / min(taus) - 1.0) if len(taus) >= 2 and min(taus) > 0 else float("nan")
        enters = [r["run_enter"] for r in rs if r["run_enter"] is not None]
        ok_n = len(rs) >= 2
        ok_tau = np.isfinite(spread) and spread <= tau_tol
        ok_run = len(enters) == len(rs) and len(rs) > 0
        problems = [x for x, bad in (("繰り返し<2", not ok_n), ("τばらつき", ok_n and not ok_tau),
                                     ("R²基準未達", not ok_run)) if bad]
        verdict = "OK" if not problems else "不足: " + ", ".join(problems)
        lines.append(f"| {cond[0]} | {cond[1]} | {cond[2]} | {len(rs)} | "
                     f"{min(taus) if taus else float('nan'):.0f}..{max(taus) if taus else float('nan'):.0f} | "
                     f"{spread:.0%} | {max(enters) if enters else '-'} | {verdict} |")
    return "\n".join(lines) + "\n"


def make_figure(results, out_png, r2_threshold):
    """Draw τ and R² vs |level| for all datasets, colored by floor."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib が無いので図はスキップ", file=sys.stderr)
        return
    try:
        matplotlib.rcParams["font.family"] = ["Noto Sans CJK JP", "DejaVu Sans"]
    except Exception:  # noqa: BLE001
        pass
    floors = sorted({m.get("floor", "?") for _, m, _ in results})
    cmap = plt.get_cmap("tab10")
    color = {f: cmap(i % 10) for i, f in enumerate(floors)}
    fig, axs = plt.subplots(1, 2, figsize=(12, 4.6))
    for name, meta, res in results:
        fl = meta.get("floor", "?")
        for side, ls in (("left", "-"), ("right", "--")):
            pl = res["sides"][side]["per_level"]
            if not pl:
                continue
            lv = sorted(pl)
            axs[0].plot(lv, [pl[x]["tau"] * 1000 for x in lv], ls, marker="o", ms=3, color=color[fl],
                        alpha=0.8, label=f"{fl} ({name}, {side})" if side == "left" else None)
            axs[1].plot(lv, [pl[x]["r2"] for x in lv], ls, marker="o", ms=3, color=color[fl], alpha=0.8)
    axs[0].set_xlabel("|目標 RPM|"); axs[0].set_ylabel("τ [ms]"); axs[0].grid(alpha=0.3)
    axs[0].set_title("レベル別 時定数 τ（実線: 左, 破線: 右）")
    axs[1].axhline(r2_threshold, color="gray", ls=":", label=f"R² 基準 {r2_threshold}")
    axs[1].set_xlabel("|目標 RPM|"); axs[1].set_ylabel("R²"); axs[1].set_ylim(0, 1.02); axs[1].grid(alpha=0.3)
    axs[1].set_title("レベル別 一次遅れの当てはまり R²")
    handles, labels = axs[0].get_legend_handles_labels()
    if handles:
        axs[0].legend(fontsize=7, loc="best")
    axs[1].legend(fontsize=8)
    fig.suptitle(f"同定結果 {len(results)} データセット（床で色分け）")
    fig.tight_layout()
    fig.savefig(out_png, dpi=130)
    plt.close(fig)


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("items", nargs="+", help="record.sh の出力ディレクトリ / rosbag2 ディレクトリ / CSV")
    ap.add_argument("--out", default="ident_results")
    ap.add_argument("--mode", choices=["velocity", "current"], default="velocity")
    ap.add_argument("--max-delay", type=int, default=4)
    ap.add_argument("--min-segment", type=int, default=25)
    ap.add_argument("--r2-threshold", type=float, default=0.9)
    ap.add_argument("--tau-tolerance", type=float, default=0.2)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    datasets = discover(args.items)
    if not datasets:
        print("入力がありません", file=sys.stderr)
        return 1

    results = []
    rows = []
    for name, kind, path, meta in datasets:
        try:
            data = load_bag(path) if kind == "bag" else load_csv(path)
            res = analyze(data, args.mode, None, args.max_delay, args.min_segment, args.r2_threshold)
        except SystemExit as e:  # load/analyze が SystemExit を投げる
            print(f"skip {name}: {e}", file=sys.stderr)
            continue
        results.append((name, meta, res))
        sg = res["suggested"]
        row = dict(name=name, robot_id=meta.get("robot_id", "?"), floor=meta.get("floor", "?"),
                   payload_kg=meta.get("payload_kg", "?"), battery_voltage=meta.get("battery_voltage", ""),
                   firmware=meta.get("firmware", ""), date=meta.get("date", ""),
                   tau_ms=sg["velocity_run_model_tau_sec"] * 1000.0,
                   delay_ticks=sg["velocity_run_model_delay_ticks"],
                   r2_left=res["sides"]["left"]["overall"]["r2"],
                   r2_right=res["sides"]["right"]["overall"]["r2"],
                   run_enter=sg["drive_fsm_run_enter_rpm"], cond=condition_key(meta))
        rows.append(row)
        print(f"{name:40s} tau={row['tau_ms']:6.1f} ms delay={row['delay_ticks']} "
              f"R2(L/R)={row['r2_left']:.3f}/{row['r2_right']:.3f} run_enter={row['run_enter']}")

    if not rows:
        return 1

    # CSV
    fields = ["name", "robot_id", "floor", "payload_kg", "battery_voltage", "firmware", "date", "tau_ms",
              "delay_ticks", "r2_left", "r2_right", "run_enter"]
    with open(os.path.join(args.out, "summary.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in rows:
            w.writerow({k: r[k] for k in fields})

    # Markdown
    md = ["# 同定結果一覧", "", "| name | robot | floor | payload | V | τ [ms] | delay | R² L/R | run_enter |",
          "|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        md.append(f"| {r['name']} | {r['robot_id']} | {r['floor']} | {r['payload_kg']} | {r['battery_voltage']} | "
                  f"{r['tau_ms']:.0f} | {r['delay_ticks']} | {r['r2_left']:.2f}/{r['r2_right']:.2f} | "
                  f"{r['run_enter'] if r['run_enter'] is not None else '-'} |")
    taus = [r["tau_ms"] for r in rows if np.isfinite(r["tau_ms"])]
    enters = [r["run_enter"] for r in rows if r["run_enter"] is not None]
    md += ["", "## 全体の目安（YAML 転記候補）", "",
           f"- velocity_run_model_tau_sec: {np.median(taus)/1000:.4f}（中央値, n={len(taus)}）",
           f"- velocity_run_model_delay_ticks: {int(round(np.median([r['delay_ticks'] for r in rows])))}",
           f"- drive_fsm_run_enter_rpm: {max(enters) if enters else '未定（R² 基準未達）'}（全条件の最大 = 安全側）", ""]
    with open(os.path.join(args.out, "summary.md"), "w") as f:
        f.write("\n".join(md) + "\n")
    with open(os.path.join(args.out, "sufficiency.md"), "w") as f:
        f.write(sufficiency(rows, args.tau_tolerance, args.r2_threshold))
    make_figure(results, os.path.join(args.out, "summary.png"), args.r2_threshold)
    print(f"\nwrote {args.out}/summary.csv, summary.md, sufficiency.md, summary.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
