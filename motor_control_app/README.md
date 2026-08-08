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

## テスト

```bash
colcon test --packages-select motor_control_app
```

- `test_control_core`: ファーム速度ループのプラントモデル込み閉ループシミュレーション
  （指令列のレート不変性・整定時間・停止ヒステリシスの回帰）
- `test_drive_param_policy`: 実行時パラメータ変更ポリシー（live 反映 / 拒否）の回帰
