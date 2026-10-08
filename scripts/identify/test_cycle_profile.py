#!/usr/bin/env python3
"""cycle_profile.py と mcap_lite.py の検算（ROS なし）。"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(__file__))
import cycle_profile as cp  # noqa: E402
import mcap_lite  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(__file__), "..", "robot_manager", "static", "lab", "test",
                       "fixtures", "drive-approach.mcap")


def _stick_slip(target, freq=1.75, sign=1, seed=3, dur=5.0):
    """引っかかって 0 に張り付く、毎周期同じ形の揺れ（電流は速度より 1/4 周期先行）。"""
    rng = random.Random(seed)
    out = []
    phase = 0.0
    for k in range(int(dur / 0.02)):
        phase += 2 * math.pi * freq * 0.02
        speed = max(0.0, target + target * math.sin(phase)) + rng.gauss(0, 0.5)
        current = 1.4 + 1.8 * math.cos(phase)
        out.append((k * 0.02, sign * round(speed), sign * current, sign * target))
    return out


def test_profile_of_a_regular_stick_slip():
    res = cp.profile(_stick_slip(15), 15)
    assert len(res["cycles"]) >= 6
    assert abs(res["freq"] - 1.75) < 0.05
    assert res["period_cv"] < 0.05
    assert res["template_r2"] > 0.9
    assert res["predict_r2"] > 0.9
    assert res["stall_ms"] > 0.0
    # 電流が 1/4 周期（約 143 ms）先行
    assert abs(res["current_to_speed_ms"] - 143) < 20
    assert cp.verdict(res)[0].startswith("予測しやすい")


def test_reverse_direction_is_folded_forward():
    fwd = cp.profile(_stick_slip(15), 15)
    rev = cp.profile(_stick_slip(15, sign=-1), -15)
    assert abs(fwd["freq"] - rev["freq"]) < 1e-9
    assert abs(fwd["min_mean"] - rev["min_mean"]) < 1e-9
    assert rev["mean"] > 0.0  # 進行方向を正にそろえる


def test_irregular_and_short_segments():
    rng = random.Random(7)
    noise = [(k * 0.02, 60 + round(rng.gauss(0, 8)), 1.0, 60) for k in range(250)]
    assert cp.verdict(cp.profile(noise, 60))[0] in ("不規則", "ややそろう")
    short = _stick_slip(15, dur=1.0)
    res = cp.profile(short, 15)
    assert res["cycles"] == []
    assert cp.verdict(res)[0] == "周期なし"


def test_upward_crossings_ignore_noise_inside_the_band():
    times = [k * 0.1 for k in range(9)]
    values = [-5, -1, 1, -1, 1, 5, -5, 0.5, 5]
    assert len(cp.upward_crossings(times, values, 0.0, 2.0)) == 2


def test_render_html_has_a_chart_per_profiled_panel():
    res = cp.profile(_stick_slip(15), 15)
    page = cp.render_html([("bag", {"velocity_damping_gain_sec": 0.0},
                            [("旋回 +15 rpm", "left", res),
                             ("旋回 +40 rpm", "right", cp.profile([], 40))])])
    assert page.count('<svg class="chart"') == 2  # 速度 + 電流（周期なしの区間は図なし）
    assert "周期なし" in page


def test_mcap_lite_reads_the_lab_fixture():
    topics = mcap_lite.read_topics(FIXTURE, ("/drive_status", "/target_twist"))
    assert len(topics["/drive_status"]) == 80
    status = topics["/drive_status"][0][1]
    assert set(status["left"]) >= {"velocity_rpm_raw", "current_amp", "target_rpm", "header"}
    twist = topics["/target_twist"][0][1]
    assert set(twist) == {"linear", "angular"}
