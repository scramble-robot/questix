#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FEETECH サーボ（shot / tilt・trigger）用のデバッグ GUI ツール。

ddt_checker.py と同じ構成の単一ファイル tkinter アプリだが、対象は DDT モーターではなく
motor_control_lib の FeetechServoController が話す Modbus-RTU プロトコルのサーボ。

主な機能:
  - 現在位置(Present Position, addr 256)を読み取り、0-4095 / 0-360deg で可視化。
  - Error Reset(addr 134)に値 4 を書き込み、現在位置を中点(2047)に再設定するキャリブレーション。
  - 速度・電圧・温度・電流・トルク状態などのテレメトリ表示。
  - ID レジスタ(addr 10)への書き込みによるサーボ ID 変更（工場出荷 ID 1 → 10/11 など）。

プロトコルは motor_control_lib/src/servo_control.cpp を Python に移植したもの。
"""

import os
import sys
import time
import tkinter as tk
from tkinter import ttk, messagebox  # ttk は起動時に ttkbootstrap へ差し替えられる場合がある

try:
    import serial
    import serial.tools.list_ports
except ImportError as e:
    print(f"pyserial が見つかりません ({e})。\n"
          "`pip3 install pyserial` または `sudo apt install python3-serial` で導入してください。",
          file=sys.stderr)
    sys.exit(1)

# GUI テーマ関連（ttkbootstrap があればモダンテーマ、無ければ stock ttk にフォールバック）
HAS_TB = False
style = None
current_theme = "light"
DARK_THEME = "darkly"
LIGHT_THEME = "flatly"

PORT = "/dev/servo"  # CH340 RS485 アダプタの udev シンボリックリンク
FALLBACK_PORT = "/dev/ttyUSB0"  # udev ルールのない開発 PC などで /dev/servo が無い場合の既定
BAUDRATE = 115200
DEFAULT_SERVO_ID = 11  # tilt サーボ（trigger は 10、工場出荷時は 1）
# ID 選択肢（工場出荷=1 / trigger=10 / tilt=11。自由入力も可能）
COMMON_SERVO_IDS = [1, 10, 11]
# ボーレート候補（サーボ既定値 115200 を先頭に、servo_control.cpp が対応するレートを列挙）
COMMON_BAUDRATES = [115200, 57600, 38400, 19200, 9600, 230400, 460800, 921600]
# ポート候補（自動検出できない・ビジー中でも選べるように既知の候補を常に列挙する）
COMMON_PORTS = ["/dev/servo", "/dev/ttyUSB0", "/dev/ttyUSB1", "/dev/ttyACM0", "/dev/ttyAMA0"]

# Modbus ファンクションコード
FUNC_READ = 0x03   # Read Holding Registers
FUNC_WRITE = 0x06  # Write Single Register

# サーボのレジスタアドレス（servo_control.cpp initializeRegisterMap のキー = 実際に送るアドレス）
REG_ID = 10                 # サーボ ID（read_write, EEPROM 保存）
REG_GOAL_POSITION = 128
REG_TORQUE_ENABLE = 129
# ロックフラグ（SM2924BLMB MODBUS-RTU 内存表 addr 133/0x85）:
# 0 を書くと EPROM 書き込みが電源断後も保存（アンロック）、1 で保存されない（起動時既定）
REG_LOCK_FLAG = 133
REG_ERROR_RESET = 134       # 値 4 で現在位置を中点(2047)に設定
# Present Position はレジスタ 257（servo_control.cpp の有効エントリ。256 は別値を返す）
REG_PRESENT_POSITION = 257
REG_PRESENT_VELOCITY = 258
REG_PRESENT_VOLTAGE = 260
REG_PRESENT_TEMPERATURE = 261
REG_MOVING_STATUS = 262
REG_PRESENT_CURRENT = 263

ERROR_RESET_MIDPOINT = 4    # Error Reset に書き込むと現在位置を中点(2047)へ
POSITION_MAX = 4095         # 12bit 位置レンジ
POSITION_MIDPOINT = 2047    # 中点


# ---------------------------------------------------------------------------
# GUI ツールキット準備（ttkbootstrap の有効化）
# ---------------------------------------------------------------------------
def ensure_gui_toolkit():
    """GUI 起動時に ttkbootstrap があれば有効化する。無ければ stock ttk にフォールバックする。

    ttkbootstrap のインストールは Ansible（raspberry_pi_setup ロール, pip3）で行う想定。
    未導入・破損（依存の Pillow 不整合など）の環境でも stock ttk で GUI 自体は起動する。
    """
    global ttk, HAS_TB
    try:
        import ttkbootstrap as tb
    except Exception as e:  # noqa: BLE001 - import 失敗の種類を問わず stock ttk で継続する
        print(f"ttkbootstrap を利用できないため stock ttk で続行します: {e}\n"
              "（`pip3 install ttkbootstrap` または Ansible の raspberry_pi_setup で導入できます）")
        return
    ttk = tb  # ttk.Button/Label/Frame/Window/... が themed 版になる
    HAS_TB = True


def _mk(cls, *args, bootstyle=None, **kwargs):
    """ウィジェット生成ヘルパー。bootstyle は ttkbootstrap 使用時のみ付与する。"""
    if HAS_TB and bootstyle:
        kwargs["bootstyle"] = bootstyle
    return cls(*args, **kwargs)


def _make_toplevel(title: str):
    """選択ダイアログ用の Toplevel を生成する。

    ttkbootstrap の Toplevel は第 1 引数が master ではなく title のため、
    tk.Toplevel と同じ感覚で位置引数を渡さないようここに集約する。
    """
    if HAS_TB:
        return ttk.Toplevel(title=title, transient=root)
    window = tk.Toplevel(root)
    window.title(title)
    return window


# ---------------------------------------------------------------------------
# ポート / ボーレート選択状態（ddt_checker.py と同じホルダー方式）
# ---------------------------------------------------------------------------
def get_current_port():
    """現在選択されているポートを取得。

    未選択時は /dev/servo（udev シンボリックリンク）を既定とするが、
    udev ルールのない別 PC ではリンクが存在しないため /dev/ttyUSB0 に
    フォールバックする。
    """
    if hasattr(get_current_port, "selected_port") and get_current_port.selected_port:
        return get_current_port.selected_port
    if os.path.exists(PORT):
        return PORT
    return FALLBACK_PORT


def get_current_baudrate():
    """現在選択されているボーレートを取得。"""
    if hasattr(get_current_baudrate, "selected_baudrate") and get_current_baudrate.selected_baudrate:
        return get_current_baudrate.selected_baudrate
    return BAUDRATE


def get_current_servo_id():
    """入力欄からサーボ ID を取得する。

    不正な入力（数値でない・範囲外）の場合は None を返し、呼び出し側で中断させる。
    黙ってデフォルト ID にフォールバックすると意図しないサーボへ書き込む恐れがあるため。
    入力欄が未生成の段階のみデフォルト ID を返す。
    """
    try:
        value = int(entry_servo_id.get())
    except NameError:
        return DEFAULT_SERVO_ID
    except ValueError:
        return None
    if 0 <= value <= 253:
        return value
    return None


def _require_servo_id():
    """サーボ ID を取得し、不正ならエラーダイアログを表示して None を返す。"""
    servo_id = get_current_servo_id()
    if servo_id is None:
        messagebox.showerror(
            "入力エラー", "サーボ ID は 0〜253 の整数で入力してください"
        )
    return servo_id


# ---------------------------------------------------------------------------
# Modbus-RTU プロトコル（servo_control.cpp の移植）
# ---------------------------------------------------------------------------
def calculate_crc16(data: bytes) -> int:
    """CRC16-MODBUS を計算する（init 0xFFFF, poly 0xA001）。servo_control.cpp calculateCRC16 相当。"""
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc


def build_frame(servo_id: int, func: int, address: int, value: int) -> bytes:
    """Modbus コマンドフレームを組み立てる。servo_control.cpp createModbusCommand 相当。

    [id][func][addrHi][addrLo][valHi][valLo][crcLo][crcHi]
    （アドレス・値はビッグエンディアン、CRC はリトルエンディアン）
    """
    payload = bytes(
        [
            servo_id & 0xFF,
            func & 0xFF,
            (address >> 8) & 0xFF,
            address & 0xFF,
            (value >> 8) & 0xFF,
            value & 0xFF,
        ]
    )
    crc = calculate_crc16(payload)
    return payload + bytes([crc & 0xFF, (crc >> 8) & 0xFF])


def verify_checksum(data: bytes) -> bool:
    """応答末尾 2 バイトの CRC を検証する。servo_control.cpp verifyChecksum 相当。"""
    if len(data) < 3:
        return False
    received_crc = data[-2] | (data[-1] << 8)
    return received_crc == calculate_crc16(data[:-2])


def _hex(data: bytes) -> str:
    """デバッグ表示用の 16 進文字列。"""
    return " ".join(f"{b:02X}" for b in data)


def _transact(ser: serial.Serial, frame: bytes) -> bytes:
    """1 フレーム送信し、受信できたバイトをすべて返す（ddt_checker.py と同方式）。

    半二重 RS485 アダプタでは送信バイトがそのまま受信側にエコーされたり、
    ライン切替時のノイズが先頭に乗ることがある。固定長で読むとエコーや
    ノイズを応答と誤認して値が壊れるため、「その時点で受信済みのバイトを
    すべて」読み取り、上位の探索関数で正しい応答フレームを取り出す。
    """
    ser.reset_input_buffer()
    ser.reset_output_buffer()
    ser.write(frame)
    ser.flush()
    time.sleep(0.02)  # サーボの応答待ち

    waiting = ser.in_waiting
    if waiting == 0:
        time.sleep(0.03)  # 応答が遅い場合に備えて追加待機
        waiting = ser.in_waiting

    if waiting > 0:
        data = ser.read(waiting)
        time.sleep(0.005)  # 末尾バイトの取りこぼし防止
        trailing = ser.in_waiting
        if trailing:
            data += ser.read(trailing)
        return data

    # in_waiting が 0 のままでも、まず 1 バイトだけ待って応答開始を確認する。
    first_byte = ser.read(1)
    if first_byte:
        time.sleep(0.01)
        trailing = ser.in_waiting
        if trailing:
            return first_byte + ser.read(trailing)
        return first_byte
    return b""


def _find_read_frame(data: bytes, servo_id: int):
    """受信バッファから読み取り応答 [id][03][02][H][L][crcL][crcH] を探す。

    エコーされた送信フレームは 3 バイト目が 0x01（レジスタ数）なので、
    3 バイト目が 0x02（バイト数）で CRC が一致するフレームだけを採用する。
    見つからなければ None。
    """
    for i in range(0, len(data) - 7 + 1):
        if data[i] == servo_id and data[i + 1] == FUNC_READ and data[i + 2] == 2:
            candidate = data[i:i + 7]
            if verify_checksum(candidate):
                return candidate
    return None


def _find_write_frame(data: bytes, servo_id: int, address: int, value: int):
    """受信バッファから書き込みエコー [id][06][addrHi][addrLo][valHi][valLo][crcL][crcH] を探す。

    アドレス・値のエコーが一致し CRC も一致するフレームだけを採用する。見つからなければ None。
    """
    for i in range(0, len(data) - 8 + 1):
        if data[i] == servo_id and data[i + 1] == FUNC_WRITE:
            candidate = data[i:i + 8]
            if not verify_checksum(candidate):
                continue
            echo_addr = (candidate[2] << 8) | candidate[3]
            echo_value = (candidate[4] << 8) | candidate[5]
            if echo_addr == address and echo_value == (value & 0xFFFF):
                return candidate
    return None


def read_register(ser: serial.Serial, servo_id: int, address: int) -> int:
    """レジスタを 1 つ読み取り、値を返す。失敗時は例外を送出する。

    応答: [id][03][byteCount=2][dataHi][dataLo][crcLo][crcHi] = 7 バイト。
    半二重 RS485 のエコーや先頭ノイズに備え、受信バッファ内から正しい
    フレームを探索して抽出する。生の受信データは read_register.last_raw に保持する。
    """
    frame = build_frame(servo_id, FUNC_READ, address, 1)
    response = _transact(ser, frame)
    read_register.last_raw = _hex(response)

    reg_frame = _find_read_frame(response, servo_id)
    if reg_frame is None:
        raise IOError(
            f"レジスタ {address} 読み取り失敗: 有効な応答フレームがありません（id={servo_id}）"
            f"\n受信データ: {_hex(response)}"
        )

    return (reg_frame[3] << 8) | reg_frame[4]


read_register.last_raw = ""


def read_register_signed(ser: serial.Serial, servo_id: int, address: int) -> int:
    """符号付き(16bit)としてレジスタを読み取る（速度・電流など）。"""
    value = read_register(ser, servo_id, address)
    return value - 0x10000 if value >= 0x8000 else value


def write_register(ser: serial.Serial, servo_id: int, address: int, value: int) -> bytes:
    """レジスタに値を書き込む。エコー確認に失敗した場合は例外を送出する。

    応答は要求のエコー: [id][06][addrHi][addrLo][valHi][valLo][crcLo][crcHi] = 8 バイト
    """
    frame = build_frame(servo_id, FUNC_WRITE, address, value)
    response = _transact(ser, frame)

    write_frame = _find_write_frame(response, servo_id, address, value)
    if write_frame is None:
        raise IOError(
            f"レジスタ {address} 書き込み失敗: エコー応答が一致しません（id={servo_id}）"
            f"\n受信データ: {_hex(response)}"
        )

    return write_frame


def open_serial() -> serial.Serial:
    """現在のポート・ボーレートで 8N1 のシリアルポートを開く。"""
    return serial.Serial(get_current_port(), get_current_baudrate(), timeout=0.5)


# ---------------------------------------------------------------------------
# 位置 <-> 角度 変換（shot_component.cpp servoPositionToAngle 相当）
# ---------------------------------------------------------------------------
def position_to_angle(position: int) -> float:
    """サーボ位置(0-4095)を角度(0-360deg)に変換する。"""
    position = max(0, min(POSITION_MAX, position))
    return position / 4096.0 * 360.0


# ---------------------------------------------------------------------------
# ポート状態ユーティリティ（ddt_checker.py と同じ）
# ---------------------------------------------------------------------------
def check_port_availability():
    """利用可能なシリアルポートをチェックする。"""
    available_ports = []
    for port in serial.tools.list_ports.comports():
        try:
            with serial.Serial(port.device, get_current_baudrate(), timeout=0.1):
                available_ports.append(port.device)
        except (serial.SerialException, OSError):
            continue
    return available_ports


def is_port_available(port_name):
    """指定されたポートが利用可能かチェックする。"""
    try:
        with serial.Serial(port_name, get_current_baudrate(), timeout=0.1):
            return True
    except (serial.SerialException, OSError):
        return False


def refresh_port_status():
    """ポート状態を更新する。"""
    current_port = get_current_port()
    current_baudrate = get_current_baudrate()
    if is_port_available(current_port):
        labels["Port Status"].config(
            text=f"利用可能 ({current_port}@{current_baudrate})", foreground="green"
        )
    else:
        labels["Port Status"].config(
            text=f"利用不可 ({current_port}@{current_baudrate})", foreground="red"
        )

    available_ports = check_port_availability()
    if available_ports:
        port_list.set("利用可能ポート: " + ", ".join(available_ports))
    else:
        port_list.set("利用可能なポートがありません")


def select_port():
    """ポートを選択する。

    自動検出されたポートに加えて COMMON_PORTS の既知候補を常に列挙する。
    これにより /dev/ttyUSB0 などが未検出・ビジー中でも選択できる。
    """
    available_ports = check_port_availability()
    # 自動検出ポート + 既知候補（重複除去・順序維持）
    port_options = list(available_ports)
    for port in COMMON_PORTS:
        if port not in port_options:
            port_options.append(port)

    selection_window = _make_toplevel("ポート選択")
    selection_window.geometry("320x300")

    ttk.Label(selection_window, text="使用するポートを選択してください:").pack(pady=10)

    available_set = set(available_ports)
    current_port = get_current_port()
    default_port = current_port if current_port in port_options else port_options[0]
    selected_port = tk.StringVar(value=default_port)
    for port in port_options:
        suffix = " (利用可能)" if port in available_set else " (未検出)"
        ttk.Radiobutton(
            selection_window, text=port + suffix, variable=selected_port, value=port
        ).pack(anchor="w", padx=20)

    def confirm_selection():
        get_current_port.selected_port = selected_port.get()
        selection_window.destroy()
        refresh_port_status()
        messagebox.showinfo("確認", f"ポート {selected_port.get()} を選択しました")

    _mk(ttk.Button, selection_window, text="確定", command=confirm_selection,
        bootstyle="success").pack(pady=10)


def select_baudrate():
    """ボーレートを選択する。"""
    selection_window = _make_toplevel("ボーレート選択")
    selection_window.geometry("300x420")

    ttk.Label(selection_window, text="使用するボーレートを選択してください:").pack(pady=10)

    selected_baudrate = tk.StringVar(value=str(get_current_baudrate()))
    for baudrate in COMMON_BAUDRATES:
        ttk.Radiobutton(
            selection_window,
            text=str(baudrate),
            variable=selected_baudrate,
            value=str(baudrate),
        ).pack(anchor="w", padx=20)

    def confirm_selection():
        get_current_baudrate.selected_baudrate = int(selected_baudrate.get())
        selection_window.destroy()
        refresh_port_status()
        messagebox.showinfo("確認", f"ボーレート {selected_baudrate.get()} を選択しました")

    _mk(ttk.Button, selection_window, text="確定", command=confirm_selection,
        bootstyle="success").pack(pady=10)


# ---------------------------------------------------------------------------
# 位置ビジュアライザ（水平バー）
# ---------------------------------------------------------------------------
_last_position = None  # 最後に読み取った位置（リサイズ再描画用）

# stock ttk フォールバック時（ライト）のパレット
_FALLBACK_PALETTE = {
    "bg": "white",
    "fg": "#333333",
    "muted": "#555555",
    "track": "#f0f0f0",
    "border": "#888888",
    "marker": "#4a90d9",
    "marker_edge": "#1a5c9c",
    "danger": "#d00000",
}


def _palette():
    """現在のテーマに応じた描画用カラーパレットを返す。"""
    if HAS_TB and style is not None:
        c = style.colors
        return {
            "bg": c.bg,
            "fg": c.fg,
            "muted": c.secondary,
            "track": c.inputbg,
            "border": c.border,
            "marker": c.primary,
            "marker_edge": c.info,
            "danger": c.danger,
        }
    return _FALLBACK_PALETTE


def draw_position_bar(position=None):
    """水平バーに現在位置を描画する。position が None なら最後の値を再描画。"""
    global _last_position
    if position is not None:
        _last_position = position

    pal = _palette()
    canvas = position_canvas
    canvas.configure(bg=pal["bg"])
    canvas.delete("all")

    width = canvas.winfo_width()
    height = canvas.winfo_height()
    if width <= 1 or height <= 1:
        return  # まだレイアウトされていない

    margin = 30
    bar_left = margin
    bar_right = width - margin
    bar_top = 25
    bar_bottom = height - 30
    bar_width = bar_right - bar_left

    def pos_to_x(pos):
        pos = max(0, min(POSITION_MAX, pos))
        return bar_left + bar_width * pos / POSITION_MAX

    # バー枠
    canvas.create_rectangle(
        bar_left, bar_top, bar_right, bar_bottom, outline=pal["border"], fill=pal["track"]
    )

    # 目盛（0, 中点, 最大）
    canvas.create_text(bar_left, bar_bottom + 12, text="0", fill=pal["muted"])
    canvas.create_text(bar_right, bar_bottom + 12, text=str(POSITION_MAX), fill=pal["muted"])

    # 中点 2047 基準線（強調）
    mid_x = pos_to_x(POSITION_MIDPOINT)
    canvas.create_line(
        mid_x, bar_top - 8, mid_x, bar_bottom + 4, fill=pal["danger"], width=2, dash=(4, 2)
    )
    canvas.create_text(
        mid_x, bar_top - 15, text="中点 2047", fill=pal["danger"], font=("Arial", 9, "bold")
    )

    if _last_position is None:
        canvas.create_text(
            (bar_left + bar_right) / 2, (bar_top + bar_bottom) / 2,
            text="---", fill=pal["muted"],
        )
        return

    # 現在位置マーカー（バーの塗り + 三角）
    marker_x = pos_to_x(_last_position)
    canvas.create_rectangle(bar_left, bar_top, marker_x, bar_bottom, outline="", fill=pal["marker"])
    canvas.create_polygon(
        marker_x - 7, bar_top - 6, marker_x + 7, bar_top - 6, marker_x, bar_top + 4,
        fill=pal["marker_edge"],
    )
    canvas.create_line(marker_x, bar_top, marker_x, bar_bottom, fill=pal["marker_edge"], width=2)

    angle = position_to_angle(_last_position)
    canvas.create_text(
        (bar_left + bar_right) / 2, bar_bottom + 14,
        text=f"Pos: {_last_position} (0x{_last_position:04X})   Angle: {angle:.1f} deg",
        fill=pal["fg"],
        font=("Arial", 10, "bold"),
    )


def on_canvas_resize(event):
    """キャンバスリサイズ時にバーを再描画する。"""
    draw_position_bar()


# ---------------------------------------------------------------------------
# 読み取り / キャリブレーション動作
# ---------------------------------------------------------------------------
def read_all_info(show_errors=True):
    """全テレメトリを読み取り、ラベルとバーを更新する。成功時 True。"""
    servo_id = _require_servo_id()
    if servo_id is None:
        return False
    try:
        with open_serial() as ser:
            position = read_register(ser, servo_id, REG_PRESENT_POSITION)
            position_raw = read_register.last_raw
            velocity = read_register_signed(ser, servo_id, REG_PRESENT_VELOCITY)
            voltage = read_register(ser, servo_id, REG_PRESENT_VOLTAGE)
            temperature = read_register(ser, servo_id, REG_PRESENT_TEMPERATURE)
            moving = read_register(ser, servo_id, REG_MOVING_STATUS)
            current = read_register_signed(ser, servo_id, REG_PRESENT_CURRENT)
            torque = read_register(ser, servo_id, REG_TORQUE_ENABLE)

        angle = position_to_angle(position)
        labels["ID"].config(text=str(servo_id))
        labels["Position"].config(text=f"{position} (0x{position:04X})")
        labels["Angle"].config(text=f"{angle:.1f} deg")
        labels["Velocity"].config(text=f"{velocity}")
        labels["Voltage"].config(text=f"{voltage / 10.0:.1f} V (raw: {voltage})")
        labels["Temperature"].config(text=f"{temperature} C")
        labels["Current"].config(text=f"{current}")
        labels["Moving"].config(text="動作中" if moving else "停止")
        labels["Torque"].config(
            text="ON" if torque else "OFF", foreground="green" if torque else "gray"
        )

        labels["Raw"].config(text="Raw: " + position_raw)
        draw_position_bar(position)
        return True
    except Exception as e:  # noqa: BLE001 - GUI にまとめて表示する
        if show_errors:
            messagebox.showerror("通信エラー", str(e))
        return False


def read_position_only(show_errors=False):
    """位置のみを読み取ってバーを更新する（自動更新の軽量版）。成功時 True。"""
    servo_id = get_current_servo_id()
    if servo_id is None:
        # 自動更新中の入力途中などで ID が不正になるのは正常系。ダイアログは出さない。
        return False
    try:
        with open_serial() as ser:
            position = read_register(ser, servo_id, REG_PRESENT_POSITION)
        angle = position_to_angle(position)
        labels["Position"].config(text=f"{position} (0x{position:04X})")
        labels["Angle"].config(text=f"{angle:.1f} deg")
        labels["Raw"].config(text="Raw: " + read_register.last_raw)
        draw_position_bar(position)
        return True
    except Exception as e:  # noqa: BLE001
        if show_errors:
            messagebox.showerror("通信エラー", str(e))
        return False


def set_midpoint():
    """Error Reset(134) に 4 を書き込み、現在位置を中点(2047)に設定する。"""
    servo_id = _require_servo_id()
    if servo_id is None:
        return
    if not messagebox.askyesno(
        "確認",
        f"サーボ ID {servo_id} の現在位置を中点(2047)に設定します。\n"
        "（Error Reset レジスタ 134 に 4 を書き込みます）\n\n"
        "これはサーボのキャリブレーションを変更します。実行しますか？",
    ):
        return

    try:
        with open_serial() as ser:
            write_register(ser, servo_id, REG_ERROR_RESET, ERROR_RESET_MIDPOINT)
            time.sleep(0.05)
            # 反映確認のため位置を再読み取り
            position = read_register(ser, servo_id, REG_PRESENT_POSITION)

        draw_position_bar(position)
        labels["Position"].config(text=f"{position} (0x{position:04X})")
        labels["Angle"].config(text=f"{position_to_angle(position):.1f} deg")
        messagebox.showinfo(
            "完了", f"中点に設定しました。\n現在位置: {position} (中点は {POSITION_MIDPOINT})"
        )
    except Exception as e:  # noqa: BLE001
        messagebox.showerror("キャリブレーションエラー", str(e))


def change_servo_id():
    """ID レジスタ(10)に新しい ID を書き込み、サーボの ID を変更する。

    ID は EPROM 領域のため、先にロックフラグ(133)へ 0 を書いてアンロック
    しないと変更が反映・保存されない（SM2924BLMB MODBUS-RTU 内存表）。
    シーケンス: アンロック(133=0) → ID 書き込み(10) → 新 ID で検証読み取り
    → 再ロック(133=1)。ID 変更直後は旧 ID 宛てのエコーが返らない個体が
    あるため、エコー不一致だけでは失敗とみなさず検証読み取りで成否を判定する。
    """
    servo_id = _require_servo_id()
    if servo_id is None:
        return
    try:
        new_id = int(id_change_entry.get())
    except ValueError:
        new_id = -1
    if not 1 <= new_id <= 247:
        messagebox.showerror(
            "入力エラー", "新しい ID は 1〜247 の整数で入力してください（0 はブロードキャスト用）"
        )
        return
    if new_id == servo_id:
        messagebox.showinfo("確認", f"現在の ID と同じため変更は不要です（id={servo_id}）")
        return
    if not messagebox.askyesno(
        "確認",
        f"サーボ ID を {servo_id} → {new_id} に変更します。\n"
        f"（ロックフラグ {REG_LOCK_FLAG} を解除してから ID レジスタ {REG_ID} に書き込みます。\n"
        "変更は EPROM に保存され、電源を切っても保持されます）\n\n"
        "※ 同じバスに ID が重複するサーボを接続しないよう注意してください。\n"
        "実行しますか？",
    ):
        return

    echo_error = None
    try:
        with open_serial() as ser:
            # アンロック: 0 で EPROM 書き込みが電源断後も保存される（起動時既定は 1=保存されない）
            write_register(ser, servo_id, REG_LOCK_FLAG, 0)
            time.sleep(0.05)
            try:
                write_register(ser, servo_id, REG_ID, new_id)
            except IOError as e:
                echo_error = e  # エコー不一致でも検証読み取りまで進める
            time.sleep(0.1)
            verified = read_register(ser, new_id, REG_ID)
            # 再ロック（新 ID 宛て）。保存済みの値には影響しない
            write_register(ser, new_id, REG_LOCK_FLAG, 1)
    except Exception as e:  # noqa: BLE001 - GUI にまとめて表示する
        # 旧 ID でまだ応答するか確認し、切り分け情報をダイアログに含める
        diag = ""
        try:
            with open_serial() as ser:
                still = read_register(ser, servo_id, REG_ID)
            diag = (f"\n\n旧 ID {servo_id} は応答しています（ID レジスタ値: {still}）。"
                    "書き込みが反映されていません。")
        except Exception:  # noqa: BLE001 - 診断failは無視して元エラーを表示
            diag = f"\n\n旧 ID {servo_id} からも応答がありません。配線・電源を確認してください。"
        detail = f"\n\n書き込み時のエコー: {echo_error}" if echo_error else ""
        messagebox.showerror(
            "ID 変更エラー",
            f"新 ID {new_id} での検証読み取りに失敗しました。\n{e}{detail}{diag}",
        )
        return

    if verified != new_id:
        messagebox.showerror(
            "ID 変更エラー",
            f"検証読み取りの値が一致しません（期待: {new_id}, 実際: {verified}）",
        )
        return

    # 接続欄の ID も新 ID へ切り替え、以降の操作が新 ID に向くようにする
    entry_servo_id.set(str(new_id))
    labels["ID"].config(text=str(new_id))
    messagebox.showinfo("完了", f"サーボ ID を {servo_id} → {new_id} に変更しました")


def toggle_torque():
    """トルク有効(129)を ON/OFF トグルする。手でホーンを動かして中点合わせする際に使う。"""
    servo_id = _require_servo_id()
    if servo_id is None:
        return
    try:
        with open_serial() as ser:
            current = read_register(ser, servo_id, REG_TORQUE_ENABLE)
            new_value = 0 if current else 1
            write_register(ser, servo_id, REG_TORQUE_ENABLE, new_value)
        labels["Torque"].config(
            text="ON" if new_value else "OFF",
            foreground="green" if new_value else "gray",
        )
        messagebox.showinfo("完了", f"トルクを {'ON' if new_value else 'OFF'} にしました")
    except Exception as e:  # noqa: BLE001
        messagebox.showerror("通信エラー", str(e))


# ---------------------------------------------------------------------------
# 位置指令（Goal Position, addr 128）
# ---------------------------------------------------------------------------
def _refresh_goal_angle_label():
    """現在のスライダ値に対応する角度ラベルを更新する。"""
    goal = int(float(goal_scale.get()))
    goal_angle_label.config(text=f"Angle: {position_to_angle(goal):.1f} deg")


def on_goal_slider(value):
    """スライダ操作時: 入力欄と角度ラベルを同期する（送信はしない）。"""
    goal = int(float(value))
    goal_entry.delete(0, tk.END)
    goal_entry.insert(0, str(goal))
    goal_angle_label.config(text=f"Angle: {position_to_angle(goal):.1f} deg")


def apply_goal_entry(event=None):
    """入力欄の値をスライダへ反映する（Enter または「移動」前に呼ぶ）。"""
    try:
        goal = int(goal_entry.get())
    except ValueError:
        return
    goal = max(0, min(POSITION_MAX, goal))
    goal_scale.set(goal)
    _refresh_goal_angle_label()


def get_goal_position():
    """入力欄から目標位置を取得し 0-POSITION_MAX にクランプする。不正な場合は None。"""
    try:
        goal = int(goal_entry.get())
    except ValueError:
        return None
    return max(0, min(POSITION_MAX, goal))


def move_to_goal():
    """Goal Position(128) に目標位置を書き込み、サーボを動作させる。"""
    goal = get_goal_position()
    if goal is None:
        messagebox.showerror("入力エラー", f"目標位置は 0〜{POSITION_MAX} の整数で入力してください")
        return

    # 入力欄をクランプ後の値に揃える
    goal_scale.set(goal)
    goal_entry.delete(0, tk.END)
    goal_entry.insert(0, str(goal))
    _refresh_goal_angle_label()

    servo_id = _require_servo_id()
    if servo_id is None:
        return
    enable_torque = torque_on_var.get()
    try:
        with open_serial() as ser:
            if enable_torque:
                write_register(ser, servo_id, REG_TORQUE_ENABLE, 1)
            write_register(ser, servo_id, REG_GOAL_POSITION, goal)
            time.sleep(0.05)
            # 到達位置を確認のため読み取り（失敗しても指令自体は成功扱い）
            try:
                position = read_register(ser, servo_id, REG_PRESENT_POSITION)
            except Exception:  # noqa: BLE001
                position = goal

        if enable_torque:
            labels["Torque"].config(text="ON", foreground="green")
        labels["Position"].config(text=f"{position} (0x{position:04X})")
        labels["Angle"].config(text=f"{position_to_angle(position):.1f} deg")
        draw_position_bar(position)
    except Exception as e:  # noqa: BLE001
        messagebox.showerror("通信エラー", str(e))


# ---------------------------------------------------------------------------
# 自動更新ポーリング
# ---------------------------------------------------------------------------
_poll_job = None  # root.after のジョブ ID
_poll_busy = False  # 読み取り中フラグ（オーバーラップ防止）


def poll_tick():
    """自動更新の 1 サイクル。位置を読み取り、次サイクルを予約する。"""
    global _poll_job, _poll_busy
    if not auto_refresh_var.get():
        _poll_job = None
        return

    if not _poll_busy:
        _poll_busy = True
        try:
            read_position_only(show_errors=False)
        finally:
            _poll_busy = False

    _poll_job = root.after(200, poll_tick)


def toggle_auto_refresh():
    """自動更新チェックボックスの ON/OFF を処理する。"""
    global _poll_job
    if auto_refresh_var.get():
        if _poll_job is None:
            poll_tick()
    else:
        if _poll_job is not None:
            root.after_cancel(_poll_job)
            _poll_job = None


def toggle_theme():
    """ダーク / ライトテーマを切り替える（ttkbootstrap 使用時のみ有効）。"""
    global current_theme
    if not HAS_TB or style is None:
        return
    current_theme = "light" if current_theme == "dark" else "dark"
    style.theme_use(LIGHT_THEME if current_theme == "light" else DARK_THEME)
    theme_button.config(text="☀ ライト" if current_theme == "dark" else "🌙 ダーク")
    # テーマ非対応のキャンバス背景を再適用してバーを再描画
    draw_position_bar()


def on_close():
    """ウィンドウを閉じる際にポーリングを止めてから破棄する。"""
    global _poll_job
    auto_refresh_var.set(False)
    if _poll_job is not None:
        root.after_cancel(_poll_job)
        _poll_job = None
    root.destroy()


# ---------------------------------------------------------------------------
# セルフテスト（--selftest）: ハードウェア無しでプロトコルヘルパーを検証
# ---------------------------------------------------------------------------
def _selftest():
    """フレーム生成 / CRC / 変換の整合性を検証する。"""
    # Present Position 読み取り（ID 11, addr 257=0x0101）は 0B 03 01 01 00 01 <crc>
    frame = build_frame(DEFAULT_SERVO_ID, FUNC_READ, REG_PRESENT_POSITION, 1)
    assert frame[:6] == bytes([0x0B, 0x03, 0x01, 0x01, 0x00, 0x01]), _hex(frame)
    # 自身の CRC を検証（ラウンドトリップ）
    assert verify_checksum(frame), "read frame CRC round-trip failed"

    # Error Reset 書き込み（ID 11, addr 134, val 4）は 0B 06 00 86 00 04 <crc>
    wframe = build_frame(DEFAULT_SERVO_ID, FUNC_WRITE, REG_ERROR_RESET, ERROR_RESET_MIDPOINT)
    assert wframe[:6] == bytes([0x0B, 0x06, 0x00, 0x86, 0x00, 0x04]), _hex(wframe)
    assert verify_checksum(wframe), "write frame CRC round-trip failed"

    # Goal Position 書き込み（ID 11, addr 128, val 2047）は 0B 06 00 80 07 FF <crc>
    gframe = build_frame(DEFAULT_SERVO_ID, FUNC_WRITE, REG_GOAL_POSITION, POSITION_MIDPOINT)
    assert gframe[:6] == bytes([0x0B, 0x06, 0x00, 0x80, 0x07, 0xFF]), _hex(gframe)
    assert verify_checksum(gframe), "goal frame CRC round-trip failed"

    # 既知のベクトル: Modbus CRC16 of {0x01,0x03,0x00,0x00,0x00,0x01} = 0x0A84 -> LO 84 HI 0A
    crc = calculate_crc16(bytes([0x01, 0x03, 0x00, 0x00, 0x00, 0x01]))
    assert crc == 0x0A84, f"CRC16 mismatch: 0x{crc:04X}"

    # 位置 <-> 角度
    assert abs(position_to_angle(0) - 0.0) < 1e-6
    assert abs(position_to_angle(2048) - 180.0) < 1e-6
    assert abs(position_to_angle(4095) - 360.0) < 0.1

    # フレーム探索: クリーンな応答から読み取りフレームを抽出（position=2047）
    def _read_response(servo_id, value):
        payload = bytes([servo_id, FUNC_READ, 2, (value >> 8) & 0xFF, value & 0xFF])
        c = calculate_crc16(payload)
        return payload + bytes([c & 0xFF, (c >> 8) & 0xFF])

    clean = _read_response(DEFAULT_SERVO_ID, POSITION_MIDPOINT)
    found = _find_read_frame(clean, DEFAULT_SERVO_ID)
    assert found is not None and ((found[3] << 8) | found[4]) == POSITION_MIDPOINT, _hex(clean)

    # 半二重 RS485 のエコー（送信フレーム）が先頭に付いても正しい応答を抽出できる
    echo = build_frame(DEFAULT_SERVO_ID, FUNC_READ, REG_PRESENT_POSITION, 1)
    with_echo = echo + clean
    found2 = _find_read_frame(with_echo, DEFAULT_SERVO_ID)
    assert found2 is not None and ((found2[3] << 8) | found2[4]) == POSITION_MIDPOINT, _hex(with_echo)

    # 先頭ノイズ 1 バイトが乗っても抽出できる
    noisy = bytes([0x00]) + clean
    found3 = _find_read_frame(noisy, DEFAULT_SERVO_ID)
    assert found3 is not None and ((found3[3] << 8) | found3[4]) == POSITION_MIDPOINT, _hex(noisy)

    # 書き込みエコー探索: エコー（=応答）を抽出できる
    wresp = build_frame(DEFAULT_SERVO_ID, FUNC_WRITE, REG_GOAL_POSITION, POSITION_MIDPOINT)
    wfound = _find_write_frame(wresp, DEFAULT_SERVO_ID, REG_GOAL_POSITION, POSITION_MIDPOINT)
    assert wfound is not None, _hex(wresp)
    # アドレス/値が一致しないフレームは採用しない
    assert _find_write_frame(wresp, DEFAULT_SERVO_ID, REG_GOAL_POSITION, 0) is None

    print("selftest OK")


# ---------------------------------------------------------------------------
# GUI 構築（ddt_checker.py と同じスクロール可能レイアウト）
# ---------------------------------------------------------------------------
def build_gui():
    """GUI を構築して起動する（tkinter）。"""
    global root, labels, port_list, entry_servo_id, position_canvas, auto_refresh_var
    global goal_scale, goal_entry, goal_angle_label, torque_on_var, style, theme_button
    global id_change_entry

    ensure_gui_toolkit()  # ttkbootstrap を有効化（無ければ stock ttk）

    try:
        if HAS_TB:
            root = ttk.Window(themename=LIGHT_THEME)
            style = root.style
        else:
            root = tk.Tk()
            style = ttk.Style()
            try:
                style.theme_use("clam")
            except tk.TclError:
                pass
    except tk.TclError as e:
        print(f"GUI を初期化できません（ディスプレイに接続できない環境の可能性があります）: {e}\n"
              "DISPLAY 環境変数の設定、または X 転送 / デスクトップ環境上での実行を確認してください。",
              file=sys.stderr)
        sys.exit(1)

    root.title("サーボ状態表示 & 中点設定")
    root.geometry("460x800")
    root.protocol("WM_DELETE_WINDOW", on_close)

    main_container = ttk.Frame(root)
    main_container.pack(fill="both", expand=True)

    canvas = tk.Canvas(main_container, highlightthickness=0)
    if HAS_TB:
        canvas.configure(bg=style.colors.bg)
    scrollbar = ttk.Scrollbar(main_container, orient="vertical", command=canvas.yview)
    scrollable_frame = ttk.Frame(canvas)

    scrollable_window = canvas.create_window((0, 0), window=scrollable_frame, anchor="nw")
    canvas.configure(yscrollcommand=scrollbar.set)

    def update_scroll_region(event=None):
        canvas.configure(scrollregion=canvas.bbox("all"))

    def resize_scrollable_frame(event):
        canvas.itemconfigure(scrollable_window, width=event.width)

    def scroll_with_mousewheel(event):
        canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")

    scrollable_frame.bind("<Configure>", update_scroll_region)
    canvas.bind("<Configure>", resize_scrollable_frame)
    canvas.bind_all("<MouseWheel>", scroll_with_mousewheel)
    canvas.bind_all("<Button-4>", lambda e: canvas.yview_scroll(-1, "units"))
    canvas.bind_all("<Button-5>", lambda e: canvas.yview_scroll(1, "units"))
    canvas.pack(side="left", fill="both", expand=True)
    scrollbar.pack(side="right", fill="y")

    labels = {}

    # --- 接続 ---
    frame_conn = ttk.Labelframe(scrollable_frame, text="接続", padding=10)
    frame_conn.pack(padx=10, pady=(10, 5), fill="x")

    ttk.Label(frame_conn, text="Port Status:").grid(row=0, column=0, sticky="e")
    labels["Port Status"] = ttk.Label(frame_conn, text="---")
    labels["Port Status"].grid(row=0, column=1, sticky="w", columnspan=2)

    ttk.Label(frame_conn, text="サーボ ID:").grid(row=1, column=0, sticky="e", pady=3)
    # 既知 ID をプルダウンで選択できるコンボボックス（0〜253 の自由入力も可能）
    entry_servo_id = ttk.Combobox(
        frame_conn, width=6, values=[str(i) for i in COMMON_SERVO_IDS]
    )
    entry_servo_id.set(str(DEFAULT_SERVO_ID))
    entry_servo_id.grid(row=1, column=1, sticky="w", pady=3)
    ttk.Label(frame_conn, text="(工場出荷=1 / trigger=10 / tilt=11)", foreground="gray").grid(
        row=1, column=2, sticky="w"
    )

    _mk(ttk.Button, frame_conn, text="ポート選択", command=select_port,
        bootstyle="primary-outline").grid(row=2, column=0, pady=3, padx=2, sticky="ew")
    _mk(ttk.Button, frame_conn, text="ボーレート選択", command=select_baudrate,
        bootstyle="primary-outline").grid(row=2, column=1, pady=3, padx=2, sticky="ew")
    _mk(ttk.Button, frame_conn, text="ポート状態更新", command=refresh_port_status,
        bootstyle="primary-outline").grid(row=2, column=2, pady=3, padx=2, sticky="ew")

    # テーマ切り替え（ttkbootstrap 使用時のみ）
    theme_button = _mk(
        ttk.Button, frame_conn, text="🌙 ダーク", command=toggle_theme, bootstyle="secondary"
    )
    if HAS_TB:
        theme_button.grid(row=3, column=0, columnspan=3, pady=(6, 0), sticky="ew")

    # --- サーボ情報 ---
    frame_info = ttk.Labelframe(scrollable_frame, text="サーボ情報", padding=10)
    frame_info.pack(padx=10, pady=5, fill="x")

    info_keys = ["ID", "Position", "Angle", "Velocity", "Voltage", "Temperature", "Current",
                 "Moving", "Torque"]
    for i, key in enumerate(info_keys):
        ttk.Label(frame_info, text=f"{key}:").grid(row=i, column=0, sticky="e")
        labels[key] = ttk.Label(frame_info, text="---")
        labels[key].grid(row=i, column=1, sticky="w")

    _mk(ttk.Button, frame_info, text="情報更新", command=read_all_info, bootstyle="primary").grid(
        row=len(info_keys), columnspan=2, pady=(8, 2)
    )

    auto_refresh_var = tk.BooleanVar(value=False)
    _mk(
        ttk.Checkbutton,
        frame_info,
        text="自動更新 (200ms)",
        variable=auto_refresh_var,
        command=toggle_auto_refresh,
        bootstyle="round-toggle",
    ).grid(row=len(info_keys) + 1, columnspan=2, pady=2)

    # --- 位置ビジュアライザ ---
    frame_vis = ttk.Labelframe(scrollable_frame, text="位置ビジュアライザ", padding=10)
    frame_vis.pack(padx=10, pady=5, fill="x")

    vis_bg = style.colors.bg if HAS_TB else "white"
    position_canvas = tk.Canvas(frame_vis, height=110, highlightthickness=0, bg=vis_bg)
    position_canvas.pack(fill="x", expand=True)
    position_canvas.bind("<Configure>", on_canvas_resize)

    # 現在位読み取りの生応答（hex）を表示し、値がおかしい場合の診断を助ける
    labels["Raw"] = ttk.Label(
        frame_vis, text="Raw: ---", foreground="gray", font=("Courier", 9), justify="left"
    )
    labels["Raw"].pack(anchor="w", pady=(4, 0))

    # --- 位置指令（Goal Position） ---
    frame_goal = ttk.Labelframe(scrollable_frame, text="位置指令 (Goal Position)", padding=10)
    frame_goal.pack(padx=10, pady=5, fill="x")

    goal_scale = _mk(
        ttk.Scale,
        frame_goal,
        from_=0,
        to=POSITION_MAX,
        orient="horizontal",
        command=on_goal_slider,
        bootstyle="info",
    )
    goal_scale.pack(fill="x", expand=True)

    goal_row = ttk.Frame(frame_goal)
    goal_row.pack(fill="x", pady=(4, 0))
    ttk.Label(goal_row, text=f"目標位置 (0〜{POSITION_MAX}):").pack(side="left")
    goal_entry = ttk.Entry(goal_row, width=8)
    goal_entry.insert(0, str(POSITION_MIDPOINT))
    goal_entry.bind("<Return>", apply_goal_entry)
    goal_entry.pack(side="left", padx=5)
    goal_angle_label = ttk.Label(goal_row, text="Angle: 180.0 deg", foreground="gray")
    goal_angle_label.pack(side="left", padx=5)

    # goal_entry / goal_angle_label 生成後に初期値を設定（.set が on_goal_slider を発火するため）
    goal_scale.set(POSITION_MIDPOINT)

    torque_on_var = tk.BooleanVar(value=True)
    _mk(
        ttk.Checkbutton,
        frame_goal,
        text="送信時にトルクON",
        variable=torque_on_var,
        bootstyle="round-toggle",
    ).pack(anchor="w", pady=(4, 0))
    _mk(ttk.Button, frame_goal, text="移動", command=move_to_goal, bootstyle="success").pack(
        fill="x", pady=(4, 0)
    )

    # --- キャリブレーション ---
    frame_cal = ttk.Labelframe(scrollable_frame, text="キャリブレーション", padding=10)
    frame_cal.pack(padx=10, pady=5, fill="x")

    _mk(
        ttk.Button, frame_cal, text="現在位置を中点(2047)に設定", command=set_midpoint,
        bootstyle="info",
    ).pack(fill="x", pady=3)
    _mk(
        ttk.Button, frame_cal, text="トルク ON/OFF", command=toggle_torque,
        bootstyle="secondary-outline",
    ).pack(fill="x", pady=3)
    ttk.Label(
        frame_cal,
        text="※ トルクを OFF にして手でホーンを目標位置へ動かし、\n"
             "  「中点(2047)に設定」を押すとその位置が中点になります。",
        foreground="gray",
        justify="left",
    ).pack(anchor="w", pady=(3, 0))

    # --- ID 変更 ---
    frame_id = ttk.Labelframe(scrollable_frame, text="ID 変更", padding=10)
    frame_id.pack(padx=10, pady=5, fill="x")

    id_row = ttk.Frame(frame_id)
    id_row.pack(fill="x")
    ttk.Label(id_row, text="新しい ID:").pack(side="left")
    id_change_entry = ttk.Combobox(
        id_row, width=6, values=[str(i) for i in COMMON_SERVO_IDS]
    )
    id_change_entry.pack(side="left", padx=5)
    _mk(ttk.Button, id_row, text="ID を書き込む", command=change_servo_id,
        bootstyle="warning").pack(side="left", padx=5)
    ttk.Label(
        frame_id,
        text="※ 接続欄の「サーボ ID」のサーボに対して書き込みます。\n"
             "  変更は EEPROM に保存され、成功すると接続欄の ID も切り替わります。",
        foreground="gray",
        justify="left",
    ).pack(anchor="w", pady=(3, 0))

    # ポート状態表示
    port_list = tk.StringVar()
    ttk.Label(scrollable_frame, textvariable=port_list, foreground="blue").pack(pady=5)

    refresh_port_status()
    root.after(100, lambda: draw_position_bar())  # 初期描画
    root.mainloop()


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        _selftest()
    else:
        build_gui()
