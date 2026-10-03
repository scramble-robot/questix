#!/usr/bin/env python3
"""fit_models.py の検算: 既知の一次遅れ + むだ時間プラントで合成 CSV を作り、τ と d が復元されるか。"""
import math
import os
import subprocess
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from fit_models import fit_first_order  # noqa: E402


def synth(tau=0.12, delay=1, dt=0.02, levels=(50, 100, 200, 400), hold=4.0, settle=3.0, noise=1.0,
          offset=-0.0, seed=0):
    rng = np.random.default_rng(seed)
    a = math.exp(-dt / tau)
    sched = []
    for s in (1, -1):
        for lv in levels:
            sched += [(0, settle), (s * lv, hold)]
    sched.append((0, settle))
    u = np.concatenate([np.full(int(d / dt), v, dtype=float) for v, d in sched])
    x = 0.0
    hist = [0.0] * 5
    om = np.zeros_like(u)
    for k in range(len(u)):
        ud = hist[delay]
        hist = [u[k]] + hist[:-1]
        x = a * x + (1 - a) * ud + offset * (1 - a)
        om[k] = np.round(x + rng.normal(0, noise))
    t = np.arange(len(u)) * dt
    return t, u, om


def main():
    t, u, om = synth()
    fit = fit_first_order(om, u, 0.02, 4, True)
    print("overall fit:", fit)
    assert abs(fit["tau"] - 0.12) < 0.015, fit
    assert fit["delay"] == 1, fit
    assert fit["r2"] > 0.95, fit

    with tempfile.TemporaryDirectory() as d:
        csv = os.path.join(d, "s.csv")
        with open(csv, "w") as f:
            f.write("t,left_target,left_meas,right_target,right_meas\n")
            for k in range(len(t)):
                f.write(f"{t[k]:.3f},{u[k]:.0f},{om[k]:.0f},{-u[k]:.0f},{-om[k]:.0f}\n")
        out = os.path.join(d, "p.yaml")
        r = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "fit_models.py"),
                            "--csv", csv, "--out", out], capture_output=True, text=True)
        print(r.stdout)
        assert r.returncode == 0, r.stderr
        txt = open(out).read()
        print(txt)
        assert "drive_fsm_run_enter_rpm: 50" in txt

        # batch_fit: 2 つの CSV（同条件の繰り返し）+ 1 つ別条件 → summary / sufficiency
        for i, (tau, floor) in enumerate(((0.12, "lifted"), (0.125, "lifted"), (0.16, "tile"))):
            t2, u2, om2 = synth(tau=tau, seed=i)
            c = os.path.join(d, f"ds{i}.csv")
            with open(c, "w") as f:
                f.write("t,left_target,left_meas,right_target,right_meas\n")
                for k in range(len(t2)):
                    f.write(f"{t2[k]:.3f},{u2[k]:.0f},{om2[k]:.0f},{-u2[k]:.0f},{-om2[k]:.0f}\n")
            with open(os.path.join(d, f"ds{i}.meta.yaml"), "w") as f:
                f.write(f'robot_id: "r1"\nfloor: "{floor}"\npayload_kg: 0\n')
        outdir = os.path.join(d, "res")
        r = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "batch_fit.py"),
                            os.path.join(d, "ds0.csv"), os.path.join(d, "ds1.csv"), os.path.join(d, "ds2.csv"),
                            "--out", outdir], capture_output=True, text=True)
        print(r.stdout, r.stderr)
        assert r.returncode == 0, r.stderr
        suff = open(os.path.join(outdir, "sufficiency.md")).read()
        print(suff)
        assert "| r1 | lifted | 0 | 2 |" in suff and "| OK |" in suff
        assert "| r1 | tile | 0 | 1 |" in suff and "繰り返し<2" in suff
        for fn in ("summary.md", "summary.csv", "summary.png"):
            assert os.path.exists(os.path.join(outdir, fn)), fn

        # record.sh がステップ列の中断を残したデータセット（他の送り手の割り込みなど）は除外する
        from batch_fit import discover
        with open(os.path.join(d, "ds0.meta.yaml"), "a") as f:
            f.write('step_sequence: "aborted_foreign_publisher"\n')
        with open(os.path.join(d, "ds1.meta.yaml"), "a") as f:
            f.write('step_sequence: "completed"\n')
        names = [e[0] for e in discover([os.path.join(d, f"ds{i}.csv") for i in range(3)])]
        assert names == ["ds1", "ds2"], names  # ds2 は旧形式（キー無し）なので対象
    check_free_run_rejects_oscillation()
    print("OK")


def check_free_run_rejects_oscillation():
    """一次遅れで表せない低速振動は、1 tick 先予測では R² が高くても自由応答で不合格になる。"""
    dt = 0.02
    t = np.arange(0, 4, dt)
    u = np.full_like(t, 95.0)
    u[:10] = 0.0
    x = np.zeros_like(t)
    for k in range(1, len(t)):
        x[k] = x[k - 1] + dt / (0.08 + dt) * (u[k - 1] - x[k - 1])
    # 実機ログ相当: 目標 95 rpm 一定で実測が 59〜118 rpm を 1.8 Hz で往復
    om = np.round(x + np.where(t > 0.3, 25.0 * np.sin(2.0 * math.pi * 1.8 * t), 0.0))
    fit = fit_first_order(om, u, dt)
    print("oscillation fit:", fit)
    assert fit["r2_onestep"] > 0.9, fit  # 旧指標は素通りしてしまう
    assert fit["r2"] < 0.9, fit          # 自由応答では当てはまらないと判定する


if __name__ == "__main__":
    main()
