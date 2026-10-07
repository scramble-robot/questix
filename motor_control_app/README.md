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
| `max_linear_accel` | 1.5 | m/s² | ○ | 前後の追従性の主レバー。0以下で制限無効 |
| `max_angular_accel` | 1.5 | rad/s² | ○ | 旋回の追従性。上げると低RPMファームループを励起し得る |
| `slew_taper_band_linear` | 0.1 | m/s | ○ | 目標接近時のジャーク抑制幅 |
| `slew_taper_band_angular` | 0.1 | rad/s | ○ | 旋回振動抑制の主レバー |
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

### 共振ダンピング（velocity モードのみ、**既定は無効**）

床の上で回転数によらず約 1.4〜1.8 Hz で揺れ続ける症状（車輪を浮かせると揺れない）は、機体の
慣性が載ったファーム速度ループの減衰不足（2026-10-07 の実機計測、`scripts/identify/ripple_analysis.py`）。
ファームのゲインは変えられないため、ホストが追従誤差の変化率に逆らう補正を速度指令に足して
ダンピングを補う（`motor_control_lib/wheel_rate_damper.hpp`）。定常の速さは変えない。
停止中・目標 0 の輪・両輪のフィードバックが `velocity_run_feedback_max_age_sec` より古いときは
掛けない。実測の符号は `velocity_run_invert_measured` に従う。

| パラメータ | 既定値 | 実行時変更 | 効き |
|---|---|---|---|
| `velocity_damping_gain_sec` | 0.0 | ○ | 補正の強さ [s]（0..0.2）。0 で無効。推奨 0.08 から |
| `velocity_damping_filter_tau_sec` | 0.08 | ○ | 微分の前の一次ローパス [s]（0.02..0.5） |
| `velocity_damping_max_correction_rpm` | 30.0 | ○ | 補正量の上限 [RPM]（0..100）。補正で指令の符号が目標と逆になることはない |
| `velocity_damping_load_on_amp` / `velocity_damping_load_off_amp` | 0.6 / 0.3 | ○ | 負荷ゲート [A]（0..8）。平滑化した各輪の電流が off 以下で補正 0、on 以上で全量。on 0 でゲート無効 |
| `velocity_damping_load_tau_sec` | 0.3 | ○ | 負荷ゲートの電流の平滑化 [s]（0.02..5） |

床の上だけで効かせる（負荷ゲート）: 実機では、車輪を浮かせて補正を掛けると補正自体が振動を作った
（gain 0.08 で ~5.3 Hz・p2p 10 rpm、0.12 で約 80 rpm、異音）。浮かせた応答は一次遅れ τ 57 ms・
むだ時間 0（`batch_fit.py`）で、このモデルでは振動を再現せず原因は未確認。各輪の電流 |I| は床の上で
平均 0.48〜2.1 A、浮かせると 0.13〜0.25 A（振動していても 0.5 A 未満）なので、平滑化した |I| で
補正を掛け具合を決める。浮かせると 1 s 以内に補正が抜ける。走行中に変えても次の tick は補正 0 から。

試し方（狭い場所で可）: 床の上でその場旋回の記録を、補正なし・ありで取り、振れ幅（p2p）と卓越周波数の
振幅を比べる。解析は `scripts/identify/ripple_by_twist.py`（`ripple_analysis.py` を、区間の区切りに
補正前の目標 `/target_twist` を使って実行する。補正ありでは送った指令が毎 tick 変わるので、
`ripple_analysis.py` を直接使うと定速区間が見つからない）。

```bash
bash scripts/identify/record.sh --levels 60,95 --hold 8 --turn               # 補正なし
ros2 param set /drive_component velocity_damping_gain_sec 0.08
bash scripts/identify/record.sh --levels 60,95 --hold 8 --turn               # 補正あり
ros2 param set /drive_component velocity_damping_gain_sec 0.0               # 元に戻す
```

続けて車輪を浮かせて同じ回転数を回し、揺れが増えていない（量子化の 1〜2 rpm のまま）ことも確かめる。

### 遅れ上乗せ・行き過ぎ差し引き（velocity モードのみ、**実機試験用・既定は無効**）

床の上の低速（15〜40 rpm、その場旋回）の約 1.75 Hz の揺れは、共振ダンピングでは 15 rpm で変わらず
25/40 rpm で 3 割ほどしか減らなかった。|I| は 15 rpm でも 1.4 A と大きく、摩擦で車輪が引っかかる →
ファームが電流を積み増して滑り出す → 行き過ぎて逆トルクで止める、の繰り返しと見ている
（`scripts/identify/current_stats.py`）。そこで、実測が本来の応答（一次遅れ `model_tau`）より遅れた分を
指令に上乗せしてファームの積み増しを速め、行き過ぎた分を差し引く（`motor_control_lib/wheel_lag_assist.hpp`）。
共振ダンピングの後に足し、掛ける条件・リセット・符号の安全装置はダンピングと同じ。負荷ゲートは
`velocity_damping_load_*` を共用する。

摩擦 + PI + 慣性の簡易シミュレーションでは揺れは減らなかった（上乗せはファームの積分を通じて主に
「ばね」として効き、周波数が上がる）。ただし同じモデルは共振ダンピングで低速も収まると予測し実機と
合わないので、効くかどうかは実機で確かめる。

| パラメータ | 既定値 | 実行時変更 | 効き |
|---|---|---|---|
| `velocity_lag_assist_gain` | 0.0 | ○ | 遅れ 1 rpm あたりの上乗せ（0..3）。0 で上乗せなし |
| `velocity_lag_assist_overshoot_gain` | 0.0 | ○ | 行き過ぎ 1 rpm あたりの差し引き（0..3）。0 で差し引きなし |
| `velocity_lag_assist_deadband_rpm` | 3.0 | ○ | これ以内の遅れ・行き過ぎは無視 [RPM]（0..30） |
| `velocity_lag_assist_model_tau_sec` | 0.06 | ○ | 本来の応答の時定数 [s]（0.01..1）。通常の追従遅れを上乗せしないため |
| `velocity_lag_assist_max_rpm` | 15.0 | ○ | 上乗せ・差し引きそれぞれの上限 [RPM]（0..50） |

試し方（その場旋回、補正なしの記録 `ident_dev_carpet_20261008_0109` と比べる）:

```bash
ros2 param set /drive_component velocity_lag_assist_gain 1.0
ros2 param set /drive_component velocity_lag_assist_overshoot_gain 1.0
bash scripts/identify/record.sh --levels 15,25,40 --hold 6 --turn
python3 scripts/identify/current_stats.py ~/ident_data/<新しい記録>/bag
ros2 param set /drive_component velocity_lag_assist_gain 0.0                 # 元に戻す
ros2 param set /drive_component velocity_lag_assist_overshoot_gain 0.0
```

### 観測・レポート

| パラメータ | 既定値 | 実行時変更 | 効き |
|---|---|---|---|
| `measured_lpf_tau_sec` | 0.15 | ○ | 実測RPMローパス（**レポート/odom経路のみ**、制御は生値）。`velocity_rpm_raw` に生値が併記される |
| `status_publish_rate` | 50.0 | × | `/drive_status` の publish レート |

### 構成（再起動が必要 = 実行時変更は拒否される）

| パラメータ | 既定値 |
|---|---|
| `serial_port` / `baud_rate` | `/dev/ttyACM0` / 57600（M0602C 仕様固定） |
| `left_motor_id` / `right_motor_id` | 4 / 5 |
| `max_motor_rpm` | 475（仕様上限にクランプ） |
| `control_mode` | `"velocity"`（`"current"` で電流モード） |
| `control_rate` | 50.0 Hz（シリアル往復 2 モータ直列が周期予算に収まる必要あり） |
| `wheel_radius` / `wheel_separation` | 0.05 / 0.5 m |
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
ros2 param set /drive_component max_angular_accel 2.25

# 2. 当たりが付いたら現在値を確認して YAML に転記
ros2 param dump /drive_component

# 3. launcher/config/drive_component.yaml を編集（symlink なので再ビルド不要）
#    → ノード再起動で反映。ライブ調整値は respawn で消えるため転記を忘れない
```

観測時の注意: `/drive_status` の `velocity_rpm` はローパス済みで、ファーム速度ループの
~1.8Hz 振動を約半分に見せる。振動解析・システム同定には `velocity_rpm_raw` を使うこと。

シリアル往復レイテンシの統計は deactivate 時に INFO ログへ出力される
（`DdtMotorLib::getSerialLatencyStats`、制御周期引き上げ検討の実測材料）。

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
