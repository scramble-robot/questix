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
| `position_raw` | `uint16` | ロータ位置(DATA[6..7])。0..32767 ↔ 0..360 deg。エンコーダの実分解能は 1 回転 4096 で、値は 8 LSB 刻みで動く。電源投入をまたいで絶対位置かどうかは未確認 |
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

### `DriveControlSample.msg` / `DriveControlWheelSample.msg`

`drive_component` の制御 tick 1 回ぶんの記録(**診断専用**)。tick が決めたこと(整形後の車体指令・
補正前の車輪目標・送った指令)と、その tick の送受信で各モータから返ってきたものを 1 メッセージに
まとめる。

| フィールド | 型 | 意味 |
|---|---|---|
| `header` | `std_msgs/Header` | `stamp` = この制御 tick の開始時刻(ノードの時計)。`frame_id` は未使用(`""`) |
| `seq` | `uint32` | tick ごとに +1(ノード起動時 0)。飛びは欠落 |
| `control_period_sec` | `float64` | 公称周期 `1 / control_rate` [s] |
| `tick_duration_sec` | `float64` | この tick の所要時間 [s](シリアル送受信を含む)。`control_period_sec` 超過は overrun |
| `control_mode` | `string` | `"velocity"` / `"current"` |
| `drive_mode` | `uint8` | tick 後の走行状態。`DRIVE_MODE_STOP=0` / `CREEP=1` / `RUN=2` |
| `tick_action` | `uint8` | tick の動作。`TICK_IDLE=0`(未武装・ゲートが閉) / `TICK_DRIVE=1` / `TICK_TIMEOUT_STOP=2` / `TICK_FAULT_STOP=3` |
| `lqr_active` | `bool` | velocity RUN 域 LQR+FF の補正をこの tick に適用したか |
| `shaped_linear` / `shaped_angular` | `float64` | 加速度制限・テーパー後の車体指令 [m/s] / [rad/s](REP-103) |
| `command_sent` | `bool` | tick の指令(駆動・停止・安全停止)を両輪に書けたか。idle tick は安全停止をしたときだけ true(フィードバック取得のための停止フレーム再送は指令に含めない) |
| `stop_frame` | `bool` | tick の指令が停止フレーム(目標 0)だったか |
| `left` / `right` | `DriveControlWheelSample` | 車輪ごと(下表) |

`DriveControlWheelSample`(rpm・電流・位置は**モータ固有の符号のまま**。左は前進が正、右は前進が負):

| フィールド | 型 | 意味 |
|---|---|---|
| `ref_rpm` | `int32` | 補正前の車輪目標 [rpm](整形 → 運動学 → 整数化) |
| `command_rpm` | `int32` | ライブラリへ渡した速度指令 [rpm](LQR 補正後、停止フレームは 0。送信時に `max_motor_rpm` でクランプ)。current モードではホスト PI の参照(参考値) |
| `command_current_raw` | `int16` | current モード: 最後に送信成功した電流指令 raw(この tick に送っていなければドライバが保持しているはずの値)。velocity モードは 0 |
| `feedback_new` | `bool` | **この tick の送受信で**新しい有効フィードバックを受信したか。false ならワイヤ値は前のフレームの繰り返し |
| `feedback_count` | `uint32` | このモータから受信した有効フレームの累積数(2^32 で巡回) |
| `feedback_stamp` | `builtin_interfaces/Time` | 最後の有効フレームの受信時刻(ノードの時計)。0 = 未受信 |
| `roundtrip_ms` | `float32` | この tick の、このモータとの最後の送受信の往復時間 [ms](書込開始 → 応答受信完了)。送受信なし・応答なしは NaN |
| `response_timeout` | `bool` | この tick の最後の送受信で、`serial_response_timeout_ms` 以内に有効な応答が無かったか |
| `mode` / `velocity_rpm_raw` / `position_raw` / `current_raw` / `fault_code` | — | 最後の有効フレームのワイヤ値そのまま(意味は `MotorFeedback` と同じ。`velocity_rpm_raw` はフィルタ前の整数値) |

## `/drive_control_sample` トピック契約(診断専用)

- **型**: `questix_msgs/msg/DriveControlSample`
- **発行元**: `drive_component`。制御 tick の最後(送信の後)に 1 回。レートは `control_rate`(既定 50 Hz)。
  idle・タイムアウト停止・故障停止の tick も出す(`tick_action` で区別)。
- **QoS**: reliable + volatile + keep_last(100)。rosbag の記録側が一時的に遅れても 2 秒ぶん
  (50 Hz)までは欠落させないため。古い tick を late join に渡さないよう transient_local にはしない。
- **lifecycle ACTIVE の間だけ**。既定で有効。`publish_control_sample: false` で止まる
  (出力先は `control_sample_topic`。どちらも実行時変更不可、`launcher/config/drive_component.yaml`)。
- **時刻**: `header.stamp` = tick の開始時刻、各輪の `feedback_stamp` = そのフレームの受信時刻。
  受信時刻は tick の送受信の中にあり、tick の開始とは数 ms ずれる。
- **欠落の検出**: `seq` の飛び。**重複の検出**: 輪ごとの `feedback_new == false`(または
  `feedback_count` が前の sample と同じ)は同じフレームの繰り返しなので、解析では 1 回だけ数える。
  idle の間は数 tick に 1 回しかフレームが来ない(停止フレームの再送間隔に従う)。
  `feedback_count` は tick の外の送受信(非常停止コールバックの即時停止、configure/activate 時の
  初期化)でも増えるので、sample 間で 2 以上増えても `seq` が連続していればサンプルの欠落ではない
  (間のフレームは sample に載らない)。
- **診断専用**: 記録・解析のためのもので、**制御・安全判断に使わない**。購読するノードを作らない
  (`/drive_status` が状態の契約、`/emergency_stop` が安全の契約)。
- **既存トピックを変えない理由**: `MotorFeedback` / `DriveStatus` にフィールドを足すと型ハッシュが
  変わり、既存の購読側・ブリッジ・記録済みの rosbag(旧型で書かれた bag の再生・変換)との互換が
  崩れる。tick 単位の情報は新しい型・新しいトピックに分け、既存の 2 型は変更しない。
  旧 bag の解析は `/drive_status` の車輪ごとの `header.stamp`(受信時刻)で重複を除く
  (`scripts/identify/ripple_analysis.py`)。

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
  - `enable_gpio_ref=false`(手動の明示的な診断起動のみ。launch 引数 `enable_gpio_ref:=false` をその都度明示したときだけで、
    環境変数 `ENABLE_GPIO_REF` では選ばれず(既定はリテラルの `true`)、保存もされない。production ランチャーは使わない。`operation_manager.no_gpio.yaml`、
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
| `/drive_status` | `DriveStatus` | `drive_component` | `status_publish_rate`(既定 50 Hz)。lifecycle ACTIVE 時のみ |
| `/drive_control_sample` | `DriveControlSample` | `drive_component` | **診断専用**。下の「`/drive_control_sample` トピック契約」参照 |
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
