# web_joy_driver

PC・iPhone・iPad・Android のブラウザから QUESTiX を操作するための仮想コントローラです。
Android アプリのインストールは不要です。
Pi 上で HTTP + WebSocket サーバを立て、ブラウザのバーチャルスティック／ボタン入力を
`sensor_msgs/Joy` として `/joy` に配信します。

- 配列は `uart_joy_driver` と同じ **Switch2 ネイティブ配列** なので、
  `shot_config.uart.yaml` / `esc_motor_control_cpp.uart.yaml` がそのまま適用されます。
- 下流（`joy_gate` → `joy_controller` / `shot_component` / `esc_motor_control`）は無変更。
  GPIO 非常停止によるゲートもそのまま効きます。
- 無通信 `message_timeout_sec`（既定 0.5 s）でニュートラルを配信する watchdog 付き。

## 使い方

```bash
# 単体起動
ros2 launch web_joy_driver web_joy_driver.launch.xml

# 統合起動（joy ソースを web に切り替え）
ros2 launch questix_launcher questix_core.launch.xml controller_type:=web
```

`launch.env` では `CONTROLLER_TYPE=web`（`robot_manager` の「コントローラー」から選択可）。

操作する端末を Pi と同じネットワークに載せ、`http://<robot-ip>:8899/` を開きます。
`auth_token` を設定した場合は `http://<robot-ip>:8899/?token=<value>`。
管理画面の「ブラウザ・スマホで操作」から「ブラウザで操作」を押しても開けます。
スマホのカメラで管理画面の QR を読み取って開くこともできます。

### PC のキーボード操作

画面上部の「操作方法」で **キーボード** を選び、**Space を先に押して保持**しながら操作キーを押します。
キーはキーボード上の位置（英字配列の表示）で判定します。

| キー | 操作 |
| --- | --- |
| W / A / S / D または矢印 | 前後・左右移動（斜め入力は長さ 1 に正規化） |
| Q / E | 左 / 右旋回 |
| I / K | TILT ▲ / ▼ |
| F | FIRE |
| R | ROLLER（保持） |
| Space を離す / Esc /「入力を解除」 | この端末の全入力をニュートラルに戻す |

キーボード入力の大きさは最大 1、速度の倍率は既存の ROS 設定に従います。
タッチ・マウス操作との同時入力はできません。操作方法の切り替え時にも全入力を解除します。
Space の押し直しだけでは以前の操作は再開しません。操作キーも離して押し直してください。
「入力を解除」はこのページの入力解除であり、GPIO 非常停止の代わりではありません。

### iPhone・iPad / タッチ・マウス操作

「タッチ・マウス」を選び、スティックをドラッグ、各ボタンは押している間だけ入力します。
タッチでは複数の指で移動・旋回・ボタンを同時操作できます。縦・横向きにレイアウトが切り替わります。
全画面ボタンはブラウザが対応する場合に表示します。消灯防止が使えない場合は端末側で画面の消灯時間を調整してください。

## 画面

| 領域 | 出力 |
| --- | --- |
| 左半分（浮動スティック） | axes[0]=LX, axes[1]=LY（左/上 = +1） |
| 右下（浮動スティック） | axes[3]=RX（旋回）, axes[4]=RY |
| TILT ▲ / TILT ▼ | buttons[4]=L / buttons[6]=ZL |
| FIRE | buttons[5]=R |
| ROLLER（押している間） | buttons[7]=ZR |

割り当ては `static/index.html` 冒頭の `LAYOUT` で変更できます。

## プロトコル

- `GET /` : 操作ページ（単一 HTML、ビルド不要）
- `GET /ws` (WebSocket) : ブラウザ → ノードへ JSON テキスト

```json
{"type": "joy", "axes": [lx, ly, 0, rx, ry, 0, dh, dv], "buttons": [0, 1, ...]}
```

  短い配列は 0 で補完、長すぎる配列・非数値・NaN は破棄（警告ログ）。
  ブラウザは入力変化時に即送信し、加えて 100 ms ごとに現在値を再送します。

- ノード → ブラウザ: `{"type":"status", "hold": "active|timeout|released", "rx_age_ms", "estop", "estop_reason", "controller", "clients"}` を `status_period_sec` ごとに送信。
  `estop` は `/emergency_stop`（`questix_msgs/EmergencyStop`）の表示用リレーで、ゲートには使いません。

### 操作権

最後に接続したクライアントが操作権を持ちます。前のクライアントには
`{"type":"released","reason":"taken_over"}` を送ってから切断します（close code 4000）。
Wi-Fi 切断後の再接続をシンプルにするための仕様で、引き継がれた側は自動再接続しません。

### 安全動作

| 事象 | ノード側 | ブラウザ側 |
| --- | --- | --- |
| フレーム途絶（Wi-Fi 断・バックグラウンド） | `message_timeout_sec` 後にニュートラル配信、警告ログ | 自動再接続（0.5〜5 s バックオフ） |
| WebSocket 切断 | 即ニュートラル | 全入力を解除して再接続。以前の入力を復元しない |
| ページが非表示 / blur | ― | 全入力を離してニュートラルを送信 |
| 操作権の引き継ぎ | 新しいクライアントの入力を採用 | 全入力を解除。自動再接続しない |

接続前・切断中・非表示・フォーカスがない間の操作は受け付けません。
非表示中の再接続は保留し、ページへ戻ったときに再開します。

## パラメータ

`config/web_joy_driver_params.yaml` が Single Source of Truth です。主なもの:

| 名前 | 既定 | 説明 |
| --- | --- | --- |
| `joy_topic` | `/joy` | 出力トピック |
| `host` / `port` | `0.0.0.0` / `8899` | bind アドレス / ポート |
| `auth_token` | `""` | 空で認証なし。LAN 共有時は設定推奨 |
| `publish_rate` | `50.0` | Joy 再送周期 (Hz) |
| `message_timeout_sec` | `0.5` | 無通信でニュートラルに戻すまでの秒数 |
| `deadzone` | `0.05` | 軸のデッドゾーン |
| `num_axes` / `num_buttons` | `8` / `14` | 配列長（Switch2 配列） |
| `ping_interval_sec` / `ping_timeout_sec` | `1.0` / `2.0` | WebSocket keepalive |
| `close_timeout_sec` | `1.0` | 切断ハンドシェイクの上限。読まなくなった端末を引きずらないため |
| `static_dir` | `""` | `index.html` の場所（空 = share ディレクトリ） |
| `emergency_stop_topic` | `/emergency_stop` | 表示用 E-stop 購読。`""` で無効 |

## 依存

- `python3-websockets`（Ubuntu 24.04 の 10.x と、13 以降の `websockets.asyncio` API の両方に対応）
- `rclpy`, `sensor_msgs`, `questix_msgs`

## テスト

```bash
colcon test --packages-select web_joy_driver
# または
cd web_joy_driver && python3 -m pytest test
# リポジトリルートからブラウザ入力・再接続のテスト（Node.js）
node --test web_joy_driver/test/test_browser_controller.cjs
```

`test_ws_server.py` はインストールされている `websockets` に対する結合テストです。


## Android アプリと接続用 QR

全画面表示と表示中の消灯防止には、[QUESTiX Android コントローラー](../android/README.md) を利用できます。
接続先 URL の手入力・保存と、管理画面に表示した QR の読み取りに対応しています。
管理画面の「ブラウザ・スマホで操作」で `http://<robot-ip>:8899/` を指定し、接続用 QR を生成してください。
アプリがバックグラウンドに移ると操作ページを閉じ、復帰後は明示的な再接続が必要です。
