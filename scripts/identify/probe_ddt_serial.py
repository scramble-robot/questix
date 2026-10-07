#!/usr/bin/env python3
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""DDT モータ（M0602C）が RS485 で応答するかを、生のバイト列で確かめる.

drive_component が「一度も応答を受けていない」（/drive_status の受信時刻 0）ときに、
電源・配線・モータ ID・ボーレートのどれが原因かを切り分けるための道具。ROS は使わない。

やること:
  1. ポートを開いている他のプロセスが無いことを確かめる（drive_component を止めてから使う）。
  2. 何も送らずに少し聞く（他の送り手や雑音が流れていないか）。
  3. 指定した ID ごとに **速度 0 の停止フレーム**（Protocol 1、0x64、ブレーキなし、
     drive_component が停止中に送るものと同じ）を送り、返ってきたバイト列をそのまま表示する。
     正しい応答なら mode・速度・電流・fault を読む。

送るのは速度 0 の停止フレームだけで、モータを回す指令は送らない。それでも実機の RS485 に
書き込むので、車輪を浮かせるか、ロボットが動いても安全な状態で使う。

終了コード: 0 = 全 ID が正しく応答 / 1 = 応答の無い ID か壊れた応答がある / 3 = 実行できない
"""
from __future__ import annotations

import argparse
import os
import select
import sys
import termios
import time

from drive_mode_check import crc8_maxim, hex_frame, mode_name

FRAME_LEN = 10
BAUD = {9600: termios.B9600, 19200: termios.B19200, 38400: termios.B38400,
        57600: termios.B57600, 115200: termios.B115200}
# drive_component が固定で送るファーム加速時間（drive_component.cpp kFirmwareAccelTime0p1msPerRpm）
ACCEL_TIME = 1


def stop_frame(motor_id: int) -> list:
    """速度 0・ブレーキなしの指令フレーム（ddt_protocol::packVelocityFrame と同じ並び）。"""
    data = [motor_id & 0xFF, 0x64, 0, 0, 0, 0, ACCEL_TIME, 0, 0]
    return data + [crc8_maxim(data)]


def parse_ids(text: str) -> list:
    """'4,5' や '1-10' を ID の並びにする。"""
    ids = []
    for part in text.split(","):
        part = part.strip()
        if "-" in part:
            lo, hi = (int(v) for v in part.split("-", 1))
            ids.extend(range(lo, hi + 1))
        elif part:
            ids.append(int(part))
    if not ids or any(not 0 <= i <= 255 for i in ids):
        raise ValueError(f"ID の指定が不正です: {text}")
    return ids


def find_frame(data: bytes, motor_id: int, sent=None):
    """受信バイト列から、先頭が motor_id で CRC が合う 10 バイトを探す（無ければ None）。

    sent（送ったフレーム）と同じ 10 バイトは応答として数えない: 変換器が送信をエコーすると、
    自分の指令も ID と CRC が合って見えるため。
    """
    sent = bytes(sent) if sent is not None else None
    for start in range(len(data) - FRAME_LEN + 1):
        frame = data[start:start + FRAME_LEN]
        if frame == sent:
            continue
        if frame[0] == motor_id and crc8_maxim(frame[:9]) == frame[9]:
            return list(frame)
    return None


def decode(frame: list) -> dict:
    """Protocol 1 応答（ddt_protocol::parseFeedbackFrame と同じ並び、big-endian）。"""
    def s16(hi, lo):
        v = (hi << 8) | lo
        return v - 0x10000 if v & 0x8000 else v

    return {"mode": frame[1], "current_amp": s16(frame[2], frame[3]) * 8.0 / 32767.0,
            "speed_rpm": s16(frame[4], frame[5]), "position": (frame[6] << 8) | frame[7],
            "fault": frame[8]}


def classify(sent: list, data: bytes, motor_id: int) -> str:
    """応答の種類: ok / echo（送ったフレームがそのまま返る）/ garbage / none。"""
    if find_frame(data, motor_id, sent) is not None:
        return "ok"
    if not data:
        return "none"
    if bytes(sent) in data:
        return "echo"
    return "garbage"


def other_holders(port: str) -> list:
    """port を開いている他のプロセス（/proc から読める範囲。他ユーザーのものは見えない）。"""
    target = os.path.realpath(port)
    holders = []
    for pid in filter(str.isdigit, os.listdir("/proc")):
        if int(pid) == os.getpid():
            continue
        fd_dir = f"/proc/{pid}/fd"
        try:
            fds = os.listdir(fd_dir)
        except OSError:
            continue
        for fd in fds:
            try:
                if os.path.realpath(os.path.join(fd_dir, fd)) == target:
                    with open(f"/proc/{pid}/comm") as comm:
                        holders.append(f"{pid} {comm.read().strip()}")
                    break
            except OSError:
                continue
    return holders


def open_port(port: str, baud: int) -> int:
    """8N1・raw でポートを開く。"""
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    attrs = termios.tcgetattr(fd)
    attrs[0] = 0  # iflag
    attrs[1] = 0  # oflag
    attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL  # cflag
    attrs[3] = 0  # lflag
    attrs[4] = attrs[5] = BAUD[baud]
    attrs[6][termios.VMIN] = 0
    attrs[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, attrs)
    termios.tcflush(fd, termios.TCIOFLUSH)
    return fd


def read_for(fd: int, seconds: float) -> bytes:
    """seconds 秒の間に届いたバイトを全部読む。"""
    data = b""
    end = time.monotonic() + seconds
    while True:
        remain = end - time.monotonic()
        if remain <= 0:
            return data
        ready, _, _ = select.select([fd], [], [], remain)
        if ready:
            try:
                data += os.read(fd, 256)
            except BlockingIOError:
                pass


def probe(fd: int, motor_id: int, timeout: float) -> tuple:
    """1 つの ID に停止フレームを送り、(送信, 受信, 種類) を返す。"""
    sent = stop_frame(motor_id)
    termios.tcflush(fd, termios.TCIFLUSH)
    os.write(fd, bytes(sent))
    termios.tcdrain(fd)
    data = read_for(fd, timeout)
    return sent, data, classify(sent, data, motor_id)


def parse_args(argv=None):
    """コマンドライン引数。"""
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", default="/dev/ttyACM0", help="RS485 のポート（既定 /dev/ttyACM0）")
    ap.add_argument("--ids", default="4,5", help="確かめるモータ ID（例 4,5 / 1-10。既定 4,5）")
    ap.add_argument("--baud", type=int, default=57600, choices=sorted(BAUD),
                    help="ボーレート（M0602C の仕様は 57600）")
    ap.add_argument("--timeout-ms", type=int, default=50, help="1 フレームの応答を待つ時間 [ms]")
    ap.add_argument("--repeat", type=int, default=3, help="ID ごとの送信回数（既定 3）")
    ap.add_argument("--listen-sec", type=float, default=0.5, help="送る前に聞く時間 [s]")
    ap.add_argument("--yes", action="store_true", help="確認を省く")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    try:
        ids = parse_ids(args.ids)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3
    if not os.path.exists(args.port):
        print(f"error: {args.port} がありません", file=sys.stderr)
        return 3
    holders = other_holders(args.port)
    if holders:
        print(f"error: {args.port} を他のプロセスが開いています: {', '.join(holders)}\n"
              "       drive_component（ros2 launch）を止めてから実行してください", file=sys.stderr)
        return 3

    print(f"ポート {args.port}（{os.path.realpath(args.port)}）、{args.baud} bps、ID {ids}")
    print("送るのは速度 0・ブレーキなしの停止フレームだけです（モータを回す指令は送りません）。")
    if not args.yes:
        try:
            input("車輪を浮かせるなど、ロボットが動いても安全なことを確かめたら Enter（中止は Ctrl-C）: ")
        except KeyboardInterrupt:
            print("\n中止しました。")
            return 3

    try:
        fd = open_port(args.port, args.baud)
    except OSError as exc:
        print(f"error: {args.port} を開けません: {exc}", file=sys.stderr)
        return 3
    try:
        idle = read_for(fd, args.listen_sec)
        print(f"\n送る前の {args.listen_sec:.1f} s: "
              + (f"{len(idle)} バイト受信 [{hex_frame(idle[:40])}{' ...' if len(idle) > 40 else ''}]"
                 " ← 何も送っていないのに流れている（他の送り手・雑音）" if idle else "何も流れていない"))

        results = {}
        for motor_id in ids:
            kinds = []
            print(f"\nID {motor_id}:")
            for _ in range(max(1, args.repeat)):
                sent, data, kind = probe(fd, motor_id, args.timeout_ms / 1000.0)
                kinds.append(kind)
                line = f"  送信 [{hex_frame(sent)}]  受信 {len(data)} バイト"
                if data:
                    line += f" [{hex_frame(data[:30])}{' ...' if len(data) > 30 else ''}]"
                print(line + f"  → {kind}")
                if kind == "ok":
                    d = decode(find_frame(data, motor_id, sent))
                    print(f"    mode={d['mode']}（{mode_name(d['mode'])}） speed={d['speed_rpm']} rpm "
                          f"current={d['current_amp']:+.2f} A position={d['position']} "
                          f"fault=0x{d['fault']:02X}")
                time.sleep(0.05)
            results[motor_id] = kinds
    finally:
        os.close(fd)

    print("\n=== まとめ ===")
    for motor_id, kinds in results.items():
        print(f"  ID {motor_id}: " + ", ".join(kinds))
    all_kinds = {k for kinds in results.values() for k in kinds}
    if all_kinds == {"ok"}:
        print("  すべての ID が応答しました。drive_component 側（起動時の状態・ポートの設定）を疑います。")
        return 0
    if all_kinds == {"none"}:
        print("  どの ID からも 1 バイトも返りません。DDT の電源（物理の非常停止で切れる機体がある）、"
              "RS485 の配線（A/B の入れ替わり・GND）、変換器が DDT 側につながっているかを確認。"
              "ID が違う可能性は --ids 1-20 で確かめられます。")
    elif "echo" in all_kinds and "ok" not in all_kinds:
        print("  送ったフレームがそのまま返るだけです（変換器のエコー）。DDT からの応答は来ていません。"
              "電源と配線を確認。")
    elif "garbage" in all_kinds:
        print("  何かは返りますが、正しいフレームになりません。ボーレート（--baud）、A/B の入れ替わり、"
              "他の機器が同じバスにいないかを確認。")
    else:
        print("  応答しない ID があります。その ID のモータの電源・配線・ID 設定を確認。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
