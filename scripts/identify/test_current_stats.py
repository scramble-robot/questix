#!/usr/bin/env python3
"""current_stats.py の検算（ROS なし）: 区間の切り出しと集計。"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import current_stats as cs  # noqa: E402


def test_segments_skip_zero_and_settle():
    twists = [(0.0, (0.0, 0.0)), (1.0, (0.5, 0.0)), (2.0, (0.5, 0.0)), (5.0, (0.5, 0.0)),
              (5.5, (0.0, 0.0)), (8.0, (0.0, 1.0)), (9.0, (0.0, 1.0))]
    segs = cs.segments(twists, settle=1.0, min_sec=2.0)
    assert segs == [(2.0, 5.0, (0.5, 0.0))]  # 旋回の区間は settle 後 0 秒で短すぎる


def test_stats_measures_current_and_command_steps():
    samples = [(k * 0.02, 60.0 + (k % 2), 0.5 if k % 2 else -0.5, 60.0 + (k % 2) * 2)
               for k in range(20)]
    s = cs.stats(samples)
    assert abs(s["abs_i_mean"] - 0.5) < 1e-9
    assert abs(s["i_rms"] - 0.5) < 1e-9
    assert s["rpm_p2p"] == 1.0
    assert abs(s["cmd_step_rms"] - 2.0) < 1e-9
    assert cs.stats(samples[:5]) is None
