# motor_control_app

QUESTiX のモータ制御 ROS 2 ノード群です。シリアル通信・制御ロジックの実体は
`motor_control_lib` にあり、本パッケージはその ROS インターフェース層です。

## 走行の停止後の中立待ち（全モード）

drive_componentはactivate直後と、安全停止（許可OFF/途絶、非常停止/途絶、command timeout、
motor fault、stop fault）の後、gateが開きモータが正常な状態で中立を受けるまで非ゼロを拒否します。
大会でも審判許可ON後にスティックを一度離し、倒し直してください。gate閉やfault中のゼロは
再武装に使いません。停止送信・再送・許可と非常停止の優先順は従来どおりです。

`rearm_neutral_linear`（m/s、上限0.05）と `rearm_neutral_angular`（rad/s、上限0.1）は、
有限な入力の絶対値が両方とも設定値以下なら再武装する不感帯です。既定は0.0（厳密な0、-0含む）。
負・NaN/Inf・上限超えは起動時にERRORを出して0.0へ戻します。設定変更はYAMLを編集して再起動します。
速度・電流モードの両方で有効ですが、再武装する指令の目標は0として保存し、以降の指令は加工しません。
上限はLABの速度上限0.15m/s・0.5rad/sより小さく抑える運用上の制限で、実機校正値ではありません。
WARNには拒否した指令と不感帯を出します。実機で離したときの値を記録してから必要最小限を設定してください。

これはcommand_arbiterのcontroller takeover閾値 `neutral_linear` / `neutral_angular` とは別です。
LABの開始/終了用中立は厳密なゼロを維持します。drive設定の正本は
launcher/config/drive_component.yamlです。不感帯はこのYAMLとノードの既定値0.0だけに置き、
launchで値を重ねません。

保証の範囲は**driveが受け取る指令の中立復帰**です。UART・web joyは途絶時にゼロを生成するため、
倒したまま再接続するときの物理入力の中立確認は後続PR 4bで扱います。4aの合格とは混同しません。

| ノード | 用途 |
|---|---|
| `drive_component` | 走行（差動二輪、DDT M0602C ×2）。LifecycleNode |
| `shot_component` | 射出（トリガーと角度のサーボ）。指令は `/launcher_command`（`questix_msgs/LauncherCommand`）だけから受け取る。ボタンの割り当ては joy_controller の `joy_launcher`、教材との選択は command_arbiter |
| `single_ddt_motor` | DDT モータ 1 台のベンチテスト用 |
| `joy_axis_drive` | 左右軸→左右輪の直結デバッグ用（運動学なし、レガシー） |

`drive_component`・`shot_component`（と `esc_motor_control`）は `/emergency_stop` を一度も
受信していない間、または途絶えている間は動きません（`require_emergency_stop: true`）。走行許可
`/motion_permission` も同じです（`require_motion_permission: true`）。
このパッケージの launch（`drive_component.launch.*`、`drive_component_container.launch.*`、
`shot_component.launch.*`）や `ros2 run` は発行元の operation_manager を起動しないので、
単体で動かすときは別の端末で発行元を起動してください。手順と診断用の opt-out は
[`questix_msgs/README.md`](../questix_msgs/README.md) の「単体起動では発行元も起動する」にあります。
`require_emergency_stop:=false` を `ros2 launch` の引数として渡しても無視されます。

以下は走行系 `drive_component` について記述します。

## 車輪上限と前後・旋回の共通縮小

velocity / current の両モードで、受け取った目標 `(v, ω)` を車輪上限内に縮めてから、
既存の加速度制限・テーパーへ渡す。輪距を `d`、半径を `r`、ライブラリの実効上限を `M` rpm
とすると（`M` は既存の `DdtMotorLib::setMaxRpm` による最大475 rpmの制限後の値）、

```text
v_cap = M × 2πr / 60
ω_cap = 2 × v_cap / d
demand = |v| + |ω| × d / 2
s_target = demand > v_cap ? v_cap / demand : 1
slew_target = (s_target × v, s_target × ω)
```

前後だけ・旋回だけの上限も同じ式で扱う。標準寸法 `r=0.05 m, d=0.5 m, M=475 rpm` では
`v_cap≈2.487 m/s, ω_cap≈9.948 rad/s`。目標 `2 m/s, 6 rad/s` は
`約1.421 m/s, 4.264 rad/s` に縮まり、保持すると曲率 `ω/v=3.0 m⁻¹` に収束する。
左右rpmはモータ固有の符号で約 `67.857, -475`、整数化後は `68, -475` となる。
これは指令の計算値で、実際の車体速度や軌跡を保証する値ではない。

前後・旋回の加速度制限は独立なので、旋回中に前進を加えるなどの過渡では、整形後の左右rpmが
上限を超える場合がある。このときも左右を同じ割合 `s_output` で縮める。
**出力の守りは `last_linear_` / `last_angular_` に戻さない**。これにより整形状態は縮めた目標へ
進み続け、定常時の曲率を変えない。過渡の曲率は整形直後のものを保ち、スティック目標の曲率に
直ちに一致するとは限らない。出力保護中は軸別の加速度制限より車輪上限を優先する。
整数化は最近接丸めで、参照は丸め後も `±M` 内に収める（各輪最大0.5 rpmの量子化誤差）。

current モードでは縮小後の参照がホストPIに渡る。velocity の任意のRUN LQR補正はその後なので、
LQR有効時の補正後 `command_rpm` の比・上限はこの参照の保証とは別になる。
ライブラリの最終的な輪別クランプは残す。非常停止・許可喪失・command timeout・faultの停止経路、
中立待ち、PIと暴走ガードの判定は変更しない。`single_ddt_motor` / `joy_axis_drive` や、
ライブラリを直接使う別の呼び出し元へは、この `ControlCore` の縮小処理を追加しない。

寸法が非有限または0以下、rpm上限が0以下、上限・指令の計算が非有限などで使えないとき、
コアは内部状態をリセットしてゼロの停止出力を返し、ノードは1秒throttleのWARNを出す。
ノード起動時と動的変更時の包括的な設定検証（倍率が有限、寸法が正、`max_motor_rpm` が1〜475）は
別作業で、[#247 §6](https://github.com/scramble-robot/questix/issues/247) に記録済み。
保存済みYAML・明示した `control_config_file`・ROSパラメータを対象に、段階的に導入する。

## トピック

| 方向 | トピック | 型 | 備考 |
|---|---|---|---|
| Sub | `/target_twist` | `geometry_msgs/Twist` | depth 1。ACTIVE のときのみ処理 |
| Sub | `/emergency_stop` | `questix_msgs/EmergencyStop` | reliable + transient_local |
| Sub | `/motion_permission` | `questix_msgs/MotionPermission` | reliable + volatile。`drive_allowed` |
| Pub | `/drive_status` | `questix_msgs/DriveStatus` | `status_publish_rate` Hz |
| Pub | `/drive_control_sample` | `questix_msgs/DriveControlSample` | 制御 tick ごと（`control_rate` Hz）。**診断専用**。`publish_control_sample: false` で止まる |
| Pub | `/odom` + TF `odom→base_link` | `nav_msgs/Odometry` | 両輪の position_raw 増分による姿勢、速度は従来の実測RPM |

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

2026-10（#179）：`wheel_radius` を実寸の 0.05 m に直した。m/s・rad/s 単位の値（下の加速度・緩和幅、操作の倍率、LAB の走行の上限、twist_arbiter の中立の幅）は、車輪の回転数（＝走り方）が変わらないよう同時に半分にした。それ以前の値は、実際の速度の 2 倍の数値で書かれていた。

| パラメータ | 既定値 | 単位 | 実行時変更 | 効き |
|---|---|---|---|---|
| `max_linear_accel` | 1.5 | m/s² | ○ | 前後の追従性の主レバー。0以下で制限無効 |
| `max_angular_accel` | 1.5 | rad/s² | ○ | 旋回の追従性。上げると低RPMファームループを励起し得る |
| `slew_taper_band_linear` | 0.1 | m/s | ○ | 目標接近時のジャーク抑制幅 |
| `slew_taper_band_angular` | 0.1 | rad/s | ○ | 旋回振動抑制の主レバー |
| `min_command_rpm` | 5 | RPM | ○ | 低速不感帯。過去の実機調整で、低速側の不安定を避ける目的で入れた（その原因の「ファームの速度ループに低速不安定域がある」は未確認。2026-10）。上げすぎると旋回低速側が消える |

### 停止挙動（実機評価で確定済み。加速整形とは独立）

| パラメータ | 既定値 | 実行時変更 | 効き |
|---|---|---|---|
| `brake_on_stop` | false | ○ | 停止時の電気ブレーキ（velocity モードのみ）。傾斜運用なら true を再検討 |
| `stop_resend_interval_ms` | 300 | ○ | 停止フレーム再送スロットル。「2段階停止」対策 |
| `cmd_timeout_sec` | 1.0 | ○ | `/target_twist` 途絶時の安全停止 |

### 電流モード（実験的、`control_mode: "current"` のとき有効）

電流指令 = 摩擦補償（目標だけから）+ `current_kp` × 誤差 + 積分項（電流 [A] で保持）。
手順と注意は下の「current モード（実験的）の評価前提と安全注意」。

| パラメータ | 既定値 | 実行時変更 | 効き |
|---|---|---|---|
| `current_kp` / `current_ki` | 0.0015 / 0.004 | ○ | ホスト側 RPM→電流 PI ゲイン [A/rpm]・[A/(rpm·s)]。0 以上（負は正帰還なので拒否）。既定は浮かせた車輪の出発点 |
| `max_current_amp` | 1.0 | ○ | 電流指令の安全クランプ [A]。0〜4（`kMaxCurrentLimitAmp`、相電流保護 4.6 A より下） |
| `integral_limit_amp` | 0.3 | ○ | 積分項の上限 [A]。出力が上限に張り付く間は積分しない（条件付き積分） |
| `current_zero_deadband_rpm` | 5 | ○ | 静止時の微振動防止 |
| `current_invert_measured` | false | ○ | 実測符号反転。誤ると正帰還（暴走ガードの `against` で止まる）。2026-10 まで true |
| `current_measured_source` | `position` | × | PI と暴走ガードの帰還（current モードだけ。velocity モードでは無視し、起動のログに出す）。`position` は車輪の角度の直前 2 区間から求めた速さ（遅れ 約 20 ms、無効なら電流を出さない）、`reported` はモーターの報告回転数（遅れ 100〜120 ms、比較用） |
| `current_ff_static_amp` | 0.0 | ○ | 摩擦補償: 静止（クーロン）摩擦分 [A]。\|目標\| < 10 rpm では比例で立ち上げる |
| `current_ff_viscous_amp_per_rpm` | 0.0 | ○ | 摩擦補償: 粘性摩擦分 [A/rpm] |
| `current_guard_overspeed_margin_rpm` / `current_guard_overspeed_time_sec` | 50 / 0.3 | ○ | 暴走ガードの目標超過の判定（> 0。ガードは無効にできない） |

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
| `measured_lpf_tau_sec` | 0.15 | ○ | 実測RPMローパス（**レポートと /odom の twist のみ**、制御には生値、/odom の姿勢には position_raw）。`velocity_rpm_raw` に生値が併記される。2026-10 まで /odom の位置はローパス後の実測を状態タイマーで「最新の実測 × 経過時間」で積分しており、旋回しながら進むと向きの遅れが位置のずれになった（擬似モータの S 字 3.2 m で約 0.5 m）。その後、生値を受信時刻で台形積分する方式では同じ条件で約 0.017 m となった。現在は角度増分の直接積分（下記）に置き換え、rpm による姿勢外挿は行わない |
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

### メッセージを変えずに縮小を調べる

`DriveControlSample`・`DriveControlWheelSample`・`MotorFeedback`・`DriveStatus` の定義と型hashは
変更しない。`shaped_linear` / `shaped_angular` は**目標縮小・加速度制限・テーパーの後、
出力の守りの前**の内部状態。`left.ref_rpm` / `right.ref_rpm` は**出力の守りの後、LQR補正の前**。
出力保護中は `shaped_*` を単に運動学変換した値と `ref_rpm` が一致しない。

有効な寸法と同じ実行の実効上限 `M` を使えば、駆動tickの出力保護率は次で計算できる。

```text
L = (shaped_linear - shaped_angular × d/2) × 60 / (2πr)
R = -(shaped_linear + shaped_angular × d/2) × 60 / (2πr)
peak = max(|L|, |R|)
s_output = peak > M ? M / peak : 1
left.ref_rpm  = round(L × s_output)
right.ref_rpm = round(R × s_output)    # 丸め後も ±M 内
```

`s_target` は上記の目標の式へ、**そのtickが採用した `/target_twist` の `(v, ω)`**を入れて求める。
サンプルだけでは縮小前の目標は復元できないため、`/target_twist` と同時に記録し、設定の
`wheel_radius` / `wheel_separation` / `max_motor_rpm` も保存する。上限が475を超える設定では
パラメータの生値でなくライブラリの実効上限を使う。`/target_twist` は仲裁などを通過した入力で、
元のスティック値とは限らない。メッセージにtickとの対応IDはなく、再武装時の中立はゼロとして
保存されるため、bagの受信順だけで採用目標を厳密に特定できない場合は推定として扱う。
idle・安全停止tickを駆動tickと混ぜず、`tick_action` / `stop_frame` も確認する。

縮小したtickだけ `Drive wheel saturation: target_scale=... output_scale=...` のINFOを
1秒throttleで出す（目標・整形後の値・縮小後参照も表示）。間引かれたログはtickごとの記録の
代わりにはならない。メッセージ型が同じでも、旧bagにはこの縮小処理がないので、記録した
ソースcommitと設定を確認して式を適用する。既存のLABブリッジ・シミュレーター・bag解析側の
型更新は不要で、診断サンプルを制御・安全判断へ使わない契約も同じ。

### ID13での実機確認（作業者が実施）

velocity モード・RUN LQR無効で、`/drive_control_sample`・`/drive_status`・`/target_twist` を
rosbagへ保存し、ソースcommitと実際の設定も記録する。

1. 車輪を浮かせ、前進だけを最大まで入れる。
2. 前進最大のまま旋回を最大まで加える。合成入力が上限を超える条件で、左右の `ref_rpm` /
   `command_rpm` の比と、最大絶対値475 rpm（上限を下げた場合はその値）を確認する。
   `2 m/s, 6 rad/s` を保持した場合の目安は上記の `68, -475 rpm`。
3. そこから中立へ戻し、上限の目標が残らないことを確認する。旋回6 rad/sから前進を加える
   順序も試し、出力保護が過渡だけで収まることを記録する。
4. 非常停止・走行許可OFFによる停止と、解除後の中立待ちを回帰確認する。
5. 床では広い場所で低速から始め、前進しながらの曲がり方と、戻してから止まる距離・角度を
   動画か床の印で記録する。浮上試験やソフトの模型を床上の合格の代わりにはしない。

11月3日までにID13の確認が完了しなければ、11月11日の授業版からこの変更を外す。

### 構成（再起動が必要 = 実行時変更は拒否される）

| パラメータ | 既定値 |
|---|---|
| `serial_port` / `baud_rate` | `/dev/ttyACM0` / 57600（中国語版 M0602C 規格書 V1.0 と一致） |
| `left_motor_id` / `right_motor_id` | 4 / 5 |
| `max_motor_rpm` | 475（`DdtMotorLib::kSpecVelocityMaxRpm` にクランプ。中国語版 M0602C 規格書 V1.0 の ±475 rpm と一致） |
| `control_mode` | `"velocity"`（`"current"` で電流モード） |
| `control_rate` | 50.0 Hz（シリアル往復 2 モータ直列が周期予算に収まる必要あり） |
| `serial_response_timeout_ms` | 10（従来の固定値）。フィードバック応答待ちの上限 [ms]、範囲 [2, 50]（外はクランプ + WARN）。下限の目安は応答フレーム伝送 1.74 ms + ファーム処理の実測値 + 余裕。実測は bag の `/drive_control_sample` の `roundtrip_ms` / `response_timeout`（周期ごと・左右ごと）。INFO「シリアル往復レイテンシ統計」は lifecycle の deactivate のときだけ出る（サービスの停止や launch の Ctrl+C では出ない） |
| `wheel_radius` / `wheel_separation` | 0.05 / 0.5 m（半径は直径 100 mm の実寸。2026-10 まで 0.1 の誤り。#179） |
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

観測時の注意: `/drive_status` の `velocity_rpm` はローパス済みで、床の上で報告されている約 1.5〜1.75 Hz の
速度変動を約半分に見せる（τ = 0.15 s の一次 LPF の理論値で、1.65 Hz の利得は約 0.54。2026-10 の実機試験。
以前は「ファーム速度ループの ~1.8Hz 振動」と書いていたが、原因は未確定）。半分になるのは LPF 後の
`velocity_rpm` と `/odom` だけで、`velocity_rpm_raw` と `/drive_control_sample` は LPF の前の値。
振動解析・システム同定には `velocity_rpm_raw`（または位置の差分）を使い、サンプルの鮮度も確かめること。

シリアル往復レイテンシの統計は deactivate 時に INFO ログへ出力される
（`DdtMotorLib::getSerialLatencyStats`、制御周期引き上げ検討の実測材料）。

## velocity / current モード実装のレビュー（既知の制約と根拠）

足回りの前後振動の切り分け（車輪を浮かせた試験と床上試験。手順は `scripts/identify/README.md`）の
前に、制御実装を見直した結果。方針は「既定の走行挙動を変えない」: 修正は既定 OFF の機能内の
明確なバグだけで、挙動を変える改善は起動時の警告・文書・既定 OFF のパラメータに留めた。

| 論点 | 判断 | 既定挙動への影響 |
|---|---|---|
| L1 RUN 判定は左右の大きい方。目標 0 の輪に ±`velocity_run_max_correction_rpm` が出得た | **修正**: 目標 0 の輪は補正せず 0、状態を捨てる | なし（LQR は既定 OFF） |
| L2 輪ごとの適用範囲の判定がなかった（旋回の遅い側に一次遅れモデル外の補正） | **修正**: 輪ごとに入り/抜けのヒステリシス付きで判定（\|目標\| ≥ run_enter で入り、run_exit 未満で抜ける）。範囲外の輪は FF のみ。符号反転でも状態を捨てる | なし（同上） |
| V-ticks `velocity_run_model_delay_ticks` などは tick 単位 | 起動時 WARN（LQR 有効かつ `control_rate` ≠ 50）。YAML の 50 Hz 前提の書き方を周期によらない表現に | なし |
| V3 停止の最後は停止フレームに切り替わり、減速はファーム（加速度バイト 1 = 最速）任せ | 文書化のみ。「停止フレームだけ加速度バイトを大きくする」案は未検証（実装するなら既定 OFF のパラメータで） | なし |
| V4 停止フレームの高頻度送信でファームが減速を完了できない（ファームは受信フレームごとに内部状態を更新している可能性） | 文書化。定速中の送信頻度を変える試験の手順を `scripts/identify/README.md` に | なし |
| V5 LQR は一次遅れモデル。床の上の約 1.5〜1.75 Hz の速度変動（原因は未確定：共振、回転の次数の脈動、摩擦・接触、制御・推定のどれかは識別できていない）を再現・抑制できるかは未検証、オブザーバは外乱と見なす | YAML / README に「振動対策ではない」。`test_control_core` の共振モデル（仮定値の 2 次系）で固定: 状態 FB だけでは揺れは減らず（≈10 → 12 rpm）、**外乱補償（`velocity_run_disturbance_gain` > 0）は共振付近の揺れを補正上限まで励起する（≈10 → 84 rpm）**。これは仮定値のモデルの上の結果で、実機の周波数・増幅率ではない。原因の同定と安全の確認が済むまで外乱補償を有効にしない | なし |
| C1 current モード既定ゲイン（純 P 0.001 A/rpm、±1 A） | **2026-10 に変更**: 純 P は摩擦に負けて目標 100 rpm に対し浮かせて約 15 rpm、床の上ではほぼ動かない（推定モデル）。既定を浮かせた車輪で安定する PI（0.0015 / 0.004）にし、摩擦補償を追加。床用の値は下の手順で決める | current モードのみ |
| C2 current モードのランプ二重（ホストの加速度制限 + ライブラリの `current_max_accel_rpm_per_sec`） | 確認の結果、**二重になっていない**: ライブラリ側は既定 0（無効）で、設定する呼び出しがリポジトリに無い。ホストの加速度制限だけが効く | なし |
| C3 `current_invert_measured: true` が既定、実機での符号確認の記録なし | **2026-10 に false へ変更**（velocity モードで指令と実測が同符号、ファームの速度ループも同じ電流指令の上にあるため）。実機は未確認なので、誤っていても暴走ガードが止める | current モードのみ |
| C7 浮かせた車輪の暴走（正帰還・床用ゲインの発振・古い実測での電流） | **追加**: 暴走ガード（`against` / `overspeed` / `oscillation`、電流 0 でラッチ → フォールト停止）と、応答の途切れのラッチ（下の「current モード」。2026-10 に、応答が戻っただけで電流を出し直す挙動を直した。Issue #222 の P0-2）。`test_ddt_current_guard`（擬似的な車輪）で確認 | current モードのみ |
| C8 負の `current_kp` / `current_ki` を受け付けていた（正帰還）。積分を `rpm·s` で持ち、`current_ki` の変更で電流が跳ねた | **修正**: 負のゲインは configure・実行時とも拒否。積分項は電流 [A] で持つ | current モードのみ |
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
  `/drive_control_sample` で確認できる。**WARN は駆動指令を送る tick だけで判定する**（待機の
  tick（非常停止中・未武装・ゲートが閉じている）は判定の前に return するので、超過しても WARN は
  出ない）。2026-10-06 には、非常停止の解除の直後に DDT が応答しない間の待機の tick が 21〜24 ms
  かかり（68 tick）、WARN は 0 件だった。超過の有無は journal ではなく、bag の `tick_duration_sec`
  （全 tick を記録）で見る。
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

ゲインと摩擦補償の考え方、暴走ガード、実機で進める順番。数値は M0602C 仕様書（K<sub>t</sub> 0.44
Nm/A、無負荷電流 ≤ 0.25 A）と推定値（浮かせた車輪の慣性 約 4.7e-4 kg·m²、床の上は機体質量/2 ×
r²）からの見積もりで、実機では測っていない。`scripts/current_mode_sim/`（擬似モータ + 本物の
drive_component + ブラウザのモニタ）で同じ条件を手元で再現できる。

- **ゲインは負荷で 20 倍変わる（C4/C5）**: 1 A で車輪が 1 秒に速くなる量は、浮かせた車輪で約
  9000 rpm、6 kg の機体の床の上で約 500 rpm。50 Hz・1 tick のむだ時間では、P のループ利得
  （0.02 s × その値 × `current_kp`）が 0.25 を超えると振動的、1 で不安定。既定の
  0.0015 / 0.004 は浮かせた車輪で安定（床の上では遅いが安全側）。床の上の目安は 0.02 / 0.05 で、
  これを浮かせた車輪で使うと発振する（ガードが `oscillation` で止める）。
- **帰還（`current_measured_source`、Issue #222 の G1）**: 既定の `position` は、車輪の角度（応答の
  position）の直前 2 区間（3 つの応答）から求めた速さ（`motor_control_lib/wheel_speed_estimator.hpp`）。
  記録での評価は、遅れ 約 20 ms・浮上 191 rpm のばらつき 3.0〜5.2 rpm で、報告回転数（遅れ
  100〜120 ms・ばらつき 0.5〜1.2 rpm）より遅れが小さい。応答の間隔が 10〜50 ms の外・fault・mode≠1・
  1 区間の速さが 570 rpm 超・最新の応答が 50 ms より古い、のどれかで無効になり、無効なら電流を
  出さない（0 rpm で代用しない）。電流を出している最中に無効になれば応答の途切れのラッチを立て、
  止まっている状態からは、有効な区間が 2 つそろうまで（3 つの応答、約 40 ms）電流 0 で応答を集める。
  `reported`（報告回転数）は比べるためだけに残す。擬似的な車輪で報告回転数を 100 ms 遅らせると、
  既定のゲインの浮かせた車輪は `position` で 100 rpm に収まり、`reported` では 210 rpm まで
  行き過ぎて揺れ続ける（推定モデル。実機では未確認。`test_ddt_current_guard`）。
- **D 項は使わない**: 50 Hz では実測 1 rpm の変化が 50 rpm/s の微分になり、1 tick のむだ時間と
  合わせると浮かせた軽い車輪を不安定にする（推定モデルの数値実験で、Kd = 5e-5 A/(rpm/s) から
  発散）。応答の改善は摩擦補償で行う。
- **摩擦補償**: 目標 RPM だけから決まる電流を足す（実測は使わないので補償そのものは発振の原因に
  ならない）。過補償は車輪が目標を超えて回る形で出る（ガードが `overspeed` で止める）。浮かせた
  ときと床の上で値が違う。
- **符号（C3）**: 既定 false。誤ると正帰還で、「回転を止める向きの電流なのに速くなる」形で
  現れ、ガードが `against` で止める（擬似的な車輪では 50 rpm 未満、0.3 s 以内）。
- **暴走ガード**: 作動するとその車輪は電流 0 でラッチし、`isHealthy()` が false になって走行は
  フォールト停止する（ノードのログ `Current guard tripped: <wheel> wheel ..., reason <理由>`）。
  解除は lifecycle の再構成か、current モードのパラメータ（ゲイン・上限・符号・摩擦補償・ガード）
  の変更。ガードはホストが動いている間だけ働く。
- **応答の途切れのラッチ（Issue #222 の P0-2・P0-3 の軽減）**: どちらかの車輪で、有効な応答が 3 回
  続けて無い・電流を出している間に最新の応答が 50 ms より古くなった・応答が電流ループを報告しない、
  のどれかが起きると、ライブラリ全体で 1 つのラッチを立て、**両輪**に電流 0 を送り、`isHealthy()`
  を false にする（走行は "Motor not healthy" でフォールト停止し、目標を捨てる）。応答が戻った
  だけでは解除しない。解除は、停止の指令だけの間に、両輪から新しい有効な応答（mode=1・fault=0）が
  3 回ずつ続けて届いたとき（0 でない目標を受けると数え直す）。電流 0 で止まっている間は応答を
  `stop_resend_interval_ms` ごとにしか取り直さないので、走り出しの最初の周期は電流 0 で応答を
  取り直し、次の周期から電流を出す（ラッチしない）。応答の確認と送信は一度に行えないので、確認の
  直後にモータだけが再起動する競合はソフトだけでは無くせない（最大 1 回の電流指令が速度目標として
  読まれうる。その応答でラッチする）。
- **指令の途絶（C6）**: ホストからの指令が途絶えたときにドライバが何をするか（電流を 0 にするか、
  最後の電流を保持するか）はデータシートに無い。保持する場合、ホストが止まると current モードは
  速度の上限なく加速し得る（特に浮かせた車輪）。ガードもホストの中なので効かない。
  `max_current_amp` を小さく保ち、非常停止をすぐ押せる状態で試す。
- **停止**: current モードの停止フレームは電流 0（惰性で止まる）。目標をランプで下げる通常の停止は
  PI が減速させるが、`cmd_timeout_sec`・許可の喪失・フォールトの停止は惰性になる（velocity モードは
  ファームが減速する）。床の上で試すときは十分な空間を取る。

**実機で進める順番**（各段で `/drive_control_sample` を記録する。`command_current_raw` と
`velocity_rpm_raw` を見る）:

1. **浮かせる・符号**: 車輪を浮かせ、非常停止が効くことを確認。`control_mode: current`、既定の
   ゲイン、`max_current_amp: 0.3`。小さな目標（20〜50 rpm）を与える。目標へ向かって回れば符号は
   正しい。ガードが `against` で止めたら `current_invert_measured` を反転する。左右とも確認する。
2. **浮かせる・摩擦**: 一定の目標（例 50 rpm と 200 rpm）で数秒回し、定常の電流（積分項が摩擦と
   釣り合った値）を読む。2 点を直線で結び、傾きを `current_ff_viscous_amp_per_rpm`、0 rpm の
   切片を `current_ff_static_amp` にする（浮かせたときの値）。入れた後に追従が速くなり、
   `overspeed` が出ないこと。
3. **床の上**: 作業責任者の許可・停止の手段・十分な空間を確保。浮かせ用のゲインのまま低速から。
   遅ければ `current_kp` / `current_ki` を段階的に上げる（目安 0.02 / 0.05）。床の上の摩擦を手順 2
   と同じ方法で測り直す。床用のゲインのまま持ち上げると `oscillation` で止まることも確認する。

### 規格書とリポジトリの通信・速度設定

以前のREADMEには115200 baud・±330 rpmという記載があったが、出典の版・言語は未確認で、
別資料にその値があるかも未確認。ここでは中国語版 M0602C 規格書 V1.0 の値を採用する。

中国語版 M0602C 規格書 V1.0 の通信速度は 57600 bps、速度範囲は ±475 rpm で、
リポジトリの `baud_rate: 57600`、`max_motor_rpm: 475`（`kSpecVelocityMaxRpm`）と一致する。
`DdtMotorLib` のコンストラクタの既定引数も 57600 bps に揃えている。drive_component は
パラメータの 57600 を明示的に渡すため、この既定引数の修正で走行の挙動は変わらない。
往復時間・`serial_response_timeout_ms` の下限の見積もり（10 byte で 1.74 ms）も
57600 bps を前提にしている。

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

- `test_control_core`: ファーム速度ループの簡易プラントモデル（仮定値。#179 の修正より前の `wheel_radius` 0.1 m などの値を使う回帰用のモデルで、現在の実機の動作点・不安定域を保証しない）込み閉ループシミュレーション
  （指令列のレート不変性・整定時間・停止ヒステリシスの回帰）
- `test_drive_param_policy`: 実行時パラメータ変更ポリシー（live 反映 / 拒否）の回帰
- `motor_control_lib` の `test_ddt_current_guard`: current モードを擬似的な車輪（疑似端末上の
  M0602C 応答 + 1 輪の運動モデル）で動かし、浮かせた車輪の符号誤り・床用ゲイン・走行中の
  持ち上げ・応答の途絶・モータだけの再起動で止まること（片輪の途絶で両輪が止まり、応答が戻った
  だけでは解除しないこと）、正常なゲインでは止まらないことを確かめる

### Runtime parameter transaction

`set_parameters_atomically` の要求は、全値を検証・stageしてから反映します。
拒否時はmember、制御ライブラリ設定、ROS parameter storeを保持します。
`current_kp` / `current_ki` / `integral_limit_amp` / `current_ff_*` は有限かつ0以上
（負のゲインは正帰還になるため拒否）、`max_current_amp` は0〜4 A（`kMaxCurrentLimitAmp`）、
`current_guard_overspeed_*` は有限かつ正（ガードは無効にできない）、
`current_zero_deadband_rpm` は0〜INT_MAX、`current_invert_measured` はboolを受理します。
current モードでは configure 時にも同じ規則で検証し、外れていれば configure を失敗させます。
既存integer runtime設定はintへ安全に変換できる範囲とし、負値による無効化は維持します。

レイテンシの `ema_ms` / `ema=` は指数移動平均（alpha=0.05）です。
応答が0件でもtimeoutがあればdeactivate時にsummaryを出力します。

### 停止中の位置増分の回収（Issue #229 B′、既定 OFF）

`odom_stop_gap_recovery: false` のときは #210 の積分処理をそのまま使います。
ON は **odom の位置・向きだけ**に効き、velocity/current 両モードで利用できます。
停止の再送 300 ms、ブレーキ、制御の帰還、安全判定、メッセージは変えません。
設定は `launcher/config/drive_component.yaml` に置き、実行時の変更は拒否します。

- `odom_stop_gap_speed_margin: 1.25`（有限、>0）：倍率 k。床で 1.0 と 1.25 を比較して決めます。
- `odom_stop_gap_noise_counts: 8`（整数、>=0）：雑音の T_noise。
- 固定値は履歴 0.5 s、実時間の保持上限 0.5 s、ゼロ速度 K=2 / T_zero=8 count。
  T_noise と T_zero は別の量で、ゼロ速度でも判定を免除しません。

従来の時間上限で捨てる区間だけを対象とし、各輪の終了 tick の ref がゼロで、
開始 stamp の直前 0.5 s の ref/raw RPM 履歴があるとき、`d=shortestTurns(old,new)` と
`U=max(abs(ref),abs(raw))/60 * dt * k + T_noise/32767` を求めます。
`abs(d) <= U < 1-abs(d)` のときだけ d を積分します。等号に epsilon は加えません。
受信と消費のカウントを区別し、速い輪は最新の端点を保持して両輪の新応答を待ちます。
片輪だけ受け入れるときは他輪を 0 とし、両端点を消費して二重回収を防ぎます。
無効値、巻き戻り、fault、mode 不整合、0.5 s 超の鮮度/保持には回収を使いません。
明示 reset・fault・巻き戻り・再走行で履歴を消します。pose 全体は reset しません。
ログは左右別の上限外・曖昧・hard gate を区別し、1 秒の抑制を維持します。

U は過去からの推定で、外力に対する物理的上限ではありません。U の過小評価では
半回転超の逆回転を誤って受け入れ、隠れた全回転も見逃します。小さな位置のずれは
そのまま積分します。単体試験と PTY FakeMotor は実機ファームや床での精度を保証しません。
実機の採用判断は独立した床の位置・向きとの比較後に行います。

### Wheel-position odometry pose (default OFF path)

The `/odom` pose and its TF now integrate paired `position_raw` increments directly;
`velocity_rpm`/`velocity_rpm_raw`, `/odom.twist`, `DriveStatus` velocity, and all message
schemas keep their previous meanings. Pose and published velocity intentionally have
different sources. No RPM-based pose extrapolation is published: pose is held at the
last paired wheel endpoints, even though the publication stamp continues to advance.

The 2026-10-13 ID13 lifted 6/8/10 rpm measurements showed a native integer-RPM bias
of about -0.49 rpm. Integrating it gives a left heading drift in both directions.
The position reanalysis gives -0.81 to +0.94 degrees per 20-second segment instead
of the recorded +10.8 to +12.9 degrees. On the two floor traces, position yaw is
+17.430/+17.101 degrees versus recorded +26.228/+24.277 degrees. The floor differences
are not attributed solely to 0.6 degrees/s times the command duration; slip and the
physical rightward heading remain unconfirmed. No strict +/-1 degree acceptance is
claimed for a complete out-and-back run.

`ddt_protocol::kPositionRawPerTurn` is the shared C++ scale (32767), matching the
existing `360/32767` conversion and spec V1.0's endpoint mapping. The 32767 endpoint
normalizes to zero for unwrapping. The exact physical period is not independently
calibrated; the simulator already uses this scale and native direction, pinned by
its regression test. Rotor-to-wheel 1:1 and equal tire diameters are operator-confirmed
premises, not independent calibration results.

For each wheel, take the signed shortest position difference. Negate the right native
increment once; with wheel radius R and separation B, integrate
`ds = R*(dphi_left + dphi_right_forward)/2` and
`dtheta = R*(dphi_right_forward - dphi_left)/B` as an exact circular arc.
The position error at endpoints remains an endpoint error instead of a cumulative
short-window velocity bias. Both `feedback_count`s must advance before a pair is
consumed; one-sided updates wait, retaining the latest endpoints.

At max_motor_rpm=475, half a turn takes 63.158 ms. Beyond that, a nearest whole-turn
candidate is selected using the trapezoid of the two native RPM endpoints, **only
under a conditional acceleration contract**. Its strict residual threshold is
`kMaxPredictionErrorTurns = 0.25` turn. Whole-turn estimates at or beyond that residual
are ambiguous and discarded. They must also satisfy the configured maximum speed,
allowing two degrees for endpoint angle error.

The assisted/pairing interval is at most `kMaxAssistedGapSec = 0.2 s` and becomes
shorter for larger configured accelerations or smaller radii. Include turning in
both wheel bounds:
`a_turns = (max_linear_accel + B/2 * max_angular_accel)/(R*2*pi)`.
For defaults 1.5 m/s^2, 1.5 rad/s^2, R=0.05 m and B=0.5 m, this is 5.968 turns/s^2.
For a wheel actually satisfying that bound, endpoint-RPM trapezoid error is at most
`a_turns*T^2/4`. The theoretical 0.25-turn limit is about 0.409 s. We use half that
limit, capped at 0.2 s, budgeting at most 0.0625 turn for acceleration and leaving
margin for integer-RPM bias and angle noise. Limits are recomputed from the effective
configuration each tick. Disabled acceleration limits prohibit assisted multi-turn
recovery; only intervals provably shorter than a half-turn at max_motor_rpm can then
use shortest-wrap. Pairing still has a 0.2 s cap.

These are **command acceleration limits, not measured physical acceleration limits**.
Tracking overshoot, emergency braking and external forces (hand-turning or pushing)
are outside the acceleration contract. Equal zero-RPM/position endpoints within the
time cap are treated as stationary, even though an externally forced hidden whole
turn is unobservable. The recorded 200 ms counterexample is reset above the cap and
is stationary at/below the cap. This is an explicit limitation, not a recovery guarantee.

Configure, activate, motor reinitialization, missing/invalid feedback, motor/stop
faults, age beyond `odometry::kMaxFeedbackAgeSec` (0.5 s), a missing wheel or pair
interval beyond the above cap, and ambiguous unwrapping reset the position anchors.
All these resets preserve pose; the first valid pair only anchors. Unexpected
feedback-reset WARNs are throttled; routine lifecycle and expected idle resets
are DEBUG, with availability/stop-fault warnings once per state transition. The normal 300 ms idle polling interval can intentionally discard an
idle interval at the 200 ms pairing cap; no idle polling or safety behavior changes.
A new node instance starts from zero pose; cleanup/reconfigure of the same instance
retains pose. Old odometry-integrator tests remain enabled.

Expected zero-command idle gaps (both the last accepted pair and current native RPM
are zero) reset silently at normal log levels and are available at DEBUG. Routine
lifecycle/init retries are DEBUG too. Motor unavailable/stop fault are reported once
per state transition. Moving gaps, stale/fault/invalid feedback and ambiguous unwraps
retain throttled WARNs. These log decisions never change pose integration or safety.

For ID13 lifted hand-turn observations, keep drive permission OFF and do not assume
that odometry tracks manual rotation: if the feedback interval exceeds the effective
pairing cap, that interval is discarded and pose is held (expected behavior). Short
valid intervals may still contribute increments; manual rotation is outside the
acceleration contract, so this is not a physical angle-calibration acceptance test.
