# motor_control_app

QUESTiX のモータ制御 ROS 2 ノード群です。シリアル通信・制御ロジックの実体は
`motor_control_lib` にあり、本パッケージはその ROS インターフェース層です。

| ノード | 用途 |
|---|---|
| `drive_component` | 走行（差動二輪、DDT M0602C ×2）。LifecycleNode |
| `shot_component` | 射出（ESC ローラー + サーボ角度） |
| `single_ddt_motor` | DDT モータ 1 台のベンチテスト用 |
| `joy_axis_drive` | 左右軸→左右輪の直結デバッグ用（運動学なし、レガシー） |

以下は走行系 `drive_component` について記述します。

## トピック

| 方向 | トピック | 型 | 備考 |
|---|---|---|---|
| Sub | `/target_twist` | `geometry_msgs/Twist` | depth 1。ACTIVE のときのみ処理 |
| Sub | `/emergency_stop` | `questix_msgs/EmergencyStop` | reliable + transient_local |
| Pub | `/drive_status` | `questix_msgs/DriveStatus` | `status_publish_rate` Hz |
| Pub | `/drive_control_sample` | `questix_msgs/DriveControlSample` | 制御 tick ごと（`control_rate` Hz）。**診断専用**。`publish_control_sample: false` で止まる |
| Pub | `/odom` + TF `odom→base_link` | `nav_msgs/Odometry` | 実測 RPM の積分 |

## 制御構造

```
/target_twist → [保存のみ]
control_rate Hz の固定 tick:
  ControlCore::step()  =  スルーレート制限(テーパー付き) → 差動運動学 → 停止ゲート
  → DifferentialDrive::setWheelRpm() / commandStop()
  → DdtMotorLib (UART Protocol1) → M0602C（速度閉ループはファーム内）
```

- スルーレートの dt は `1/control_rate` の定数。上流の publish レートに依存しない。
- フィードバック（実測RPM等）は指令応答としてのみ届く（観測レート = 指令レート）。
- ホスト側に車体速度の閉ループは**まだ無い**（`/odom` は制御に未接続。
  `design/drive_surface_tuning_plan.md` の Phase C 参照）。

## パラメータ

実効値の単一ソースは **`launcher/config/drive_component.yaml`**（統合起動時）。
コード側 `declare_parameter` の既定値は YAML と同値に保つ運用です。

「実行時変更」列: ○ = `ros2 param set` で即時反映。× = **拒否される**
（YAML を編集してノードを再起動する。symlink インストールなので編集→再起動で反映）。

### 走行チューニング（路面・フィーリング調整で触る面）

| パラメータ | 既定値 | 単位 | 実行時変更 | 効き |
|---|---|---|---|---|
| `max_linear_accel` | 3.0 | m/s² | ○ | 前後の追従性の主レバー。0以下で制限無効 |
| `max_angular_accel` | 3.0 | rad/s² | ○ | 旋回の追従性。上げると低RPMファームループを励起し得る |
| `slew_taper_band_linear` | 0.2 | m/s | ○ | 目標接近時のジャーク抑制幅 |
| `slew_taper_band_angular` | 0.2 | rad/s | ○ | 旋回振動抑制の主レバー |
| `min_command_rpm` | 5 | RPM | ○ | 低速不感帯（ファーム不安定域を指令しない）。上げすぎると旋回低速側が消える |

### 停止挙動（実機評価で確定済み。加速整形とは独立）

| パラメータ | 既定値 | 実行時変更 | 効き |
|---|---|---|---|
| `brake_on_stop` | false | ○ | 停止時の電気ブレーキ（velocity モードのみ）。傾斜運用なら true を再検討 |
| `stop_resend_interval_ms` | 300 | ○ | 停止フレーム再送スロットル。「2段階停止」対策 |
| `cmd_timeout_sec` | 1.0 | ○ | `/target_twist` 途絶時の安全停止 |

### 電流モード（実験的、`control_mode: "current"` のとき有効）

| パラメータ | 既定値 | 実行時変更 | 効き |
|---|---|---|---|
| `current_kp` / `current_ki` | 0.001 / 0.0 | ○ | ホスト側 RPM→電流 PI ゲイン [A/rpm] |
| `max_current_amp` | 1.0 | ○ | 電流指令の安全クランプ [A] |
| `integral_limit_amp` | 0.3 | ○ | アンチワインドアップ [A] |
| `current_zero_deadband_rpm` | 5 | ○ | 静止時の微振動防止 |
| `current_invert_measured` | true | ○ | 実測符号反転（正帰還防止） |

### モデルベース走行制御（実験的、**既定は無効**。velocity モードのみ）

走行状態機械（STOP / CREEP / RUN）と RUN 域の外側 LQR+FF。既定値のままなら出力は従来と
同一（`test_control_core` / `test_drive_param_policy` で回帰確認）。有効化は
`scripts/identify/` の同定結果を得てから。設計は `design/model_based_drive_control.md`。
実行時変更は他のパラメータと同じく全値検証 → 一括反映で、範囲外・非有限値は要求ごと拒否。

| パラメータ | 既定値 | 実行時変更 | 効き |
|---|---|---|---|
| `drive_fsm_run_enter_rpm` / `drive_fsm_run_exit_rpm` | 0 / 0 | ○ | CREEP↔RUN の入り/抜け閾値 [RPM]。0 で RUN 判定無効 = 従来の停止/走行 2 状態。exit > enter は enter に丸めて使う |
| `velocity_run_lqr_enabled` | false | ○ | RUN 域 LQR+FF の有効化。current モードでは無視（WARN）。`drive_fsm_run_*` が両方 0 の間も適用しない（WARN） |
| `velocity_run_model_tau_sec` / `velocity_run_model_delay_ticks` | 0.1 / 1 | ○ | 同定した一次遅れ時定数 [s]（> 0）/ むだ時間 [tick]（0..4） |
| `velocity_run_q` / `velocity_run_r` | 0.0 / 1.0 | ○ | 追従誤差 / 入力の重み（q ≥ 0、r > 0）。q = 0 で FB なし |
| `velocity_run_lead_gain` / `velocity_run_disturbance_gain` | 0.0 / 0.0 | ○ | 参照変化の先回り / 外乱推定による定常偏差補償（各 0..1） |
| `velocity_run_observer_l_x` / `velocity_run_observer_l_d` | 0.3 / 0.0 | ○ | オブザーバの状態（0..1）/ 外乱（≥ 0）イノベーションゲイン |
| `velocity_run_max_correction_rpm` | 20.0 | ○ | 補正量の上限 [RPM]（安全装置）。補正で指令の符号が目標と逆になることはない（0 で止める） |
| `velocity_run_invert_measured` | false | ○ | 実測 RPM の符号反転（正帰還になる場合のみ） |
| `velocity_run_feedback_max_age_sec` | 0.1 | ○ | 両輪の `velocity_rpm_raw` がこれより古ければ FF のみ（> 0） |

走行状態（STOP / CREEP / RUN）は左右の大きい方の |目標| で車体に 1 つだが、補正の適用は
**輪ごと**に判定する: その輪の目標が 0 でなく、|目標| が `drive_fsm_run_exit_rpm`（0 なら
enter と同値、enter より大きければ enter）以上の輪だけに掛ける。旋回で遅い側・0・逆向きの輪は
FF のみ（目標そのまま）で、その輪のオブザーバ / LQR 状態は捨てる。目標の符号が変わった
（前後反転）輪も状態を捨て直し、実測から初期化する。

`velocity_run_*`（上表のうち `velocity_run_feedback_max_age_sec` を除く）を実行時に変更すると、
旧モデルで育ったオブザーバ / LQR の内部状態（推定 RPM・外乱推定・入力履歴・前回参照）は
破棄され、次の有効なフィードバックで実測 RPM から初期化し直される。走行中に LQR を
ON/OFF しても、変更前のモデル由来の推定値が新しい設定へ持ち越されることはない。
一方でスルーレートの前回指令と走行状態（STOP / CREEP / RUN）は維持するので、パラメータを
触った瞬間に指令が飛ぶことはない。`velocity_run_*` 以外（加速度上限・不感帯など）の変更では
オブザーバ / LQR の状態は消さない。

`velocity_run_feedback_max_age_sec` はフィードバックの鮮度判定であり制御器のモデルではない
ため、この破棄の対象に含めない（古くなった時点で既存のフィードバック無効経路が同じ状態を
リセットする）。

### 観測・レポート

| パラメータ | 既定値 | 実行時変更 | 効き |
|---|---|---|---|
| `measured_lpf_tau_sec` | 0.15 | ○ | 実測RPMローパス（**レポート/odom経路のみ**、制御は生値）。`velocity_rpm_raw` に生値が併記される |
| `status_publish_rate` | 50.0 | × | `/drive_status` の publish レート |
| `publish_control_sample` | true | × | 制御 tick ごとの診断サンプル `/drive_control_sample` を出すか |
| `control_sample_topic` | `/drive_control_sample` | × | 診断サンプルの出力先 |

`/drive_control_sample`（`questix_msgs/DriveControlSample`）は制御 tick の最後に 1 回 publish
される（reliable + volatile + keep_last(100)、ACTIVE の間だけ）。`/drive_status` は別タイマーで
最新の快照を読むため、tick と 1 対 1 に対応しない（同じフィードバックを 2 回出す・1 つ飛ばす
ことがある）。tick ごとの記録・解析にはこちらを使う: `seq` で欠落、`feedback_new` /
`feedback_count` で同じフレームの重複を判別でき、補正前の目標・送った指令・往復時間・
ワイヤ値（速度・位置・電流の生値）が同じ tick に揃っている。制御・安全判断には使わない。
契約は `questix_msgs/README.md`。

### 構成（再起動が必要 = 実行時変更は拒否される）

| パラメータ | 既定値 |
|---|---|
| `serial_port` / `baud_rate` | `/dev/ttyACM0` / 57600（実機で使っている値。データシートとの食い違いは下の「未確認の食い違い」） |
| `left_motor_id` / `right_motor_id` | 4 / 5 |
| `max_motor_rpm` | 475（`DdtMotorLib::kSpecVelocityMaxRpm` にクランプ。データシートは ±330 rpm と記載、下記） |
| `control_mode` | `"velocity"`（`"current"` で電流モード） |
| `control_rate` | 50.0 Hz（シリアル往復 2 モータ直列が周期予算に収まる必要あり） |
| `serial_response_timeout_ms` | 10（従来の固定値）。フィードバック応答待ちの上限 [ms]、範囲 [2, 50]（外はクランプ + WARN）。下限の目安は応答フレーム伝送 1.74 ms + ファーム処理の実測値 + 余裕。実測は停止時 INFO「シリアル往復レイテンシ統計」 |
| `wheel_radius` / `wheel_separation` | 0.1 / 0.5 m |
| `auto_start` / `connect_retry_period_sec` | true / 1.0 |
| `publish_tf` / `odom_topic` / `odom_frame_id` / `base_frame_id` | true / `/odom` / `odom` / `base_link` |
| `typed_status_topic` / `emergency_stop_topic` | `/drive_status` / `/emergency_stop` |

### 廃止済みパラメータ（後方互換なし）

- `min_linear_accel` / `min_angular_accel` / `accel_demand_ref_linear` / `accel_demand_ref_angular`
  — デマンド適応加速度。実機評価で逆効果と確定しコードごと削除。
- `accel_time_0p1ms_per_rpm` — ファーム側加速時間。実機確定値 1（実質平滑化なし）をコード内定数化。

## チューニングワークフロー

```bash
# 1. 実機でライブ調整（○ のパラメータのみ。× は拒否され、理由が返る）
ros2 param set /drive_component max_angular_accel 4.5

# 2. 当たりが付いたら現在値を確認して YAML に転記
ros2 param dump /drive_component

# 3. launcher/config/drive_component.yaml を編集（symlink なので再ビルド不要）
#    → ノード再起動で反映。ライブ調整値は respawn で消えるため転記を忘れない
```

観測時の注意: `/drive_status` の `velocity_rpm` はローパス済みで、ファーム速度ループの
~1.8Hz 振動を約半分に見せる。振動解析・システム同定には `velocity_rpm_raw` を使うこと。

シリアル往復レイテンシの統計は deactivate 時に INFO ログへ出力される
（`DdtMotorLib::getSerialLatencyStats`、制御周期引き上げ検討の実測材料）。

## velocity / current モード実装のレビュー（既知の制約と根拠）

足回りの前後振動の切り分け（車輪を浮かせた試験と床上試験。手順は `scripts/identify/README.md`）の
前に、制御実装を見直した結果。方針は「既定の走行挙動を変えない」: 修正は既定 OFF の機能内の
明確なバグだけで、挙動を変える改善は起動時の警告・文書・既定 OFF のパラメータに留めた。

| 論点 | 判断 | 既定挙動への影響 |
|---|---|---|
| L1 RUN 判定は左右の大きい方。目標 0 の輪に ±`velocity_run_max_correction_rpm` が出得た | **修正**: 目標 0 の輪は補正せず 0、状態を捨てる | なし（LQR は既定 OFF） |
| L2 輪ごとの適用範囲の判定がなかった（旋回の遅い側に一次遅れモデル外の補正） | **修正**: その輪の \|目標\| ≥ run_exit の輪だけ補正、他は FF のみ。符号反転でも状態を捨てる | なし（同上） |
| V-ticks `velocity_run_model_delay_ticks` などは tick 単位 | 起動時 WARN（LQR 有効かつ `control_rate` ≠ 50）。YAML の 50 Hz 前提の書き方を周期によらない表現に | なし |
| V3 停止の最後は停止フレームに切り替わり、減速はファーム（加速度バイト 1 = 最速）任せ | 文書化のみ。「停止フレームだけ加速度バイトを大きくする」案は未検証（実装するなら既定 OFF のパラメータで） | なし |
| V4 停止フレームの高頻度送信でファームが減速を完了できない（ファームは受信フレームごとに内部状態を更新している可能性） | 文書化。定速中の送信頻度を変える試験の手順を `scripts/identify/README.md` に | なし |
| V5 LQR は一次遅れモデル。~1.8 Hz 振動を表現できず、オブザーバは外乱と見なす | YAML / README に「振動対策ではない」。`test_control_core` の共振モデル（仮定値の 2 次系）で固定: 状態 FB だけでは揺れは減らず（≈10 → 12 rpm）、**外乱補償（`velocity_run_disturbance_gain` > 0）は共振付近の揺れを補正上限まで励起する（≈10 → 84 rpm）**。共振を同定するまで外乱補償を有効にしない | なし |
| C1 current モード既定ゲイン（純 P 0.001 A/rpm、±1 A） | 既定値は変えず、起動時 WARN（`current_ki` ≤ 0 のとき）と下の評価前提 | なし |
| C2 current モードのランプ二重（ホストの加速度制限 + ライブラリの `current_max_accel_rpm_per_sec`） | 確認の結果、**二重になっていない**: ライブラリ側は既定 0（無効）で、設定する呼び出しがリポジトリに無い。ホストの加速度制限だけが効く | なし |
| C3 `current_invert_measured: true` が既定、実機での符号確認の記録なし | current モード起動時 WARN。確認手順を下に | なし |
| C4/C5 ホスト速度ループは 1 rpm 分解能・50 Hz で、ゲイン上限が負荷慣性で大きく変わる | 文書化（浮かせた状態は慣性が小さく、床上と同じゲインでは発振しやすい） | なし |
| C6 指令途絶時のドライバの挙動がデータシートに無い | current モード起動時 WARN と下の安全注意 | なし |
| 周期: current PI は実測 dt、`ControlCore` は固定 dt | 整合を確認（下）。初回・異常時のフォールバック 0.01 s は周期によらない定数（`current_ki` = 0 の既定では効かない） | なし |
| 周期: tick の overrun | 下に記載。`/drive_control_sample` の `tick_duration_sec` と `header.stamp` の間隔で見える | なし |
| 観測: `/drive_status` と制御 tick が別タイマー | 同じフレームの重複・取りこぼしがある。tick 単位の解析は `/drive_control_sample` | なし |
| 観測: フィードバック失効の前でも、応答タイムアウトの tick は同じフレームがオブザーバに 2 回入る | 文書化のみ（`velocity_run_feedback_max_age_sec` 0.1 s = 5 tick までは同じ実測を新しい観測として扱う。直すなら `ControlCore` の入力に「新しいフレームか」を足す） | なし |

### 周期と時間の扱い

- **固定 dt と実測 dt**: スルーレート・運動学・LQR は `dt = 1/control_rate` の定数（`ControlCore`）。
  current モードの PI（`DdtMotorLib::runCurrentLoopStep`）はモータごとの実測 dt を使い、0 以下・
  0.2 s 超は 0.01 s に置き換える。50 Hz では実測 ≈ 0.02 s で両者は一致する。`control_rate` を
  上げても PI の dt は実測に追従するので整合は崩れないが、停止・リセット直後の最初の 1 回だけは
  0.01 s を使う（積分ゲイン 0 の既定では影響しない）。
- **overrun**: tick が周期を超えると、rclcpp の wall timer は遅れた分の周期を飛ばして次の周期から
  再開する（溜まった tick を連続で実行しない）。dt は定数のままなので、overrun の間はホストの
  加速度制限が実時間では緩く（遅く）効く。`Control tick overrun` の WARN（5 秒に 1 回）と
  `/drive_control_sample` で確認できる。
- **1 tick の所要時間**: 2 モータ直列で 1 問 1 答。正常 ≈ 7 ms（10 byte の送信 1.74 ms + ファーム
  処理 + 応答 1.74 ms、× 2）。応答が無いと 1 モータあたり `serial_response_timeout_ms`（既定 10 ms）
  待つ。送信前の `tcflush(TCIFLUSH)` は前回の遅れた応答を捨てる。捨てた後に同じモータの遅れた
  応答が届くと、それをこの送受信の応答として受け取る（1 フレーム古い。CRC では区別できない）。
  `tcdrain` は 10 byte の送信完了（≈1.74 ms）を待つ。
- **アイドル中のフィードバック**: 未武装の tick は、保持しているフィードバックが 0.2 s より古ければ
  最後に送れた停止フレームを再送して応答を取る。停止フレームの再送は `stop_resend_interval_ms`
  （既定 300 ms）のスロットルにも従うので、実際の周期は ≈ 3 Hz（最大 age ≈ 0.32 s）。
- **非常停止の待ち**: 全コールバックが同じ相互排他グループで直列に走るため、`/emergency_stop` の
  コールバックは実行中の tick が終わるまで待つ。既定で正常 ≈ 7 ms、両モータが応答しないと
  ≈ 2 × (10 + 2) ms ≈ 25 ms（`serial_response_timeout_ms` を 50 にすると 100 ms を超える）。
  `command_wait_ms` > 0 はさらにその分を足す。その後の停止送信は即時（スロットルなし）。
- **`/drive_status` と制御 tick**: `status_publish_rate` と `control_rate` は別のタイマーで、位相は
  そろっていない。同じ 50 Hz でも `/drive_status` は同じフィードバックを 2 回出したり 1 つ飛ばしたり
  する（車輪ごとの `header.stamp` = 受信時刻で判別できる）。

### current モード（実験的）の評価前提と安全注意

- **ゲイン（C1）**: 既定 `current_kp: 0.001` A/rpm・`current_ki: 0.0`・`max_current_amp: 1.0` は
  評価の出発点。純 P なので、摩擦に釣り合う電流を出すには定常偏差が要る（例: 0.1 A に 100 rpm の
  偏差）。走行制御として機能するかは未評価。
- **符号（C3）の確認手順**: 車輪を浮かせ、`max_current_amp` を小さく（例 0.3）、`current_ki: 0` で
  起動する。小さい正の目標（例 20 rpm 相当）を与え、`/drive_control_sample` の `command_current_raw`
  と `velocity_rpm_raw` を見る。目標に向かって回り、偏差が縮むなら符号は正しい。偏差が広がって
  電流が上限に張り付くなら正帰還: すぐ止めて `current_invert_measured` を反転する。左右とも確認する。
- **ゲインと負荷（C4/C5）**: ホストの速度ループは 1 rpm 分解能の実測を 50 Hz で見るだけで、
  ゲインの上限は負荷慣性で大きく変わる。浮かせた車輪は慣性が小さく、床上と同じゲインでは
  発振しやすい。浮かせた試験は低ゲインから上げ、床上では改めて詰める。
- **指令の途絶（C6）**: ホストからの指令が途絶えたときにドライバが何をするか（電流を 0 にするか、
  最後の電流を保持するか）はデータシートに無い。保持する場合、current モードは速度の上限なく
  加速し得る（特に浮かせた車輪）。`cmd_timeout_sec` はホストが動いている間の途絶しか止めない。
  `max_current_amp` を小さく保ち、非常停止をすぐ押せる状態で試す。

### 未確認の食い違い（データシートとリポジトリ）

M6 規格書 V1.0 は通信 115200 baud・最大 500 Hz・速度 ±330 rpm と記載しているが、リポジトリは
`baud_rate: 57600`、`max_motor_rpm: 475`（`kSpecVelocityMaxRpm`）を使っている。実機での確認待ちの
ため、**今回コードは変更していない**。往復時間・`serial_response_timeout_ms` の下限の見積もり
（10 byte で 1.74 ms）は 57600 baud を前提にしている。

## ビルド時間

各ターゲットは 1 ファイル構成で、時間の大半は rclcpp / rclcpp_lifecycle ヘッダーの解析です。
`CMakeLists.txt` はこれをプリコンパイル済みヘッダー（共有ライブラリ用と実行ファイル用の 2 つ）
で 1 回だけ解析し、全ターゲットで再利用します（`-DMOTOR_CONTROL_APP_USE_PCH=OFF` で無効化）。
ビルドログに `-Winvalid-pch` の警告が出たら再利用が効いていません（結果は同じで、速度だけ落ちる）。

キット（Raspberry Pi 5）は `./setup.sh` の `ros2_build` ロールが ccache の導入・設定と
ワークスペースへの組み込みまで行います。既存のキットも `./setup.sh --tags ros2_build`（このロールだけ実行）で入り、以降は
いつもの `colcon build --symlink-install` のまま ccache が使われます（pull・ブランチ切り替え後の
再コンパイルが速くなる）。

開発 PC で同じことをするには:

```bash
sudo apt install ccache
# PCH と併用するための設定（一度だけ）
ccache --set-config sloppiness=include_file_ctime,include_file_mtime,pch_defines,time_macros
```

`~/.colcon/defaults.yaml`（コマンドで `--cmake-args` を付けるとこちらは上書きされる）:

```yaml
build:
  cmake-args:
    - -DCMAKE_C_COMPILER_LAUNCHER=ccache
    - -DCMAKE_CXX_COMPILER_LAUNCHER=ccache
```

このパッケージだけを触っている間は `--packages-select motor_control_app` で他を省けます。

## テスト

```bash
colcon test --packages-select motor_control_app
```

- `test_control_core`: ファーム速度ループのプラントモデル込み閉ループシミュレーション
  （指令列のレート不変性・整定時間・停止ヒステリシスの回帰）
- `test_drive_param_policy`: 実行時パラメータ変更ポリシー（live 反映 / 拒否）の回帰

### Runtime parameter transaction

`set_parameters_atomically` の要求は、全値を検証・stageしてから反映します。
拒否時はmember、制御ライブラリ設定、ROS parameter storeを保持します。
`current_kp` / `current_ki` は有限値、`max_current_amp` / `integral_limit_amp` は
有限かつ0以上、`current_zero_deadband_rpm` は0〜INT_MAX、
`current_invert_measured` はboolを受理します。追加の物理上限は設けません。
既存integer runtime設定はintへ安全に変換できる範囲とし、負値による無効化は維持します。

レイテンシの `ema_ms` / `ema=` は指数移動平均（alpha=0.05）です。
応答が0件でもtimeoutがあればdeactivate時にsummaryを出力します。
