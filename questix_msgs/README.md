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
| `reason` | `string` | 原因(例: `"pin 5 not received; "`、`"pin 5 is true, expected false; "`、`"pin 5 timeout; "`)。解除時は `"released"` |

### `MotionPermission.msg`

走行許可(L2)。非常停止(L1)とは別の概念で、`/motion_permission` で配信する。契約は下の
「`/motion_permission` トピック契約」。

| フィールド | 型 | 意味 |
|---|---|---|
| `header` | `std_msgs/Header` | `stamp` = 判定時刻(情報のみ。鮮度の判定には使わない) |
| `drive_allowed` | `bool` | 車輪を動かしてよいか(drive_component が見る) |
| `launcher_allowed` | `bool` | ローラー・チルト・射撃を動かしてよいか(shot_component / esc_motor_control が見る) |
| `mode` | `string` | 実行中のモード(`lesson` / `practice` / `competition`、表示用) |
| `drive_blockers` / `launcher_blockers` | `string[]` | 許可しない理由(例: `referee:off`、`teacher:stale`、`teacher:unknown`)。許可なら空(表示用。アクチュエータは bool だけを見る) |

### `LauncherCommand.msg`

発射機構(ローラー・チルト・射撃)への指令。走行の `geometry_msgs/Twist`(`/target_twist`)に対応する
発射側の型(入力の選択、L3)。`/launcher_command`(機構が従う)と、入力ごとの `/launcher_command/joy`・
`/launcher_command/lab`。esc_motor_control は `roller_power`、shot_component は `tilt_deg`・`tilt_steps`・
`fire_seq` だけを使い、どちらも `/emergency_stop` と `/motion_permission` には従ったまま。

| フィールド | 型 | 意味 |
|---|---|---|
| `header` | `std_msgs/Header` | `stamp` = 送信時刻(情報のみ) |
| `roller_power` | `float32` | ローラー出力 0..1(0 = 止める)。送られている間だけ回る(途切れたら止まる) |
| `tilt_deg` | `float32` | チルトの目標角 [deg](教材)。NaN = 目標なし |
| `tilt_steps` | `int32` | チルトの段数の累計(コントローラー: 上 +1・下 -1)。変化した分だけ動かす |
| `fire_seq` | `uint32` | 射撃要求の累計。増えたら 1 発(1 メッセージで最大 1 発) |
| `source` | `string` | `"joy"` / `"lab"`(表示用。受信側は値で区別しない) |

射撃・チルトは「パルス」ではなく累計と目標なので、keep-last(1) で落ちても重複しても数が変わらない。
累計は**送信元(publisher)ごとの 1 つの数え方**で、受信側は最初のメッセージ・指令が途切れた後の最初の
メッセージ・`fire_seq` が戻ったメッセージ(送信元の再起動)を基準にするだけで、何も動かさない。
`tilt_deg` は前のメッセージと違う有限の値(前が NaN を含む)が新しい目標(基準のときも今の目標として扱う)。
command_arbiter の出力は自分の累計を持つので、入力が切り替わっても数え直しや取りこぼしはない。
受信側の実装: `motor_control_app/launcher_events.hpp`、`command_arbiter/launcher_flow.hpp`(`InputEvents`)。

## `/launcher_command` トピック契約(発射機構の指令、L3)

- **型**: `questix_msgs/msg/LauncherCommand`
- **QoS**: reliable + **volatile** + keep-last(1)
- **発行元**: 練習・大会は joy_controller パッケージの `joy_launcher`(`/joy` 1 件ごと。ボタンの割り当ては
  操作設定の `joy_launcher` セクション)。教材は command_arbiter の `launcher_arbiter` が
  `/launcher_command/joy`(joy_launcher)と `/launcher_command/lab`(QUESTiX LAB ブリッジ)から選ぶ。
- **購読側**: esc_motor_control(`roller_power`。`safety_timeout` 1.0 s 途切れたら止め、0 を受けるまで
  回さない。起動直後と非常停止・許可のあとも同じ)、shot_component(`fire_seq`・`tilt_steps`・`tilt_deg`。
  ACTIVE・許可あり・非常停止解除のときだけ動かし、それ以外で届いたものは捨てる)。どちらも `/joy` と
  教材のトピックは読まない。
- **誰が操作してよいか**はここでは決めない(command_arbiter と joy_launcher)。止める判断は
  `/emergency_stop` と `/motion_permission` でアクチュエータが行う。

### `ArbiterStatus.msg`

command_arbiter(教材モードのみ)が機構ごとに出す選択の結果(`/command_arbiter/status`、5 Hz と変化時)。
`mechanism`(`drive` / `launcher`)、`active_source`(`joy` / `lab`)、`switch_reason`、`lab_permitted`
(先生の教材の許可 `/lab_permission`)、`lab_locked`(コントローラーが割り込んだ)、`lab_refusal`(教材の
指令を断った理由。空なら受付中)、`lab_count`(受け取った教材の指令の数。ブリッジが自分の走行と
対応付けるため)と、適用中の教材の制限(走行: `max_linear`・`max_angular`、発射: `max_power`・
`tilt_min_deg`・`tilt_max_deg`・射撃の前提 `min_fire_power`/`spin_up_sec` と間隔 `fire_interval_sec`、
残り時間 `next_fire_in_sec`・`spin_ready_in_sec`)。発射の `lab_refusal` には `not_spinning`・`interval`
も入る。非常停止と走行許可は見ない(アクチュエータの仕事)。

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
| `velocity_rpm_raw` | `int16` | 実測輪速のフィルタ前生値 [RPM]。同定・振動解析用(ローパス済み値は床の上の約 1.5〜1.75 Hz の速度変動〔原因は未確定〕を約半分に見せる) |
| `target_rpm` | `int16` | 最終指令値 [RPM](`max_motor_rpm` でクランプ後) |
| `position_raw` | `uint16` | ロータ位置(DATA[6..7])。0..32767 ↔ 0..360 deg。ワイヤ値は 1 LSB 刻みで動く(8 で割った余りは 0〜7 がすべて出る。センサの真の分解能は不明)。1 台での観察(2026-10-05、`scripts/identify/README.md`「4.」): 車輪を動かさずにモータの電源を入れ直すと同じ値(±1 LSB)、モータで回すと 1 回転で 1 周、ただし手で約 90° 回したときの変化は約 9〜17° で、理由は未解明。2026-10-06 の型紙での試験では、非常停止の押下中(ID13 では押下で DDT の駆動電源が切れる。作業者が確認)に手で回した後の値は型紙の角度と一致せず、同じ角度では同じ値に戻った。電源断をまたいだ値は角度・回転数として使わず、校正済みの絶対角としても扱わない |
| `temperature` | `uint8` | [deg C] **現状常に 0**。DDT Protocol 2 (0x74) 未実装。実装時にフィールドを変えずに済むよう定義だけ残している |
| `fault_code` | `uint8` | DATA[8]。0 = 正常、非0 = ファーム故障ビット |

**3.2.0 との互換**: `velocity_rpm_raw` は 3.2.0 の後で `velocity_rpm` の次に追加した。
`MotorFeedback` と、それを含む `DriveStatus` の型ハッシュは 3.2.0 と違うため、3.2.0 でビルドした
ノード(別 PC の購読側など)とは `/drive_status` でやりとりできず、3.2.0 で記録した bag は旧い
並びのまま(3.2.0 の定義で読む)。`velocity_rpm` の中身は 3.2.0 と同じ(`CHANGELOG.rst`)。

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
| `command_sent` | `bool` | tick の指令(駆動・停止・安全停止)を両輪について、書き込みの失敗なく処理できたか。**実際にフレームを送ったことの証拠ではない**: 停止が続く間は `stop_resend_interval_ms`(既定 300 ms)のあいだ停止フレームの再送を省き、それでも true になる(その輪の `feedback_new` は false、`roundtrip_ms` は NaN)。送受信の有無は `feedback_new` で見る。idle tick は安全停止をしたときだけ true(フィードバック取得のための停止フレーム再送は指令に含めない) |
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
  崩れる(3.2.0 の後の `velocity_rpm_raw` の追加で一度崩れている。上の「3.2.0 との互換」)。
  tick 単位の情報は新しい型・新しいトピックに分け、既存の 2 型はこれ以上変更しない。
  旧 bag の解析は `/drive_status` の車輪ごとの `header.stamp`(受信時刻)で重複を除く
  (`scripts/identify/ripple_analysis.py`)。

## `/emergency_stop` トピック契約

- **型**: `questix_msgs/msg/EmergencyStop`
- **QoS**: reliable + transient_local + keep-last(1)
  (`rclcpp::QoS(1).reliable().transient_local()`)。
  購読側も同一 QoS を使うこと。late-join した購読者は最新のラッチ状態を即時受信する。
- **発行元**: operation_manager の `EmergencyStopManager`(ノード `emergency_stop_manager`、
  `source` は `operation_manager`)。入力は物理非常停止回路の GPIO5 だけ(安全機能だけを扱う。
  AutoReferee の撃破(GPIO27)は試合の状態で、走行許可 `/motion_permission` の審判の票)。
  GPIO 更新毎(公称 ~20 Hz)+ 100 ms タイマーで発行する。
- **発行元は常に起動する**: drive/shot の有無にも `enable_gpio_ref` にもモードにも依存せず
  `questix_core.launch.xml` から常に起動する。
  - `enable_gpio_ref=true`(production の起動は常にこれ): GPIO5 を判定する。reason は `pin 5 ...`。
  - `enable_gpio_ref=false`(手動の明示的な診断起動のみ。launch 引数 `enable_gpio_ref:=false` をその都度明示したときだけで、
    環境変数 `ENABLE_GPIO_REF` では選ばれず(既定はリテラルの `true`)、保存もされない。production ランチャーは使わない。
    `emergency_stop_manager.no_gpio.yaml`、`gpio_safety_enabled: false`): GPIO を読まず、
    `active=false`、reason `released (no GPIO safety path)` を 100 ms 毎に出す。
- **未受信はフェイルクローズ**: 購読側(drive_component / shot_component / esc_motor_control は
  共通の `questix_safety::EmergencyStopMonitor`、QUESTiX LAB ブリッジ)は構成によらず、**一度も受信していない間は「非常停止の状態が不明」
  として動かさない**(`require_emergency_stop: true`)。受信状態はモータとの通信
  (フィードバックの取得)とは別で、drive_component は動かさないまま実測の取得を続ける。
- **staleness 検出**: 購読側は「一度以上受信した後に」`emergency_stop_timeout_sec`
  (既定 1.0 s、自分の単調時計による受信間隔)を超えて受信が途絶えたら、押下と同じく停止して
  動かさない。受信が戻っても、解除だけでは動き出さない(新しい指令が必要)。
- **単体起動では発行元も起動する**: `questix_core` 以外の起動(パッケージ単体の launch や
  `ros2 run`)は operation_manager を起動しないため、そのままでは `/emergency_stop` も
  `/motion_permission` も届かず drive_component / shot_component / esc_motor_control は動かない
  (3.2.0 までは未受信でも動いた)。規則を保ったまま動かすには、別の端末で発行元を起動する:

  ```bash
  # Raspberry Pi で物理非常停止(GPIO5)を判定する。走行許可は練習(票なしで常に許可)
  ros2 launch gpio_reader gpio_reader.launch.xml
  ros2 launch operation_manager operation_manager.launch.xml robot_mode:=practice
  # GPIO のない PC やベンチの診断(押下は ROS に伝わらない。RLY1 の動力遮断は別に働く)
  ros2 launch operation_manager operation_manager.launch.xml robot_mode:=practice \
    enable_gpio_safety:=false
  ```

  どちらも非常停止と走行許可の発行元を一度に起動する。発行元を二つにしない。
- **診断用の明示 opt-out**: 発行元なしで動かす単体の診断に限り、ノードのパラメータ
  `require_emergency_stop` を false にできる(押下を受信したときの停止はそのまま。走行許可は
  `require_motion_permission`、下の「`/motion_permission` トピック契約」)。launch 引数では
  ない(どの launch も宣言していない)ので、`ros2 launch ... require_emergency_stop:=false` は
  警告なしに無視される。`ros2 run motor_control_app drive_component_node --ros-args -p
  require_emergency_stop:=false` のように、ノードのパラメータとして渡す。統合構成は opt-out しない。

## 復帰挙動(active=false 受信時)

全購読者とも**自動復帰**。ただしモータが勝手に動き出すことはない。

| 購読者 | 停止時(active=true) | 解除時(active=false) |
|---|---|---|
| `drive_component` | 停止指令をスロットル無しで即時送信 + 目標を破棄。以後の `/target_twist` は無視。停止指令を送れなかったら stop fault(送信に成功するまで動かさない) | `/target_twist` 受付再開。モータは解除**後**に届いた次の twist コマンドまで停止のまま |
| `shot_component` | deactivate→cleanup でサーボバス解放(unconfigured へ) | auto-start 再アーム。configure→activate を自動リトライ(走行許可も必要) |
| `esc_motor_control` | `set_motor_speed(0.0)` 即時実行。停止中は `/launcher_command` を無視 | `roller_power` 0 の指令を受けるまで 0 のまま(押しっぱなし・教材の指令の繰り返しでは再始動しない。ボタンなら**離す→押す**) |

## `/actuation_authority` トピック契約(教材モードの先生の許可 = 走行許可の票)

教員の許可(teacher permission)。教材モード(`lesson`)の走行許可(L2)の票で、
operation_manager の `MotionPermissionManager` だけが購読する(`operation_manager.permission.yaml` の
`votes.teacher`)。drive_component / shot_component / esc_motor_control はこれを直接見ず、
`/motion_permission` だけに従う。トピック名 `/actuation_authority` と型 `ActuationAuthority` は、
記録済みの rosbag と Robot Manager との互換のためそのまま。

- **型**: `questix_msgs/msg/ActuationAuthority`(`drive_allowed`, `launcher_allowed`)
- **QoS**: reliable + **volatile** + keep-last(1)。**transient_local にしない**(許可をラッチしない)。
- **発行元**: Robot Manager(教員が「ロボットの走行制御」「発射機構の操作」を ON にしている間だけ、
  約 5 Hz)。ON にできるのは、教材モードで起動したロボットが動いていて、保存されたモードも教材の
  ときだけ。Robot Manager の起動・Pi の再起動・モードの切り替え・ロボット制御の起動/再起動/停止・
  「すべて止める」・Robot Manager の終了ではすべて OFF から始まる/OFF になる。
- **非常停止とは別の概念**: 教員の許可は「動かしてよいか」の票で、非常停止ではない。
- **リース**: MotionPermissionManager は自分の単調時計で `lease_sec`(1.0 s)以内に受信した票だけを
  使う。未受信・false・途絶はすべて OFF(`teacher:unknown` / `teacher:off` / `teacher:stale`)で、
  `/motion_permission` の該当フラグが false になる。アクチュエータは許可を失うと止まり
  (drive: 即時停止 + 目標破棄、shot: 射撃・チルトを断る(バスは保持)、ESC: 0 + ラッチ解除)、
  許可が戻っても、それだけでは動き出さない。
- **練習・大会**: 先生の票は使わない(練習は票なし、大会は審判の票 `/motion_vote/referee`)。

## `/motion_permission` トピック契約(走行許可、L2)

- **型**: `questix_msgs/msg/MotionPermission`
- **QoS**: reliable + **volatile** + keep-last(1)。**transient_local にしない**(許可をラッチしない)。
- **発行元**: operation_manager の `MotionPermissionManager`(`questix_core` で常に起動)。20 Hz と、
  判定が変わったときはすぐに出す。練習(票なし)でも出し続ける。
- **判定**: 実行中のモードが必要とする票(`operation_manager/config/operation_manager.permission.yaml`
  の `required`)をすべて満たすときだけ許可。票ごとに、未受信 → `<name>:unknown`、
  リース(`lease_sec`、1.0 s)切れ → `<name>:stale`(両方のフラグ)、受信した false → `<name>:off`
  (そのフラグ)。規則は `questix_safety/motion_permission_rule.hpp`。

  | モード | 必要な票 |
  |---|---|
  | `lesson`(教材) | `teacher`(`/actuation_authority`、Robot Manager の 操作 タブ) |
  | `practice`(練習) | なし(常に許可) |
  | `competition`(大会) | `referee`(`/motion_vote/referee`、RefereeMonitor が GPIO27 から) |

  知らないモード、または一覧にない票を必要とするモードでは起動しない(不明なモードを「許可」に倒さない)。
- **購読側**: `questix_safety::PermissionMonitor`(`motion_permission_topic`、
  `require_motion_permission`、`motion_permission_timeout_sec`、既定 0.5 s)。自分の単調時計で
  リースを判定し、未受信・途絶・false はすべて「許可なし」。許可が戻っても、それだけでは動き出さない
  (新しい指令が必要)。`require_motion_permission:=false` は単体診断の明示 opt-out だけ。
- **非常停止との関係**: 両方が閉じているときは非常停止(L1)が優先する(反応も理由も非常停止のもの)。
  非常停止はモータへの出口の直前の最後のゲート。

## 票(`/motion_vote/*`、`/actuation_authority`)

走行許可の入力。型はすべて `questix_msgs/msg/ActuationAuthority`(`drive_allowed`、
`launcher_allowed`、`source`)で、QoS とリースは `/actuation_authority` と同じ
(reliable + volatile + keep-last(1)、5 Hz 以上、1.0 s のリース)。

| トピック | 発行元 | 中身 |
|---|---|---|
| `/motion_vote/referee` | operation_manager の `RefereeMonitor`(大会のみ) | GPIO27(AutoReferee AR_in、safe-high)。true = 動いてよい。未受信・`timeout_seconds` 途絶・false は不可。GPIO 更新ごと + 100 ms。撃破は試合の状態で、非常停止ではない |
| `/actuation_authority` | Robot Manager(教材のみ) | 先生の許可(下の契約) |

条件を足すときは、票を出すノードを書き、`operation_manager.permission.yaml` の `votes` と `required` に
1 行ずつ足す。

## `/lab_permission` トピック契約(教材の許可、L3 の入力)

先生が QUESTiX LAB に許した操作(Robot Manager の 教材 タブ「教材からの走行」「教材からの発射」)。
走行許可(L2)の票ではない: アクチュエータも MotionPermissionManager も購読しない。教材の指令を
通すかどうかだけを決める。

- **型**: `questix_msgs/msg/ActuationAuthority`(`drive_allowed` = 教材からの走行、
  `launcher_allowed` = 教材からの発射、`source` = `robot_manager`)
- **QoS**: reliable + **volatile** + keep-last(1)。**transient_local にしない**(許可をラッチしない)。
- **発行元**: Robot Manager の heartbeat(`actuation_heartbeat.py`)が `/actuation_authority` と同じ
  周期(約 5 Hz)で並べて出す。先生の操作許可のどちらかが ON の間だけ出る。教材の許可は、同じ種類の
  先生の操作許可が ON のときだけ true になり、先生の操作許可が OFF になると同じ行で false になる。
  切り替えても教材のブリッジは再起動しない。起動のたびに OFF から始まる(`/actuation_authority` と同じ)。
- **リース**: 購読側は自分の単調時計で 1.0 s 以内に受信したものだけを使う。未受信・途絶・false は不許可。
- **購読側**: command_arbiter の `drive_arbiter`(`drive_allowed`: 教材の走行指令を `/target_twist` に
  通すか)と `launcher_arbiter`(`launcher_allowed`: 教材の発射の指令を `/launcher_command` に通すか)。
  QUESTiX LAB ブリッジは読まず、arbiter の `/command_arbiter/status`(`lab_permitted`)を表示に使う。

## `/command_arbiter/status` トピック契約(入力の選択の状態、L3)

- **型**: `questix_msgs/msg/ArbiterStatus`(機構ごとに 1 件。`mechanism` = `drive` / `launcher`)
- **QoS**: reliable + **volatile** + keep-last(10)。ラッチしない。
- **発行元**: command_arbiter(教材モードの起動だけ)。5 Hz と、変化したときはすぐに出す。
- **意味**: どちらの入力がアクチュエータに届いているか(`active_source`: `joy` / `lab`)、その理由
  (`switch_reason`)、教材の許可(`lab_permitted`)、教材の指令を断った理由(`lab_refusal`)、受け取った
  教材の指令の数(`lab_count`。ブリッジは自分の走行が始まった後の状態だけを使う)、教材の上限。
  非常停止と走行許可はここには出ない(アクチュエータが判断する)。
- **購読側**: QUESTiX LAB ブリッジ(両方の機構。1.5 s 届かなければ command_arbiter なし =
  `no_drive_node` / `no_launcher`)、web_joy_driver(走行だけ。「教材から走らせています」の表示、1.5 s で消す)。

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

`operation_manager` の GPIO27 診断(`RefereeMonitor`、`operation_manager: referee`)には `pin_27_signal_limit` が含まれる。
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
- `/gpio/controllable`(`std_msgs/Bool`)と `joy_gate`(`/joy_gated`)は削除済み。入力を間で 0 にする
  代わりに、アクチュエータが `/emergency_stop` と `/motion_permission` で止まる。
- 大会の撃破(GPIO27)は `/emergency_stop` から外し、走行許可(`/motion_permission`、`referee:off`)に
  移した。撃破では shot_component はサーボバスを解放しない(電源は入ったまま)。
- drive_component の受信 staleness タイムアウトは未実装
  (既存のコマンド watchdog と物理電源断がフェイルセーフを担う)。
  ハートビートを利用したタイムアウト追加はフォローアップ候補。
