import tkinter as tk
from tkinter import ttk, messagebox
import serial
import serial.tools.list_ports
import time

PORT = "/dev/ttyACM0"  # 使用しているRS485ポートに変更
BAUDRATE = 57600
# ボーレート設定（9600から100ずつ増加）
#COMMON_BAUDRATES = list(range(9600, 115200, 100))  # 9600, 9700, 9800, ..., 19900

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

def test_communication(port, baudrate, timeout=0.5):
    """指定されたポートとボーレートで通信テストを行う"""
    try:
        with serial.Serial(port, baudrate, timeout=timeout) as ser:
            # シリアルバッファをクリア
            ser.reset_input_buffer()
            ser.reset_output_buffer()
            
            # ID check コマンド
            cmd = bytes([0xC8, 0x64] + [0x00]*7)
            crc = crc8_maxim(cmd)
            cmd += bytes([crc])
            
            ser.write(cmd)
            ser.flush()
            time.sleep(0.1)
            
            response = ser.read(10)
            if len(response) == 10:
                # CRC チェック
                received_crc = response[9]
                calculated_crc = crc8_maxim(response[:9])
                if received_crc == calculated_crc:
                    return True, response
                else:
                    return False, f"CRCエラー"
            else:
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
    
    def close_and_set_baudrate(baudrate):
        get_current_baudrate.selected_baudrate = baudrate
        progress_window.destroy()
        refresh_port_status()
        messagebox.showinfo("検出完了", f"ボーレート {baudrate} に設定しました")
    
    # 各ボーレートをテスト
    for i, baudrate in enumerate(COMMON_BAUDRATES):
        result_text.insert(tk.END, f"ボーレート {baudrate} をテスト中...\n")
        result_text.update()
        
        success, response = test_communication(current_port, baudrate)
        
        if success:
            result_text.insert(tk.END, f"✓ {baudrate}: 成功! データ受信\n", "success")
            result_text.insert(tk.END, f"  受信データ: {' '.join([f'{b:02X}' for b in response])}\n")
            
            # 成功したボーレートを選択するボタンを追加
            btn = tk.Button(progress_window, 
                          text=f"{baudrate} を使用", 
                          command=lambda b=baudrate: close_and_set_baudrate(b),
                          bg="lightgreen")
            btn.pack(pady=2)
            
            results.append((baudrate, True, response))
        else:
            result_text.insert(tk.END, f"✗ {baudrate}: 失敗 ({response})\n", "error")
            results.append((baudrate, False, response))
        
        result_text.see(tk.END)
        progress_window.update()
        time.sleep(0.1)  # 少し待機
    
    if not any(success for _, success, _ in results):
        result_text.insert(tk.END, "\n全てのボーレートで通信に失敗しました。\n", "error")
        result_text.insert(tk.END, "- モーターの電源を確認してください\n")
        result_text.insert(tk.END, "- 配線を確認してください\n")
        result_text.insert(tk.END, "- モーターのボーレート設定を確認してください\n")
    
    # テキストに色を設定
    result_text.tag_config("success", foreground="green")
    result_text.tag_config("error", foreground="red")

def get_motor_info():
    """モーターの状態をチェックする（ID check コマンド使用）"""
    try:
        with serial.Serial(get_current_port(), get_current_baudrate(), timeout=1.0) as ser:
            # シリアルバッファをクリア
            ser.reset_input_buffer()
            ser.reset_output_buffer()
            
            # ID check コマンド: 0xC8, 0x64, その後は0埋め、最後にCRC8
            cmd = bytes([0xC8, 0x64] + [0x00]*7)
            crc = crc8_maxim(cmd)
            cmd += bytes([crc])
            
            print(f"送信コマンド: {' '.join([f'{b:02X}' for b in cmd])}")
            
            # コマンド送信
            ser.write(cmd)
            ser.flush()  # 送信バッファを強制的にフラッシュ
            
            # 応答待ち時間を長めに設定
            time.sleep(0.1)
            
            # バイト数を段階的にチェック
            available_bytes = ser.in_waiting
            print(f"利用可能バイト数: {available_bytes}")
            
            if available_bytes == 0:
                # もう少し待ってみる
                time.sleep(0.1)
                available_bytes = ser.in_waiting
                print(f"再チェック後の利用可能バイト数: {available_bytes}")
            
            # 全ての利用可能なデータを読み取り
            if available_bytes > 0:
                response = ser.read(available_bytes)
                print(f"受信データ: {' '.join([f'{b:02X}' for b in response])}")
            else:
                response = ser.read(10)  # タイムアウトまで待機
                print(f"タイムアウト後受信データ: {' '.join([f'{b:02X}' for b in response])}")

            if len(response) == 0:
                raise Exception("モーターからの応答がありません。\n- モーターの電源を確認してください\n- 配線を確認してください\n- ボーレートが正しいか確認してください")
            
            if len(response) != 10:
                raise Exception(f"レスポンス長が不正: {len(response)}バイト受信（期待値: 10バイト）\n受信データ: {' '.join([f'{b:02X}' for b in response])}")

            data = list(response)
            
            # CRC チェック
            received_crc = data[9]
            calculated_crc = crc8_maxim(bytes(data[:9]))
            if received_crc != calculated_crc:
                raise Exception(f"CRCエラー: 受信={received_crc:02X}, 計算={calculated_crc:02X}")

            # フィードバックデータの解析
            # Protocol 1 応答は DATA[2..3]=電流、DATA[4..5]=速度、DATA[6..7]=位置、
            # DATA[8]=故障コード。温度はこの応答には含まれない。
            id_ = data[0]
            mode = data[1]
            current_raw = int.from_bytes(response[2:4], byteorder="big", signed=True)
            velocity = int.from_bytes(response[4:6], byteorder="big", signed=True)
            position_raw = int.from_bytes(response[6:8], byteorder="big", signed=False)
            fault_value = data[8]

            # データの変換
            current = current_raw / 1000.0  # mA → A

            # 表示更新
            labels["ID"].config(text=str(id_))
            labels["Mode"].config(text=str(mode))
            labels["Current"].config(text=f"{current:.3f} A (raw: {current_raw})")
            labels["Velocity"].config(text=f"{velocity} rpm")
            labels["Temperature"].config(text="N/A (not in this response)")
            labels["Position"].config(text=f"0x{position_raw:04X}")
            labels["Fault"].config(text=f"0x{fault_value:02X}")

    except Exception as e:
        messagebox.showerror("通信エラー", str(e))

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

ttk.Button(frame_info, text="情報更新", command=get_motor_info).grid(row=8, columnspan=2, pady=5)
ttk.Button(frame_info, text="ポート状態更新", command=refresh_port_status).grid(row=9, columnspan=2, pady=5)
ttk.Button(frame_info, text="ポート選択", command=select_port).grid(row=10, columnspan=2, pady=2)
ttk.Button(frame_info, text="ボーレート選択", command=select_baudrate).grid(row=11, columnspan=2, pady=2)
ttk.Button(frame_info, text="ボーレート自動検出", command=auto_detect_baudrate, style="Accent.TButton").grid(row=12, columnspan=2, pady=5)

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
