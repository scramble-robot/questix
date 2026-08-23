#!/usr/bin/env python3
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""
同定用ステップ列を /target_twist に publish する（design/model_based_drive_control.md Phase A）。

車輪を浮かせた状態で使うこと。drive_component の control_mode は velocity（ファーム速度ループの
同定）または current（既存 PI 経由の参考データ）。ステップは「車輪 RPM」で指定し、
wheel_radius から車体前進速度 [m/s] に換算して publish する（左右同速、直進）。

例:
  ros2 run ... ではなく直接:
    python3 step_sequence.py --levels 50,100,200,400 --hold 4.0 --sign both --dry-run
    python3 step_sequence.py --levels 50,100,200,400 --hold 4.0 --sign both
  旋回で取る（左右逆回転。車輪 RPM は angular_z*wheel_separation/2 相当）:
    python3 step_sequence.py --levels 30,60,120 --hold 4.0 --turn --wheel-separation 0.5

同時に rosbag を取る:
    ros2 bag record /drive_status /target_twist -o ident_velocity_YYYYMMDD

安全: 非常停止が効くことを確認してから実行する。Ctrl-C で即座に 0 を publish して終了する。
"""
from __future__ import annotations

import argparse
import math
import sys
import time


def build_schedule(levels, hold, sign, cycles, settle):
    """[(rpm, duration_sec), ...] を返す。各レベルの前後に 0 を挟む。"""
    seq = []
    signs = {"pos": [1], "neg": [-1], "both": [1, -1]}[sign]
    for _ in range(cycles):
        for s in signs:
            for lv in levels:
                seq.append((0, settle))
                seq.append((s * lv, hold))
    seq.append((0, settle))
    return seq


def rpm_to_linear(rpm, wheel_radius):
    return rpm / 60.0 * 2.0 * math.pi * wheel_radius


def rpm_to_angular(rpm, wheel_radius, wheel_separation):
    # 左右逆回転で車輪 |rpm| を出す角速度: v_wheel = angular * separation / 2
    return rpm_to_linear(rpm, wheel_radius) * 2.0 / wheel_separation


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--levels", default="50,100,200,400", help="車輪 RPM のレベル（カンマ区切り）")
    ap.add_argument("--hold", type=float, default=4.0, help="各レベルの保持時間 [s]")
    ap.add_argument("--settle", type=float, default=3.0, help="レベル間の 0 保持時間 [s]")
    ap.add_argument("--sign", choices=["pos", "neg", "both"], default="both")
    ap.add_argument("--cycles", type=int, default=1)
    ap.add_argument("--rate", type=float, default=50.0, help="publish レート [Hz]")
    ap.add_argument("--topic", default="/target_twist")
    ap.add_argument("--wheel-radius", type=float, default=0.1)
    ap.add_argument("--wheel-separation", type=float, default=0.5)
    ap.add_argument("--turn", action="store_true", help="直進ではなく旋回（angular_z）で与える")
    ap.add_argument("--dry-run", action="store_true", help="スケジュールを表示して終了")
    args = ap.parse_args()

    levels = [int(x) for x in args.levels.split(",") if x.strip()]
    schedule = build_schedule(levels, args.hold, args.sign, args.cycles, args.settle)
    total = sum(d for _, d in schedule)
    print(f"schedule: {len(schedule)} steps, total {total:.1f} s")
    for rpm, dur in schedule:
        if args.turn:
            val = rpm_to_angular(rpm, args.wheel_radius, args.wheel_separation)
            print(f"  {rpm:5d} rpm -> angular_z {val:+.3f} rad/s  for {dur:.1f} s")
        else:
            val = rpm_to_linear(rpm, args.wheel_radius)
            print(f"  {rpm:5d} rpm -> linear_x  {val:+.3f} m/s    for {dur:.1f} s")
    if args.dry_run:
        return 0

    try:
        import rclpy
        from geometry_msgs.msg import Twist
    except ImportError:
        print("rclpy / geometry_msgs が見つかりません。ROS 2 環境を source してください", file=sys.stderr)
        return 1

    rclpy.init()
    node = rclpy.create_node("identify_step_sequence")
    pub = node.create_publisher(Twist, args.topic, 10)
    period = 1.0 / args.rate

    def publish(rpm):
        msg = Twist()
        if args.turn:
            msg.angular.z = rpm_to_angular(rpm, args.wheel_radius, args.wheel_separation)
        else:
            msg.linear.x = rpm_to_linear(rpm, args.wheel_radius)
        pub.publish(msg)

    try:
        for rpm, dur in schedule:
            node.get_logger().info(f"step: {rpm} rpm for {dur:.1f} s")
            t_end = time.monotonic() + dur
            while time.monotonic() < t_end:
                publish(rpm)
                time.sleep(period)
    except KeyboardInterrupt:
        node.get_logger().warn("interrupted: publishing zero")
    finally:
        for _ in range(int(args.rate)):
            publish(0)
            time.sleep(period)
        node.destroy_node()
        rclpy.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
