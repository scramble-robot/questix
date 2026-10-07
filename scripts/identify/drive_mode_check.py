#!/usr/bin/env python3
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""DDT モータが実際にどの制御モードで動いているかを /drive_status から確かめる.

check_drive_mode.sh から呼ばれる（単体でも動く）。モータを動かす指令は何も送らず、
/drive_status を聞くだけ。

確かめること:
  1. 各輪の応答フレームの mode（DATA[1]。1 = 電流ループ、2 = 速度ループ）が
     drive_component の control_mode と一致するか。
  2. --estop-cycle のとき、非常停止の押下・解除の後も mode が変わらないか
     （非常停止で DDT の電源が切れる機体では、電源投入時のモードに戻り得る。
     drive_component は解除のときにモード切替フレームを送り直さない）。
  3. 参考: drive_component が送っているモード切替フレームと、コメントに引用された仕様の
     レイアウト（DATA[9] = モード値、CRC なし）のバイト列を並べて表示する。

終了コード: 0 = 一致、1 = 不一致（または解除の後に mode が変わった）、2 = 判定できない
（新しいフィードバックが無い）。
"""
from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass, field
import sys
import time

SIDES = ("left", "right")
MODE_CURRENT_LOOP = 1  # questix_msgs/MotorFeedback MODE_CURRENT_LOOP
MODE_VELOCITY_LOOP = 2  # questix_msgs/MotorFeedback MODE_VELOCITY_LOOP
MODE_NAMES = {MODE_CURRENT_LOOP: "電流ループ", MODE_VELOCITY_LOOP: "速度ループ"}
# drive_component は未知の control_mode を velocity として扱う（initializeMotorLib）。
EXPECTED_MODE = {"velocity": MODE_VELOCITY_LOOP, "current": MODE_CURRENT_LOOP}
# アイドル中のフィードバック再取得は最大 0.2 s ごと + 停止フレームの再送間隔 0.3 s。
# これより古い受信時刻のフレームは「いまの状態」として数えない。
STALE_MARGIN_SEC = 0.5
# 各輪の受信時刻は drive_component が publish のたびに「now − フィードバックの経過時間」で計算し
# 直す（motor_status_msg.hpp）ので、同じフレームでも数 µs ずれる。応答は制御 tick（50 Hz）より
# 速くは来ないので、これより近い受信時刻は同じフレームとみなす。
SAME_FRAME_TOLERANCE_NS = 5_000_000

OK = "ok"
MISMATCH = "mismatch"
NO_FEEDBACK = "no_feedback"


def expected_mode(control_mode: str) -> int:
    """control_mode から、応答フレームに出るはずの mode 値を返す。"""
    return EXPECTED_MODE.get(control_mode, MODE_VELOCITY_LOOP)


def mode_name(value: int) -> str:
    """mode 値の表示名。"""
    return MODE_NAMES.get(value, f"不明な値 {value}（仕様書で確認）")


def crc8_maxim(data) -> int:
    """CRC8/MAXIM（ddt_protocol::crc8Maxim と同じ）。"""
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0x8C if crc & 1 else crc >> 1
    return crc


def mode_frames(motor_id: int, mode_value: int):
    """(drive_component が送るフレーム, コメントに引用された仕様のフレーム) を返す。

    drive_component（ddt_protocol::packModeFrame）: DATA[8] = モード値、DATA[9] = CRC8。
    仕様（同関数のコメントの引用）: DATA[9] = モード値、CRC なし。
    """
    head = [motor_id & 0xFF, 0xA0, 0, 0, 0, 0, 0, 0]
    sent = head + [mode_value]
    sent.append(crc8_maxim(sent))
    spec = head + [0, mode_value]
    return sent, spec


def hex_frame(frame) -> str:
    """バイト列を 16 進で並べる。"""
    return " ".join(f"{b:02X}" for b in frame)


@dataclass
class WheelSummary:
    """1 輪ぶんの集計（新しい応答フレームだけを数える）。"""

    frames: int = 0
    modes: Counter = field(default_factory=Counter)
    faults: Counter = field(default_factory=Counter)
    current_min: float = float("inf")
    current_max: float = float("-inf")
    rpm_min: int = 0
    rpm_max: int = 0
    last_stamp_ns: int = 0
    estop_flags: int = 0
    # 数えなかったフレームの内訳（判定不能のときの手がかり）
    unreceived: int = 0  # 受信時刻 0 = drive_component が一度も応答を受けていない
    stale: int = 0  # 聞き始めより古い応答（その後の応答が無い）
    newest_stale_age_sec: float = -1.0


def new_summaries():
    """左右の空の集計。"""
    return {side: WheelSummary() for side in SIDES}


def same_frame(summary: WheelSummary, stamp_ns: int) -> bool:
    """直前に数えたフレームと同じフレームか（受信時刻がほぼ同じ）。"""
    return (summary.last_stamp_ns > 0
            and abs(stamp_ns - summary.last_stamp_ns) < SAME_FRAME_TOLERANCE_NS)


def add_sample(summary: WheelSummary, stamp_ns: int, mode: int, fault: int, current_amp: float,
               rpm_raw: int, min_stamp_ns: int = 0) -> bool:
    """応答フレーム 1 つを集計に足す。数えたら True。

    受信時刻 0（未受信）、min_stamp_ns より古いもの、直前とほぼ同じ受信時刻（同じフレームが
    /drive_status に繰り返し載ったもの。SAME_FRAME_TOLERANCE_NS）は数えない。
    """
    if stamp_ns <= 0 or stamp_ns < min_stamp_ns or same_frame(summary, stamp_ns):
        return False
    summary.last_stamp_ns = stamp_ns
    if summary.frames == 0:
        summary.rpm_min = summary.rpm_max = rpm_raw
    summary.frames += 1
    summary.modes[mode] += 1
    summary.faults[fault] += 1
    summary.current_min = min(summary.current_min, current_amp)
    summary.current_max = max(summary.current_max, current_amp)
    summary.rpm_min = min(summary.rpm_min, rpm_raw)
    summary.rpm_max = max(summary.rpm_max, rpm_raw)
    return True


def note_skipped(summary: WheelSummary, stamp_ns: int, now_ns_: int) -> None:
    """数えなかったフレームの理由を記録する（add_sample が False を返したとき）。"""
    if stamp_ns <= 0:
        summary.unreceived += 1
    elif not same_frame(summary, stamp_ns):
        summary.stale += 1
        age = (now_ns_ - stamp_ns) / 1e9
        if summary.newest_stale_age_sec < 0 or age < summary.newest_stale_age_sec:
            summary.newest_stale_age_sec = age


def no_feedback_reason(summary: WheelSummary) -> str:
    """新しい応答が無かった理由の説明。"""
    if summary.unreceived and not summary.stale:
        return "受信時刻 0: drive_component はこのモータから一度も応答を受けていない"
    if summary.stale:
        return f"最後の応答は約 {summary.newest_stale_age_sec:.1f} 秒前で、その後の応答が無い"
    return "応答の情報なし"


def judge(summary: WheelSummary, expected: int) -> str:
    """1 輪の判定: OK / MISMATCH / NO_FEEDBACK。"""
    if summary.frames == 0:
        return NO_FEEDBACK
    if set(summary.modes) == {expected}:
        return OK
    return MISMATCH


def exit_code(verdicts) -> int:
    """判定の並びから終了コードを決める（不一致を最優先）。"""
    verdicts = list(verdicts)
    if MISMATCH in verdicts:
        return 1
    if NO_FEEDBACK in verdicts or not verdicts:
        return 2
    return 0


def dominant_mode(summary: WheelSummary):
    """最も多く出た mode 値（フレームが無ければ None）。"""
    if not summary.modes:
        return None
    return summary.modes.most_common(1)[0][0]


def describe(side: str, summary: WheelSummary, expected: int) -> str:
    """1 輪の結果を人が読む 1 行にする。"""
    verdict = judge(summary, expected)
    if verdict == NO_FEEDBACK:
        return f"  {side:5s}: 判定不能（新しい応答フレームなし）"
    modes = ", ".join(f"{mode_name(m)}={n}" for m, n in sorted(summary.modes.items()))
    faults = ", ".join(f"0x{f:02X}={n}" for f, n in sorted(summary.faults.items()))
    mark = "OK" if verdict == OK else "NG"
    return (f"  {side:5s}: {mark}  mode[{modes}]  frames={summary.frames}  fault[{faults}]  "
            f"current {summary.current_min:+.2f}..{summary.current_max:+.2f} A  "
            f"rpm_raw {summary.rpm_min}..{summary.rpm_max}")


# ---------------------------------------------------------------------------- ROS 側


def collect(topic: str, duration: float, min_stamp_ns: int = 0):
    """topic（DriveStatus）を duration 秒聞いて左右の集計を返す。

    購読はこの呼び出しの間だけ作る（前の段階で溜まったメッセージを読まないため）。
    min_stamp_ns が 0 なら、聞き始めの STALE_MARGIN_SEC 前より古いフレームを捨てる。
    """
    import rclpy
    from questix_msgs.msg import DriveStatus

    node = rclpy.create_node("drive_mode_check")
    if min_stamp_ns <= 0:
        min_stamp_ns = node.get_clock().now().nanoseconds - int(STALE_MARGIN_SEC * 1e9)
    summaries = new_summaries()
    received = [0, 0]  # [/drive_status の件数, そのうち emergency_stop=true の件数]

    def on_status(msg):
        received[0] += 1
        received[1] += int(msg.emergency_stop)
        for side in SIDES:
            fb = getattr(msg, side)
            stamp_ns = fb.header.stamp.sec * 1_000_000_000 + fb.header.stamp.nanosec
            if add_sample(summaries[side], stamp_ns, fb.mode, fb.fault_code, fb.current_amp,
                          fb.velocity_rpm_raw, min_stamp_ns):
                summaries[side].estop_flags += int(msg.emergency_stop)
            else:
                note_skipped(summaries[side], stamp_ns, node.get_clock().now().nanoseconds)

    node.create_subscription(DriveStatus, topic, on_status, 10)
    end = time.monotonic() + duration
    while time.monotonic() < end:
        rclpy.spin_once(node, timeout_sec=0.1)
    node.destroy_node()
    return summaries, tuple(received)


def now_ns() -> int:
    """ROS の現在時刻 [ns]（drive_component の受信時刻と同じ時計）。"""
    import rclpy

    node = rclpy.create_node("drive_mode_check_clock")
    stamp = node.get_clock().now().nanoseconds
    node.destroy_node()
    return stamp


def report(title: str, summaries, received, expected: int) -> list:
    """集計を表示し、左右の判定を返す。received は (件数, emergency_stop=true の件数)。"""
    count, estop_count = received
    print(f"\n=== {title} ===")
    print(f"  /drive_status 受信 {count} 件（emergency_stop=true {estop_count} 件）。"
          f"期待する mode: {mode_name(expected)} ({expected})")
    verdicts = []
    for side in SIDES:
        print(describe(side, summaries[side], expected))
        verdict = judge(summaries[side], expected)
        if verdict == NO_FEEDBACK:
            print(f"         {no_feedback_reason(summaries[side])}")
        verdicts.append(verdict)
    if count == 0:
        print("  → /drive_status が届きません。drive_component の起動と ROS_DOMAIN_ID を確認")
    elif NO_FEEDBACK in verdicts:
        for hint in no_feedback_hints(summaries, count, estop_count):
            print(f"  → {hint}")
    return verdicts


def no_feedback_hints(summaries, count: int, estop_count: int) -> list:
    """判定不能のときに確かめることを、原因の可能性が高い順に返す。"""
    hints = []
    if estop_count:
        hints.append("drive_component は非常停止中と判断しています（/drive_status の emergency_stop）。"
                     "その間はモータと送受信しません。ロボットの非常停止と、GPIO の安全系"
                     "（GPIO5 / GPIO27。ros2 topic echo /emergency_stop の reason）を確認")
    if any(summaries[s].unreceived and not summaries[s].stale for s in SIDES):
        hints.append("一度も応答が無い輪があります。DDT の電源、serial_port、モータ ID"
                     "（left_motor_id / right_motor_id）、RS485 の配線を確認")
    if not hints:
        hints.append("応答が止まっています。drive_component の lifecycle（ros2 lifecycle get "
                     "/drive_component）、DDT の電源、drive_component のログ（'Actuation blocked: "
                     "<理由>'、'Stop fault'）を確認。教員の許可待ちだけでは止まりません（許可待ちの間も"
                     "停止フレームの再送で応答を取り続けます。止まるのは非常停止の押下と Stop fault）")
    return hints


def explain(control_mode: str, summaries, expected: int) -> None:
    """結果の読み方を表示する。"""
    seen = {dominant_mode(summaries[s]) for s in SIDES} - {None}
    if not seen:
        return
    print("\n=== 読み方 ===")
    if seen == {expected}:
        if expected == MODE_VELOCITY_LOOP:
            print("  速度ループで動いています。ただし速度ループは電源投入時の既定である可能性があり、"
                  "モード切替フレームが効いているかはこの結果からは分かりません。")
            print("  確かめるには、車輪を浮かせて control_mode: current で drive_component を起動し"
                  "直し、このスクリプトをもう一度実行します（README の手順）。")
        else:
            print("  電流ループに切り替わっています（モード切替フレームは効いています）。")
    elif expected == MODE_CURRENT_LOOP and seen == {MODE_VELOCITY_LOOP}:
        print("  control_mode は current なのに、モータは速度ループのままです。モード切替フレームが"
              "効いていません（下のフレームの配置の違いを仕様書で確認）。")
        print("  この状態では電流指令の生値が速度指令 [rpm] として解釈されます。すぐに "
              "control_mode: velocity に戻してください。")
    else:
        names = ", ".join(mode_name(m) for m in sorted(seen))
        print(f"  期待と違う mode が出ています（{names}）。control_mode={control_mode}。"
              "仕様書で値の意味を確認してください。")


def print_frames(left_id: int, right_id: int, expected: int) -> None:
    """送っているモード切替フレームと仕様のレイアウトを並べる。"""
    print("\n=== 参考: モード切替フレーム（Protocol 3, 0xA0） ===")
    print("  drive_component の送信: DATA[8] = モード値, DATA[9] = CRC8")
    print("  仕様（packModeFrame のコメントの引用）: DATA[9] = モード値, CRC なし")
    for motor_id in (left_id, right_id):
        sent, spec = mode_frames(motor_id, expected)
        print(f"  ID {motor_id}: 送信 [{hex_frame(sent)}]")
        print(f"  ID {motor_id}: 仕様 [{hex_frame(spec)}]")
    print("  仕様のとおりモータが DATA[9] をモード値として読むなら、送信フレームの DATA[9]"
          "（CRC）が無効なモード値として届いています。")


def estop_cycle(args, expected: int, before) -> list:
    """非常停止の押下・解除をはさんで、解除の後の mode を確かめる。"""
    print("\n=== 非常停止の押下・解除 ===")
    print("  モータは何も指令されません（停止のまま）。")
    input("  1) 非常停止を押してください。押したら Enter: ")
    input("  2) 3 秒以上待ってから解除してください。解除したら Enter: ")
    release_ns = now_ns()
    print(f"  解除の後 {args.after_sec:.1f} s 聞きます（DDT は起動に 1.3〜1.6 s かかります）...")
    after, received = collect(args.topic, args.after_sec, min_stamp_ns=release_ns)
    verdicts = report("非常停止の解除の後", after, received, expected)
    for side in SIDES:
        b, a = dominant_mode(before[side]), dominant_mode(after[side])
        if b is not None and a is not None and a != b:
            print(f"  → {side}: 解除の前 {mode_name(b)} → 解除の後 {mode_name(a)}。非常停止で DDT が"
                  "電源投入時のモードに戻り、drive_component はモードを送り直していません。")
    if NO_FEEDBACK not in verdicts and all(
            dominant_mode(before[s]) == dominant_mode(after[s]) for s in SIDES):
        print("  → 解除の後も mode は同じでした（この機体の非常停止が DDT の電源を切らない場合も"
              "同じ結果になります）。")
    return verdicts


def parse_args(argv=None):
    """コマンドライン引数。"""
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--control-mode", default="velocity",
                    help="drive_component の control_mode（既定 velocity）")
    ap.add_argument("--left-id", type=int, default=4, help="左モータ ID（既定 4）")
    ap.add_argument("--right-id", type=int, default=5, help="右モータ ID（既定 5）")
    ap.add_argument("--duration", type=float, default=3.0, help="聞く時間 [s]（既定 3）")
    ap.add_argument("--estop-cycle", action="store_true",
                    help="非常停止の押下・解除をはさんでもう一度確かめる（対話）")
    ap.add_argument("--after-sec", type=float, default=6.0,
                    help="非常停止を解除した後に聞く時間 [s]（既定 6）")
    ap.add_argument("--topic", default="/drive_status")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    expected = expected_mode(args.control_mode)
    if args.control_mode not in EXPECTED_MODE:
        print(f"注意: control_mode '{args.control_mode}' は未知の値です。drive_component は velocity "
              "として扱います。")

    import rclpy

    rclpy.init()
    try:
        before, received = collect(args.topic, args.duration)
        verdicts = report("現在の mode", before, received, expected)
        explain(args.control_mode, before, expected)
        print_frames(args.left_id, args.right_id, expected)
        if args.estop_cycle:
            if NO_FEEDBACK in verdicts:
                print("\n非常停止の確認は、いまの mode が読めないので行いません。")
            else:
                verdicts += estop_cycle(args, expected, before)
    except KeyboardInterrupt:
        print("\n中断しました。")
        return 2
    finally:
        rclpy.try_shutdown()
    code = exit_code(verdicts)
    print(f"\n結果: {['一致', '不一致', '判定できない'][code]}（終了コード {code}）")
    return code


if __name__ == "__main__":
    sys.exit(main())
