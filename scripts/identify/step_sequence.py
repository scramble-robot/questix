#!/usr/bin/env python3
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""同定用ステップ列を /target_twist に publish する（design/model_based_drive_control.md Phase A）。

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

他の送り手との競合: /target_twist には通常 twist_arbiter（練習）や joy_controller（競技）も
publish する（コントローラ接続中は /joy のたびに流れる）。混ざると同定データが汚れ、スティック
優先の仕組みも素通りするため、開始前に --listen-before 秒聞いて何か流れていれば開始しない。
実行中も、自分が送っていない値を受け取ったら（スティック操作など）中断して 0 を送り終了する。
コントローラを外す（または joy を止める）か、/target_twist に他から流れない起動で使うこと。
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


# 他の publisher を検出したときの終了コード（record.sh が区別して表示する）
EXIT_FOREIGN_PUBLISHER = 3
# Ctrl-C で中断したときの終了コード（シェルの慣例 128 + SIGINT。record.sh が中断として残す）
EXIT_INTERRUPTED = 130


class ForeignTwistDetector:
    """自分が送っていない Twist（他の publisher からの指令）を見分ける。

    自分の publish も同じ topic の購読に返ってくるため、いま送っている値と一致するものは
    自分のものとみなす。値を切り替えた直後の grace_sec 秒だけは、遅れて届く 1 つ前の値も
    自分のものとみなす（それ以降に 1 つ前の値が届けば他者。ステップ中に割り込む中立の 0 が
    典型）。中立（0）を送っている区間の他者の 0 は見分けられないが、その間は車輪も
    止まっているのでデータにも安全にも影響しない。
    """

    def __init__(self, grace_sec=0.2, tol=1e-9):
        self._grace = grace_sec
        self._tol = tol
        self._current = None
        self._previous = None
        self._switched_at = None

    def expect(self, linear_x, angular_z, now):
        """これから publish する値を登録する。now は単調時刻 [s]。"""
        value = (float(linear_x), float(angular_z))
        if value != self._current:
            self._previous = self._current
            self._current = value
            self._switched_at = now

    def _matches(self, value, linear_x, angular_z):
        return (value is not None
                and math.isclose(linear_x, value[0], abs_tol=self._tol)
                and math.isclose(angular_z, value[1], abs_tol=self._tol))

    def is_foreign(self, linear_x, angular_z, now, other_axes_zero=True):
        """受け取った値が自分の送った値でなければ True。now は単調時刻 [s]。"""
        if not other_axes_zero:
            return True
        if self._matches(self._current, linear_x, angular_z):
            return False
        in_grace = self._switched_at is not None and now - self._switched_at <= self._grace
        return not (in_grace and self._matches(self._previous, linear_x, angular_z))


def twist_values(rpm, args):
    """車輪 RPM から (linear_x, angular_z) を返す。"""
    if args.turn:
        return 0.0, rpm_to_angular(rpm, args.wheel_radius, args.wheel_separation)
    return rpm_to_linear(rpm, args.wheel_radius), 0.0


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
    ap.add_argument("--listen-before", type=float, default=2.0,
                    help="開始前に topic を聞く時間 [s]。この間に何か流れていれば開始しない")
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
    detector = ForeignTwistDetector()
    state = {"listening": True, "foreign": None}

    def on_twist(msg):
        other_zero = (msg.linear.y == 0.0 and msg.linear.z == 0.0
                      and msg.angular.x == 0.0 and msg.angular.y == 0.0)
        if state["foreign"] is not None:
            return
        if state["listening"] or detector.is_foreign(msg.linear.x, msg.angular.z, time.monotonic(),
                                                     other_zero):
            state["foreign"] = (msg.linear.x, msg.angular.z)

    node.create_subscription(Twist, args.topic, on_twist, 10)

    def spin_until(deadline):
        while state["foreign"] is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0.0:
                return
            rclpy.spin_once(node, timeout_sec=remaining)

    def publish(rpm):
        lx, az = twist_values(rpm, args)
        detector.expect(lx, az, time.monotonic())
        msg = Twist()
        msg.linear.x = lx
        msg.angular.z = az
        pub.publish(msg)

    def foreign_message(when):
        lx, az = state["foreign"]
        return (f"{when} {args.topic} に他の送り手からの指令を受信しました "
                f"(linear_x={lx:+.3f}, angular_z={az:+.3f})。コントローラを外すか joy を止め、"
                f"{args.topic} に他から流れない状態で実行してください "
                f"(`ros2 topic info -v {args.topic}` で publisher を確認できます)")

    # 開始前: 何も publish せずに聞く。ここで流れていれば一切動かさずに終わる。
    spin_until(time.monotonic() + max(0.0, args.listen_before))
    if state["foreign"] is not None:
        node.get_logger().error(foreign_message("開始前に"))
        node.destroy_node()
        rclpy.shutdown()
        return EXIT_FOREIGN_PUBLISHER
    state["listening"] = False

    rc = 0
    try:
        for rpm, dur in schedule:
            node.get_logger().info(f"step: {rpm} rpm for {dur:.1f} s")
            t_end = time.monotonic() + dur
            while time.monotonic() < t_end and state["foreign"] is None:
                publish(rpm)
                spin_until(min(t_end, time.monotonic() + period))
            if state["foreign"] is not None:
                node.get_logger().error(foreign_message("実行中に") + "。中断します")
                rc = EXIT_FOREIGN_PUBLISHER
                break
    except KeyboardInterrupt:
        node.get_logger().warn("interrupted: publishing zero")
        rc = EXIT_INTERRUPTED
    finally:
        # 最後に送った非 0 が drive_component に残らないよう 0 を送る。他の送り手（スティック）が
        # 動かしているときは長く送り続けて操作と競合しないよう、数回だけにする。
        zeros = 3 if rc == EXIT_FOREIGN_PUBLISHER else int(args.rate)
        for _ in range(zeros):
            publish(0)
            time.sleep(period)
        node.destroy_node()
        rclpy.shutdown()
    return rc


if __name__ == "__main__":
    sys.exit(main())
