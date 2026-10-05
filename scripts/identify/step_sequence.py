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
  レベルごとに保持時間を変える（rpm:秒）:
    python3 step_sequence.py --schedule 3:60,5:60,10:30 --dry-run
  微速: 止まった状態から動き出すには drive_component の停止判定（min_command_rpm + 2 rpm 以上。
  min_command_rpm を 0 にしても 3 rpm 以上）を超える必要がある。--lead-in-rpm より遅いレベルの前に
  同じ向きで --lead-in-rpm を --lead-in-sec 秒送り、0 を通らずにそのレベルへ移る:
    python3 step_sequence.py --schedule 1:150,2:90 --lead-in-rpm 4 --lead-in-sec 1.0 --dry-run
  信地旋回（片輪を止め、もう片輪だけ回す。床の上で負荷をかける試験。レベルは回す輪の RPM）:
    python3 step_sequence.py --schedule 3:60,5:60 --pattern pivot-left --dry-run

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


def build_schedule(levels, hold, sign, cycles, settle, lead_in_rpm=0, lead_in_sec=0.0):
    """[(rpm, duration_sec), ...] を返す。各レベルの前後に 0 を挟む。

    levels は RPM のリスト（全レベル hold 秒）か、(rpm, 保持秒) のリスト。lead_in_rpm と
    lead_in_sec が正なら、|rpm| が lead_in_rpm より小さいレベルの前に同じ向きの lead_in_rpm を
    lead_in_sec 秒入れる（0 を挟まずにレベルへ移る）。
    """
    entries = [lv if isinstance(lv, tuple) else (lv, hold) for lv in levels]
    seq = []
    signs = {"pos": [1], "neg": [-1], "both": [1, -1]}[sign]
    for _ in range(cycles):
        for s in signs:
            for lv, dur in entries:
                seq.append((0, settle))
                if lead_in_rpm > 0 and lead_in_sec > 0 and abs(lv) < lead_in_rpm:
                    seq.append((s * lead_in_rpm, lead_in_sec))
                seq.append((s * lv, dur))
    seq.append((0, settle))
    return seq


def parse_schedule(text):
    """'3:60,5:60,10:30' を [(3, 60.0), (5, 60.0), (10, 30.0)] にする（RPM は正の整数）."""
    entries = []
    for item in text.split(","):
        if not item.strip():
            continue
        rpm_text, sep, sec_text = item.partition(":")
        if not sep:
            raise ValueError(f"--schedule の要素は rpm:秒 の形にしてください: {item!r}")
        rpm, sec = int(rpm_text), float(sec_text)
        if rpm <= 0 or sec <= 0:
            raise ValueError(f"--schedule の rpm と秒は正の値にしてください: {item!r}")
        entries.append((rpm, sec))
    if not entries:
        raise ValueError("--schedule が空です")
    return entries


# drive_component の停止判定（motor_control_lib/drive_stop_gate.hpp）: 止まっている状態から
# 動き出すには max(1, min_command_rpm) + EXIT_MARGIN_RPM 以上、動いている状態は max(1, min_command_rpm)
# 以上で保たれる。下回る車輪 RPM は停止指令になる。
STOP_GATE_EXIT_MARGIN_RPM = 2


def start_gate_problems(schedule, min_command_rpm):
    """スケジュールのうち、停止判定のために指令どおりに回らないステップを文で返す（空なら問題なし）."""
    enter = max(1, int(min_command_rpm))
    problems = []
    previous = 0
    for index, (rpm, _) in enumerate(schedule):
        level = abs(rpm)
        if level == 0:
            previous = 0
            continue
        if level < enter:
            problems.append(f"step {index}: {rpm} rpm は min_command_rpm={min_command_rpm} 未満なので"
                            "停止指令になる")
        elif previous == 0 and level < enter + STOP_GATE_EXIT_MARGIN_RPM:
            problems.append(f"step {index}: 止まった状態から {rpm} rpm では動き出せない"
                            f"（{enter + STOP_GATE_EXIT_MARGIN_RPM} rpm 以上が要る。--lead-in-rpm を使う"
                            "か min_command_rpm を下げる）")
        previous = rpm
    return problems


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


PATTERNS = ("straight", "spin", "pivot-left", "pivot-right")


def pattern_of(args):
    pattern = getattr(args, "pattern", None)
    if pattern:
        return pattern
    return "spin" if getattr(args, "turn", False) else "straight"


def twist_values(rpm, args):
    """車輪 RPM から (linear_x, angular_z) を返す（REP-103: 左回りが正）.

    straight: 左右同速の直進。spin: 左右逆回転（超信地旋回）。pivot-left / pivot-right:
    左 / 右の車輪を止め、もう片方の車輪だけを rpm で回す（信地旋回。rpm が正なら回す輪が前進）。
    """
    pattern = pattern_of(args)
    if pattern == "spin":
        return 0.0, rpm_to_angular(rpm, args.wheel_radius, args.wheel_separation)
    if pattern in ("pivot-left", "pivot-right"):
        wheel = rpm_to_linear(rpm, args.wheel_radius)
        # 差動二輪: v_left = v - w*sep/2, v_right = v + w*sep/2。片輪を 0 にする組み合わせ。
        angular = wheel / args.wheel_separation
        return wheel / 2.0, angular if pattern == "pivot-left" else -angular
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
    ap.add_argument("--schedule", default="",
                    help="レベルごとの保持時間 rpm:秒（カンマ区切り）。指定すると --levels/--hold より優先")
    ap.add_argument("--lead-in-rpm", type=int, default=0,
                    help="これより遅いレベルの前に同じ向きでこの RPM を送る（0 で無効）")
    ap.add_argument("--lead-in-sec", type=float, default=0.0, help="助走の時間 [s]")
    ap.add_argument("--settle", type=float, default=3.0, help="レベル間の 0 保持時間 [s]")
    ap.add_argument("--sign", choices=["pos", "neg", "both"], default="both")
    ap.add_argument("--cycles", type=int, default=1)
    ap.add_argument("--rate", type=float, default=50.0, help="publish レート [Hz]")
    ap.add_argument("--topic", default="/target_twist")
    ap.add_argument("--wheel-radius", type=float, default=0.1)
    ap.add_argument("--wheel-separation", type=float, default=0.5)
    ap.add_argument("--turn", action="store_true", help="直進ではなく旋回（angular_z）で与える"
                    "（--pattern spin と同じ）")
    ap.add_argument("--pattern", choices=PATTERNS, default=None,
                    help="straight（既定）/ spin（左右逆回転）/ pivot-left・pivot-right（左・右の車輪を"
                    "止めて片輪だけ回す信地旋回）")
    ap.add_argument("--listen-before", type=float, default=2.0,
                    help="開始前に topic を聞く時間 [s]。この間に何か流れていれば開始しない")
    ap.add_argument("--dry-run", action="store_true", help="スケジュールを表示して終了")
    ap.add_argument("--min-command-rpm", type=int, default=None,
                    help="drive_component の min_command_rpm。渡すと、停止判定のために指令どおりに"
                    "回らないステップがあれば開始しない（record.sh が実効値を渡す）")
    args = ap.parse_args()

    if args.pattern and args.turn and args.pattern != "spin":
        print("--turn と --pattern は同時に指定できません", file=sys.stderr)
        return 2
    try:
        levels = (parse_schedule(args.schedule) if args.schedule
                  else [int(x) for x in args.levels.split(",") if x.strip()])
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2
    schedule = build_schedule(levels, args.hold, args.sign, args.cycles, args.settle,
                              args.lead_in_rpm, args.lead_in_sec)
    total = sum(d for _, d in schedule)
    print(f"schedule: {len(schedule)} steps, total {total:.1f} s, pattern {pattern_of(args)}, "
          f"wheel_radius {args.wheel_radius} m, wheel_separation {args.wheel_separation} m")
    for rpm, dur in schedule:
        lx, az = twist_values(rpm, args)
        print(f"  {rpm:5d} rpm -> linear_x {lx:+.4f} m/s, angular_z {az:+.4f} rad/s  for {dur:.1f} s")
    if args.min_command_rpm is not None:
        problems = start_gate_problems(schedule, args.min_command_rpm)
        if problems:
            print("停止判定のため指令どおりに回らないステップがあります（開始しません）:",
                  file=sys.stderr)
            for line in problems:
                print(f"  {line}", file=sys.stderr)
            return 2
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
