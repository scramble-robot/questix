# questix_msgs

QUESTiX 共通メッセージ定義パッケージ。統一緊急停止インターフェイス
`/emergency_stop` と型付きステータストピックの一次文書はこの README です。

## メッセージ

### `EmergencyStop.msg`

| フィールド | 型 | 意味 |
|---|---|---|
| `header` | `std_msgs/Header` | `stamp` = 判定時刻。`frame_id` は未使用(`""`) |
| `active` | `bool` | `true` = 緊急停止発動 |
| `source` | `string` | 発行元識別子(例: `"operation_manager"`) |
| `reason` | `string` | 原因(例: `"pin 27 is false; "`、`"pin 27 timeout; "`)。解除時は `"released"` |

### `MotorFeedback.msg`

DDT M0602C の Protocol 1 応答フレームをデコードした 1 モータ分のフィードバック。
マルチバイトのワイヤフィールドはビッグエンディアン(high, low)で、デコードは
`motor_control_lib/ddt_protocol` に集約されている。

| フィールド | 型 | 意味 |
|---|---|---|
| `header` | `std_msgs/Header` | `stamp` = 最終有効フィードバックの受信時刻。`stamp == 0` は未受信(この場合 `motor_id`/`target_rpm` 以外は 0) |
| `motor_id` | `uint8` | DDT モータ ID(DATA[0]) |
| `mode` | `uint8` | ファーム報告の制御モード(DATA[1])。定数 `MODE_CURRENT_LOOP=1` / `MODE_VELOCITY_LOOP=2` |
| `current_raw` | `int16` | トルク電流の生値(DATA[2..3], 符号付き)。-32767..32767 ↔ -8..+8 A |
| `current_amp` | `float32` | `current_raw * 8.0 / 32767.0` [A] |
| `velocity_rpm` | `int16` | 実測輪速 [RPM](DATA[4..5], 符号付き) |
| `target_rpm` | `int16` | 最終指令値 [RPM](`max_motor_rpm` でクランプ後) |
| `position_raw` | `uint16` | ロータ位置(DATA[6..7])。0..32767 ↔ 0..360 deg |
| `temperature` | `uint8` | [deg C] **現状常に 0**。DDT Protocol 2 (0x74) 未実装。実装時にフィールドを変えずに済むよう定義だけ残している |
| `fault_code` | `uint8` | DATA[8]。0 = 正常、非0 = ファーム故障ビット |

### `DriveStatus.msg`

差動二輪の状態。左右ホイールの `MotorFeedback` と車体速度をまとめる。

| フィールド | 型 | 意味 |
|---|---|---|
| `header` | `std_msgs/Header` | `stamp` = publish 時刻。`frame_id` は未使用(`""`) |
| `left` / `right` | `MotorFeedback` | 左右ホイールのフィードバック(各 `stamp` は個別の受信時刻) |
| `linear_velocity` | `float64` | [m/s] 実測輪速から算出 |
| `angular_velocity` | `float64` | [rad/s] 実測輪速から算出 |
| `emergency_stop` | `bool` | 発行ノードの緊急停止フラグ |

全体 healthy 判定は `left.fault_code == 0 && right.fault_code == 0` で導出する
(専用フィールドは持たない)。`joy_axis_drive` は車輪ジオメトリのパラメータを持たない
ため `linear_velocity = angular_velocity = 0.0` を publish する。

## `/emergency_stop` トピック契約

- **型**: `questix_msgs/msg/EmergencyStop`
- **QoS**: reliable + transient_local + keep-last(1)
  (`rclcpp::QoS(1).reliable().transient_local()`)。
  購読側も同一 QoS を使うこと。late-join した購読者は最新のラッチ状態を即時受信する。
- **発行元**: `operation_manager`。GPIO controllability 判定
  (`evaluate_controllability()`)の毎回実行時に発行する。
  すなわち GPIO 更新毎(公称 ~20 Hz)+ 1 秒周期タイマーがハートビート下限。
  `active = !controllable`。
- **発行者不在環境**: operation_manager は `enable_gpio_ref=true` の構成
  (`joy_controller_referee.launch.xml`)でのみ起動する。購読側は
  メッセージを一度も受信していない間は通常動作を継続しなければならない
  (発行者不在で停止してはならない)。
- **staleness 検出**: 購読側は「一度以上受信した後に」タイムアウト
  (推奨 1.0 s)を超えて受信が途絶えた場合をフェイルセーフ条件として
  扱ってよい(shot_component が実装)。

## 復帰挙動(active=false 受信時)

全購読者とも**自動復帰**。ただしモータが勝手に動き出すことはない。

| 購読者 | 停止時(active=true) | 解除時(active=false) |
|---|---|---|
| `drive_component` | フラグ設定 + `diff_drive_->stop()` を即時実行(best-effort)。以後の `/target_twist` は無視 | フラグ解除。`/target_twist` 受付再開。モータは次の twist コマンドまで停止のまま |
| `shot_component` | deactivate→cleanup でサーボバス解放(unconfigured へ) | auto-start 再アーム。configure→activate を自動リトライ |
| `esc_motor_control` | フラグ設定 + `set_motor_speed(0.0)` 即時実行。停止中はボタン入力を無視 | フラグ解除。フルスピードボタンの**新たな押下エッジ**まで 0 のまま(押しっぱなしでは再始動しない) |

## 型付きステータストピック契約

`MotorFeedback` / `DriveStatus` は下記のトピックで publish される
(QoS はいずれも reliable + volatile、旧 String トピックと同じ keep-last 深さ)。

| トピック | 型 | 発行元 | 備考 |
|---|---|---|---|
| `/drive_status` | `DriveStatus` | `drive_component` | `status_publish_rate`(既定 10 Hz)。lifecycle ACTIVE 時のみ |
| `single_ddt_motor_feedback` | `MotorFeedback` | `single_ddt_motor` | 相対名。launch で `/single_ddt_motor_feedback` に remap |
| `joy_axis_drive_status` | `DriveStatus` | `joy_axis_drive` | 相対名。`linear/angular_velocity = 0.0` |
| `/diagnostics` | `diagnostic_msgs/DiagnosticArray` | `operation_manager` | 標準集約トピック。rqt_runtime_monitor が設定なしで表示 |

## 移行メモ

- 旧 String ステータストピックと ESC の `/roller_emergency_status`(`std_msgs/Bool`)は
  v2.2.0 で上表の型付きトピックと 1 リリース並行 publish したのち削除済み(#87)。
  購読は下表の置換先を使うこと。
  | 削除された旧トピック | 型 | 発行元 | 置換先 |
  |---|---|---|---|
  | `/drive_motor_status` | `std_msgs/String`(JSON) | `drive_component` | `/drive_status` |
  | `motor_status` | `std_msgs/String`(自由文) | `single_ddt_motor` | `single_ddt_motor_feedback` |
  | `motor_status` | `std_msgs/String`(JSON) | `joy_axis_drive` | `joy_axis_drive_status` |
  | `/gpio/controllable_diagnostic` | `std_msgs/String`(自由文) | `operation_manager` | `/diagnostics` |
  | `/roller_emergency_status` | `std_msgs/Bool`(transient_local) | `esc_motor_control` | `/emergency_stop`(`active`) |
- `joy_gate` は従来どおり `/gpio/controllable` を購読する(スコープ外)。
- drive_component の受信 staleness タイムアウトは未実装
  (既存のコマンド watchdog と物理電源断がフェイルセーフを担う)。
  ハートビートを利用したタイムアウト追加はフォローアップ候補。
