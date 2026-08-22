import tkinter as tk
from tkinter import ttk, messagebox
import serial
import serial.tools.list_ports
import time

PORT = "/dev/ttyACM0"  # 使用しているRS485ポートに変更
BAUDRATE = 57600
# ボーレート候補（M0602C 仕様の既定値 57600 を先頭に、一般的なレートを列挙）
COMMON_BAUDRATES = [57600, 9600, 19200, 38400, 115200]

def get_current_port():
    """現在選択されているポートを取得"""
    if hasattr(get_current_port, 'selected_port') and get_current_port.selected_port:
        return get_current_port.selected_port
    return PORT

def get_current_baudrate():
    """現在選択されているボーレートを取得"""
    if hasattr(get_current_baudrate, 'selected_baudrate') and get_current_baudrate.selected_baudrate:
        return get_current_baudrate.selected_baudrate
    return BAUDRATE

def crc8_maxim(data: bytes) -> int:
    crc = 0x00
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 0x01:
                crc = (crc >> 1) ^ 0x8C
            else:
                crc >>= 1
    return crc

def check_port_availability():
    """利用可能なシリアルポートをチェックする"""
    available_ports = []
    ports = serial.tools.list_ports.comports()
    
    for port in ports:
        try:
            with serial.Serial(port.device, get_current_baudrate(), timeout=0.1) as ser:
                available_ports.append(port.device)
        except (serial.SerialException, OSError):
            continue
    
    return available_ports

def is_port_available(port_name):
    """指定されたポートが利用可能かチェックする"""
    try:
        with serial.Serial(port_name, get_current_baudrate(), timeout=0.1) as ser:
            return True
    except (serial.SerialException, OSError):
        return False

def refresh_port_status():
    """ポート状態を更新"""
    current_port = get_current_port()
    current_baudrate = get_current_baudrate()
    if is_port_available(current_port):
        labels["Port Status"].config(text=f"利用可能 ({current_port}@{current_baudrate})", foreground="green")
    else:
        labels["Port Status"].config(text=f"利用不可 ({current_port}@{current_baudrate})", foreground="red")
    
    # 利用可能なポート一覧を表示
    available_ports = check_port_availability()
    if available_ports:
        port_list.set("利用可能ポート: " + ", ".join(available_ports))
    else:
        port_list.set("利用可能なポートがありません")

def build_feedback_cmd(motor_id):
    """プロトコル2（フィードバック要求 0x74）のフレームを組み立てる"""
    cmd = bytes([motor_id, 0x74] + [0x00]*7)
    return cmd + bytes([crc8_maxim(cmd)])

def query_motor(ser, motor_id, wait=0.3):
    """プロトコル2でモーターへ問い合わせ、受信した生データを返す。

    RS-485変換器によっては送信フレームがそのままエコーバックされるため、
    受信データの先頭が送信フレームと一致した場合は除去する。
    """
    ser.reset_input_buffer()
    cmd = build_feedback_cmd(motor_id)
    ser.write(cmd)
    ser.flush()

    deadline = time.time() + wait
    buf = b""
    while time.time() < deadline:
        n = ser.in_waiting
        if n:
            buf += ser.read(n)
        else:
            time.sleep(0.005)
        # エコーバック除去
        if buf[:10] == cmd:
            buf = buf[10:]
        if len(buf) >= 10:
            break
    return buf

def test_communication(port, baudrate, motor_id, timeout=0.3):
    """指定されたポート・ボーレート・IDで通信テストを行う"""
    try:
        with serial.Serial(port, baudrate, timeout=timeout) as ser:
            ser.reset_output_buffer()
            response = query_motor(ser, motor_id, wait=timeout)
            if len(response) >= 10:
                frame = response[:10]
                if frame[9] == crc8_maxim(frame[:9]):
                    return True, frame
                return False, "CRCエラー"
            return False, f"{len(response)}バイト受信"
    except Exception as e:
        return False, str(e)

def auto_detect_baudrate():
    """自動的にボーレートを検出する"""
    current_port = get_current_port()
    results = []
    
    progress_window = tk.Toplevel(root)
    progress_window.title("ボーレート検出中...")
    progress_window.geometry("400x300")
    
    tk.Label(progress_window, text="ボーレート自動検出中...", font=("Arial", 12)).pack(pady=10)
    
    # 結果表示用テキストエリア
    result_text = tk.Text(progress_window, height=15, width=50)
    result_text.pack(padx=10, pady=10)
    
    scrollbar = tk.Scrollbar(progress_window, command=result_text.yview)
    scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
    result_text.config(yscrollcommand=scrollbar.set)
    
    def close_and_set_baudrate(baudrate, motor_id):
        get_current_baudrate.selected_baudrate = baudrate
        entry_target_id.set(format_motor_id(motor_id))
        progress_window.destroy()
        refresh_port_status()
        messagebox.showinfo("検出完了",
                            f"ボーレート {baudrate} / モーターID {format_motor_id(motor_id)} に設定しました")

    # スキャン対象ID（入力中のIDを先頭に、1〜10を候補にする）
    candidate_ids = list(range(1, 11))
    try:
        target = get_target_motor_id()
        if target in candidate_ids:
            candidate_ids.remove(target)
        candidate_ids.insert(0, target)
    except ValueError:
        pass

    # 各ボーレートをテスト
    for baudrate in COMMON_BAUDRATES:
        result_text.insert(tk.END, f"ボーレート {baudrate} をテスト中 (ID {candidate_ids[0]}〜)...\n")
        result_text.update()

        found = None
        last_error = "応答なし"
        for motor_id in candidate_ids:
            success, response = test_communication(current_port, baudrate, motor_id, timeout=0.15)
            if success:
                found = (motor_id, response)
                break
            last_error = response

        if found:
            motor_id, response = found
            result_text.insert(tk.END, f"✓ {baudrate}: 成功! ID {motor_id} から応答\n", "success")
            result_text.insert(tk.END, f"  受信データ: {' '.join([f'{b:02X}' for b in response])}\n")

            # 成功したボーレートを選択するボタンを追加
            btn = tk.Button(progress_window,
                          text=f"{baudrate} (ID {motor_id}) を使用",
                          command=lambda b=baudrate, m=motor_id: close_and_set_baudrate(b, m),
                          bg="lightgreen")
            btn.pack(pady=2)

            results.append((baudrate, True, response))
        else:
            result_text.insert(tk.END, f"✗ {baudrate}: 失敗 ({last_error})\n", "error")
            results.append((baudrate, False, last_error))

        result_text.see(tk.END)
        progress_window.update()
    
    if not any(success for _, success, _ in results):
        result_text.insert(tk.END, "\n全てのボーレートで通信に失敗しました。\n", "error")
        result_text.insert(tk.END, "- モーターの電源を確認してください\n")
        result_text.insert(tk.END, "- 配線を確認してください\n")
        result_text.insert(tk.END, "- モーターのボーレート設定を確認してください\n")
    
    # テキストに色を設定
    result_text.tag_config("success", foreground="green")
    result_text.tag_config("error", foreground="red")

FAULT_BIT_NAMES = {
    0: "センサ故障",
    1: "過電流故障",
    2: "相電流過電流",
    3: "ストール故障",
    4: "過温故障",
}

def describe_fault(fault_value):
    """故障コードのビットを日本語名に展開する"""
    names = [name for bit, name in FAULT_BIT_NAMES.items() if fault_value & (1 << bit)]
    return " / ".join(names) if names else "なし"

# 出荷時ID: 4=左, 5=右（モーター本体のラベルと対応）
MOTOR_ID_NAMES = {4: "左", 5: "右"}

def format_motor_id(motor_id):
    """IDを左右名付きで表示する（例: '4 (左)'）"""
    name = MOTOR_ID_NAMES.get(motor_id)
    return f"{motor_id} ({name})" if name else str(motor_id)

def get_target_motor_id():
    """対象モーターID欄の値を取得する（'4 (左)' 形式にも対応）"""
    value = entry_target_id.get()
    try:
        motor_id = int(value.split()[0])
        if not 1 <= motor_id <= 255:
            raise ValueError
    except (ValueError, IndexError):
        raise ValueError(f"対象モーターIDは1〜255の整数で入力してください（現在: {value!r}）")
    return motor_id

def get_motor_info():
    """モーターの状態を取得する（プロトコル2: フィードバック要求 0x74）"""
    try:
        motor_id = get_target_motor_id()
    except ValueError as e:
        messagebox.showerror("IDエラー", str(e))
        return

    try:
        with serial.Serial(get_current_port(), get_current_baudrate(), timeout=1.0) as ser:
            ser.reset_output_buffer()
            print(f"送信コマンド: {' '.join([f'{b:02X}' for b in build_feedback_cmd(motor_id)])}")
            response = query_motor(ser, motor_id, wait=0.3)
            print(f"受信データ: {' '.join([f'{b:02X}' for b in response])}")

            if len(response) == 0:
                raise Exception(
                    f"ID {motor_id} から応答がありません。\n"
                    "- 「IDスキャン」で実際のIDを確認してください\n"
                    "- モーターの電源・配線（A/B線の入れ替わり）を確認してください\n"
                    "- 「ボーレート自動検出」を試してください")

            if len(response) < 10:
                raise Exception(
                    f"レスポンス長が不正: {len(response)}バイト受信（期待値: 10バイト）\n"
                    f"受信データ: {' '.join([f'{b:02X}' for b in response])}\n"
                    "ボーレート不一致の可能性があります")

            frame = response[:10]

            # CRC チェック
            received_crc = frame[9]
            calculated_crc = crc8_maxim(frame[:9])
            if received_crc != calculated_crc:
                raise Exception(
                    f"CRCエラー: 受信={received_crc:02X}, 計算={calculated_crc:02X}\n"
                    f"受信データ: {' '.join([f'{b:02X}' for b in frame])}")

            # プロトコル2応答の解析
            # DATA[2..3]=トルク電流、DATA[4..5]=速度、DATA[6]=巻線温度[℃]、
            # DATA[7]=U8位置値(0〜255が0〜360°に対応)、DATA[8]=故障コード
            id_ = frame[0]
            mode = frame[1]
            current_raw = int.from_bytes(frame[2:4], byteorder="big", signed=True)
            velocity = int.from_bytes(frame[4:6], byteorder="big", signed=True)
            temperature = frame[6]
            position_u8 = frame[7]
            fault_value = frame[8]

            # 電流換算: -32767〜32767 が -8〜8 A に対応
            current = current_raw * 8.0 / 32767.0
            position_deg = position_u8 * 360.0 / 256.0

            # 表示更新
            labels["ID"].config(text=format_motor_id(id_))
            labels["Mode"].config(text=str(mode))
            labels["Current"].config(text=f"{current:.3f} A (raw: {current_raw})")
            labels["Velocity"].config(text=f"{velocity} rpm")
            labels["Temperature"].config(text=f"{temperature} ℃")
            labels["Position"].config(text=f"{position_deg:.1f}° (raw: {position_u8})")
            labels["Fault"].config(text=f"0x{fault_value:02X} ({describe_fault(fault_value)})")

    except Exception as e:
        messagebox.showerror("通信エラー", str(e))

def scan_motor_ids():
    """バス上のモーターIDをスキャンする（プロトコル2でID 1〜20へ問い合わせ）"""
    port = get_current_port()
    baudrate = get_current_baudrate()
    found = []
    try:
        with serial.Serial(port, baudrate, timeout=0.2) as ser:
            ser.reset_output_buffer()
            for motor_id in range(1, 21):
                response = query_motor(ser, motor_id, wait=0.1)
                if len(response) >= 10:
                    frame = response[:10]
                    if frame[9] == crc8_maxim(frame[:9]) and frame[0] == motor_id:
                        found.append(motor_id)
    except Exception as e:
        messagebox.showerror("通信エラー", str(e))
        return

    if found:
        entry_target_id.set(format_motor_id(found[0]))
        messagebox.showinfo("スキャン結果",
                            "応答があったID: " + ", ".join(format_motor_id(m) for m in found) +
                            f"\n対象モーターIDを {format_motor_id(found[0])} に設定しました")
    else:
        messagebox.showwarning("スキャン結果",
                               f"ID 1〜20 から応答がありませんでした ({port}@{baudrate})\n"
                               "「ボーレート自動検出」も試してください")

def set_motor_id():
    new_id = entry_id.get()
    try:
        new_id_int = int(new_id)
        if not 0 <= new_id_int <= 255:
            raise ValueError("0〜255の範囲で入力してください")
    except ValueError as e:
        messagebox.showerror("IDエラー", str(e))
        return

    cmd = bytes([0xAA, 0x55, 0x53, new_id_int] + [0x00]*6)
    try:
        with serial.Serial(get_current_port(), get_current_baudrate(), timeout=0.1) as ser:
            for _ in range(5):
                ser.write(cmd)
                time.sleep(0.05)
        messagebox.showinfo("完了", f"IDを {new_id_int} に変更しました。\n再接続時に有効になります。")
    except Exception as e:
        messagebox.showerror("通信エラー", str(e))


def select_port():
    """ポートを選択する"""
    available_ports = check_port_availability()
    if not available_ports:
        messagebox.showwarning("警告", "利用可能なポートがありません")
        return
    
    # ポート選択ダイアログ
    selection_window = tk.Toplevel(root)
    selection_window.title("ポート選択")
    selection_window.geometry("300x200")
    
    tk.Label(selection_window, text="使用するポートを選択してください:").pack(pady=10)
    
    selected_port = tk.StringVar(value=available_ports[0])
    for port in available_ports:
        tk.Radiobutton(selection_window, text=port, variable=selected_port, value=port).pack(anchor="w", padx=20)
    
    def confirm_selection():
        get_current_port.selected_port = selected_port.get()
        selection_window.destroy()
        refresh_port_status()
        messagebox.showinfo("確認", f"ポート {selected_port.get()} を選択しました")
    
    tk.Button(selection_window, text="確定", command=confirm_selection).pack(pady=10)

def select_baudrate():
    """ボーレートを選択する"""
    selection_window = tk.Toplevel(root)
    selection_window.title("ボーレート選択")
    selection_window.geometry("300x400")
    
    tk.Label(selection_window, text="使用するボーレートを選択してください:").pack(pady=10)
    
    selected_baudrate = tk.StringVar(value=str(get_current_baudrate()))
    for baudrate in COMMON_BAUDRATES:
        tk.Radiobutton(selection_window, text=str(baudrate), variable=selected_baudrate, value=str(baudrate)).pack(anchor="w", padx=20)
    
    def confirm_selection():
        get_current_baudrate.selected_baudrate = int(selected_baudrate.get())
        selection_window.destroy()
        refresh_port_status()
        messagebox.showinfo("確認", f"ボーレート {selected_baudrate.get()} を選択しました")
    
    tk.Button(selection_window, text="確定", command=confirm_selection).pack(pady=10)

# GUI
root = tk.Tk()
root.title("モーター状態表示 & ID設定")
root.geometry("400x420")

main_container = ttk.Frame(root)
main_container.pack(fill="both", expand=True)

canvas = tk.Canvas(main_container, highlightthickness=0)
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


def scroll_up(event):
    canvas.yview_scroll(-1, "units")


def scroll_down(event):
    canvas.yview_scroll(1, "units")


scrollable_frame.bind("<Configure>", update_scroll_region)
canvas.bind("<Configure>", resize_scrollable_frame)
canvas.bind_all("<MouseWheel>", scroll_with_mousewheel)
canvas.bind_all("<Button-4>", scroll_up)
canvas.bind_all("<Button-5>", scroll_down)
canvas.pack(side="left", fill="both", expand=True)
scrollbar.pack(side="right", fill="y")

frame_info = ttk.LabelFrame(scrollable_frame, text="モーター情報", padding=10)
frame_info.pack(padx=10, pady=10, fill="x")

labels = {}
for i, key in enumerate(["ID", "Mode", "Current", "Velocity", "Temperature", "Position", "Fault", "Port Status"]):
    ttk.Label(frame_info, text=f"{key}:").grid(row=i, column=0, sticky="e")
    labels[key] = ttk.Label(frame_info, text="---")
    labels[key].grid(row=i, column=1, sticky="w")

ttk.Label(frame_info, text="対象モーターID:").grid(row=8, column=0, sticky="e")
entry_target_id = ttk.Combobox(frame_info, width=8,
                               values=[format_motor_id(m) for m in MOTOR_ID_NAMES])
entry_target_id.set(format_motor_id(4))
entry_target_id.grid(row=8, column=1, sticky="w")

ttk.Button(frame_info, text="情報更新", command=get_motor_info).grid(row=9, columnspan=2, pady=5)
ttk.Button(frame_info, text="IDスキャン", command=scan_motor_ids).grid(row=10, columnspan=2, pady=2)
ttk.Button(frame_info, text="ポート状態更新", command=refresh_port_status).grid(row=11, columnspan=2, pady=5)
ttk.Button(frame_info, text="ポート選択", command=select_port).grid(row=12, columnspan=2, pady=2)
ttk.Button(frame_info, text="ボーレート選択", command=select_baudrate).grid(row=13, columnspan=2, pady=2)
ttk.Button(frame_info, text="ボーレート自動検出", command=auto_detect_baudrate, style="Accent.TButton").grid(row=14, columnspan=2, pady=5)

frame_set = ttk.LabelFrame(scrollable_frame, text="ID設定", padding=10)
frame_set.pack(padx=10, pady=10, fill="x")

ttk.Label(frame_set, text="新しいID (0〜255):").pack(side="left")
entry_id = ttk.Entry(frame_set, width=10)
entry_id.pack(side="left", padx=5)

ttk.Button(frame_set, text="ID変更", command=set_motor_id).pack(side="left", padx=5)

# ポート状態表示用ラベル
port_list = tk.StringVar()
ttk.Label(scrollable_frame, textvariable=port_list, foreground="blue").pack(pady=5)

refresh_port_status()  # 初期状態のポートチェック
root.mainloop()
