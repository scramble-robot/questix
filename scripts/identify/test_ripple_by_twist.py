#!/usr/bin/env python3
"""ripple_by_twist.py の検算（ROS・numpy・実機なし）: 目標 RPM と区切りの受け渡し。"""
import math
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(__file__))
import ripple_by_twist as rbt  # noqa: E402


def test_reference_matches_differential_kinematics_signs():
    # 前進: 左は正、右は負（右輪は取り付けが逆）。0.05 m の車輪で 0.5 m/s ≒ 95.5 rpm
    left, right = rbt.wheel_reference_rpm(0.5, 0.0, 0.05, 0.5)
    assert math.isclose(left, 95.49, abs_tol=0.01)
    assert math.isclose(right, -95.49, abs_tol=0.01)
    # その場旋回（左回り）: 両輪ともワイヤ上は負
    left, right = rbt.wheel_reference_rpm(0.0, 1.0, 0.05, 0.5)
    assert left < 0 and right < 0


def test_reference_series_holds_the_latest_twist():
    times = [0.0, 0.5, 1.0, 1.5, 2.0]
    series = rbt.reference_series(times, [0.4, 1.2], [(0.5, 0.0), (0.0, 0.0)], 0.05, 0.5, "left")
    assert series == [0.0, 95.0, 95.0, 0.0, 0.0]


class _FakeReader:
    def __init__(self, messages):
        self._messages = list(messages)

    def has_next(self):
        return bool(self._messages)

    def read_next(self):
        return self._messages.pop(0)


def test_main_replaces_the_sent_command_with_the_reference(tmp_path, capsys):
    twist = SimpleNamespace(linear=SimpleNamespace(x=0.5), angular=SimpleNamespace(z=0.0))
    seen = {}

    def analyze(data, *args):
        seen["left"] = list(data["wheels"]["left"]["command"])
        return {}

    ripple = SimpleNamespace(
        SIDES=("left", "right"),
        np=SimpleNamespace(asarray=lambda values, dtype=float: list(values)),
        ENCODER_ERROR_PCT=1.0,
        TRACK_ORDERS=(20,),
        # 補正で毎 tick 変わる「送った指令」（target_rpm）
        load_bag=lambda path: {"wheels": {
            "left": {"t": [1.0, 1.02, 1.04], "command": [97.0, 93.0, 96.0]},
            "right": {"t": [1.0, 1.02, 1.04], "command": [-94.0, -97.0, -95.0]}}},
        _open_bag=lambda path: (_FakeReader([("/target_twist", b"", 500_000_000)]),
                                {"/target_twist": "geometry_msgs/msg/Twist"},
                                lambda raw, msg_type: twist, lambda name: object),
        analyze=analyze,
        report=lambda result: "report",
    )
    rbt.load_ripple = lambda path: ripple
    fake = tmp_path / "ripple_analysis.py"
    fake.write_text("")
    assert rbt.main(["--ripple", str(fake), "--bag", str(tmp_path / "bag")]) == 0
    assert seen["left"] == [95.0, 95.0, 95.0]
    assert "report" in capsys.readouterr().out
