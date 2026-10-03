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
| `reason` | `string` | 原因(例: `"pin 5 not received; "`、`"pin 27 is false, expected true; "`、`"pin 27 timeout; "`)。解除時は `"released"` |

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
| `velocity_rpm` | `int16` | 実測輪速 [RPM](DATA[4..5], 符号付き)。`measured_lpf_tau_sec > 0` のときはローパス済み(既定 tau=0.15s) |
| `velocity_rpm_raw` | `int16` | 実測輪速のフィルタ前生値 [RPM]。同定・振動解析用(ローパス済み値はファーム速度ループの ~1.8Hz 振動を約半分に見せる) |
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
  すなわち GPIO 更新毎(公称 ~20 Hz)+ 100 ms watchdog timer。
  `active = !controllable`。
- **発行元は常に起動する**: operation_manager は drive/shot の有無にも `enable_gpio_ref` にも
  依存せず `questix_core.launch.xml` から常に起動する(standalone
  `joy_controller_referee.launch.xml` も互換性のため起動できる)。
  - `enable_gpio_ref=true`(production の practice / competition 起動は常にこれ): GPIO を判定し `active = !controllable`。
    reason は `pin 5 ...`(物理 E-stop)/ `pin 27 ...`(AutoReferee)で入力を区別する。
  - `enable_gpio_ref=false`(手動の明示的な診断起動のみ。production ランチャーは使わない。`operation_manager.no_gpio.yaml`、
    `gpio_safety_enabled: false`): GPIO を読まず `/gpio/controllable` も出さない。
    `active=false`、reason `released (no GPIO safety path)` を 100 ms 毎に出す。
- **未受信はフェイルクローズ**: 購読側(drive_component / shot_component / esc_motor_control は
  共通の `questix_safety::EmergencyStopMonitor`、QUESTiX LAB ブリッジ)は構成によらず、**一度も受信していない間は「非常停止の状態が不明」
  として動かさない**(`require_emergency_stop: true`)。受信状態はモータとの通信
  (フィードバックの取得)とは別で、drive_component は動かさないまま実測の取得を続ける。
- **staleness 検出**: 購読側は「一度以上受信した後に」`emergency_stop_timeout_sec`
  (既定 1.0 s、自分の単調時計による受信間隔)を超えて受信が途絶えたら、押下と同じく停止して
  動かさない。受信が戻っても、解除だけでは動き出さない(新しい指令が必要)。
- **診断用の明示 opt-out**: 単体の診断起動に限り `require_emergency_stop:=false` で未受信を
  許せる(押下を受信したときの停止はそのまま)。統合構成は opt-out しない。

## 復帰挙動(active=false 受信時)

全購読者とも**自動復帰**。ただしモータが勝手に動き出すことはない。

| 購読者 | 停止時(active=true) | 解除時(active=false) |
|---|---|---|
| `drive_component` | 停止指令をスロットル無しで即時送信 + 目標を破棄。以後の `/target_twist` は無視。停止指令を送れなかったら stop fault(送信に成功するまで動かさない) | `/target_twist` 受付再開。モータは解除**後**に届いた次の twist コマンドまで停止のまま |
| `shot_component` | deactivate→cleanup でサーボバス解放(unconfigured へ) | auto-start 再アーム。configure→activate を自動リトライ(実行時許可が必要な構成では許可も必要) |
| `esc_motor_control` | `set_motor_speed(0.0)` 即時実行。停止中はボタン入力を無視 | フルスピードボタンの**離す→押す**まで 0 のまま(押しっぱなしでは再始動しない)。教材入力は 0 を受けるまでロック |

## `/actuation_authority` トピック契約(練習時の実行時許可)

教員の許可(teacher permission)。ノードのパラメータとコードは `teacher_permission`
(`require_teacher_permission`、`teacher_permission_topic`、`teacher_permission_timeout_sec`)で
呼ぶ。トピック名 `/actuation_authority` と型 `ActuationAuthority` は、記録済みの rosbag と
Robot Manager との互換のためそのまま。

- **型**: `questix_msgs/msg/ActuationAuthority`(`drive_allowed`, `launcher_allowed`)
- **QoS**: reliable + **volatile** + keep-last(1)。**transient_local にしない**(許可をラッチしない)。
- **発行元**: Robot Manager(教員が「ロボットの走行制御」「発射機構の操作」を ON にしている間だけ、
  約 5 Hz)。Robot Manager の起動・Pi の再起動・練習モードへの切替・大会モードへの切替・
  「すべて止める」・Robot Manager の終了ではすべて OFF から始まる/OFF になる。
- **非常停止とは別の概念**: 教員の許可は「動かしてよいか」の許可で、非常停止ではない。既定では
  Robot Manager の中で QUESTiX LAB(教材)の走行・発射の許可の前提として使うだけで、
  drive_component / shot_component / esc_motor_control はこれを見ずにコントローラで動く(3.2.0 と同じ)。
- **購読側(opt-in)**: `questix_core` の `require_teacher_permission:=true`(練習のみ、既定 false、
  環境変数からは読まない)を明示したときだけ、
  drive_component / shot_component / esc_motor_control は、自分の単調時計で
  `teacher_permission_timeout_sec`(既定 1.0 s)以内に受信した `*_allowed=true` がある間だけ動かす。
  未受信・false・途絶はすべて OFF。OFF になったら停止(drive: 即時停止 + 目標破棄、
  shot: 安全 teardown、ESC: 0 + ラッチ解除)。許可が戻っても、それだけでは動き出さない。
- **大会起動**(`enable_autoreferee:=true`)は opt-in しても常に `require_teacher_permission:=false`。
  AutoReferee と GPIO 安全系は従来どおりで、教室用の heartbeat が無くても止まらない。
- 非常停止とは別の理由として扱う(許可の喪失を非常停止に見せかけない)。

## 型付きステータストピック契約

`MotorFeedback` / `DriveStatus` は下記のトピックで publish される
(QoS はいずれも reliable + volatile、旧 String トピックと同じ keep-last 深さ)。

| トピック | 型 | 発行元 | 備考 |
|---|---|---|---|
| `/drive_status` | `DriveStatus` | `drive_component` | `status_publish_rate`(既定 10 Hz)。lifecycle ACTIVE 時のみ |
| `single_ddt_motor_feedback` | `MotorFeedback` | `single_ddt_motor` | 相対名。launch で `/single_ddt_motor_feedback` に remap |
| `joy_axis_drive_status` | `DriveStatus` | `joy_axis_drive` | 相対名。`linear/angular_velocity = 0.0` |
| `/diagnostics` | `diagnostic_msgs/DiagnosticArray` | `operation_manager` | 標準集約トピック。rqt_runtime_monitor が設定なしで表示 |

`operation_manager` の GPIO27 診断には `pin_27_signal_limit` が含まれる。
GPIO27=`true` は許可だけでなく、AutoReferee未接続、クライアント無通電、
一次側断線でも発生し、現行ハードウェアでは区別できないことを示す。

## モータ調整時のフィードバック監視

DDT モータの調整中は、上記トピックを購読して current / velocity / position / fault を確認する。
QUESTiX Launcher / `drive_component` 起動中でも、`/dev/ttyACM0` を別プロセスから直接開かずに
安全にモニタリングできる(シリアル直開きは Launcher 側の応答と混線するため不可)。

- **推奨(ライブ表示 CLI)**: モータ ID ごとに整形テーブルをその場更新表示する読み取り専用ツール。

  ```bash
  ros2 run motor_control_app ddt_feedback_monitor
  # 例: 単体モータも併せて監視し、更新レートを上げる
  ros2 run motor_control_app ddt_feedback_monitor --ros-args \
    -p motor_feedback_topics:="['/single_ddt_motor_feedback']" -p rate_hz:=10.0
  ```

  パラメータ: `drive_status_topics`(既定 `['/drive_status']`) / `motor_feedback_topics`(既定 `[]`)は
  複数指定可。`rate_hz`(既定 5.0) / `stale_sec`(既定 0.5) / `color`(既定 true)。`Age[s]` に `!` が
  付くと鮮度切れ、`--` は未受信(`header.stamp == 0`)。**副作用なし(購読のみ)**。

- **簡易確認**: `ros2 topic echo /drive_status` / `ros2 topic hz /drive_status`。

- **`ddt_checker.py`**(リポジトリ直下の Tkinter 診断ツール)は `/dev/ttyACM0` を直接開くため、
  **Launcher / `drive_component` 停止中のメンテナンス専用**(PR #68 の整理どおり)。運転中の監視には
  上記 CLI を使うこと。

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
