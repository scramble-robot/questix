# Joy Controller

ジョイスティック入力 (`sensor_msgs/Joy`) を速度指令 (`geometry_msgs/Twist`) に変換する QUESTiX のパッケージです。

2 つのノード（コンポーネント）を提供します:

| ノード | 実装 | 用途 |
|---|---|---|
| `joy_controller_node` | `src/joy_controller_component.cpp` | 通常モード: 左スティックで前後、右スティックで旋回 |
| `joy_controller_dual_stick_node` | `src/joy_controller_dual_stick_component.cpp` | デュアルスティック（戦車）モード: 左右スティック縦軸 = 左右車輪 |

## トピック

| 方向 | トピック | 型 | 備考 |
|---|---|---|---|
| Sub | `joy_topic` パラメータで指定（既定 `/joy`、referee 構成では `/joy_gated`） | `sensor_msgs/Joy` | |
| Pub | `/target_twist` | `geometry_msgs/Twist` | depth 1。`drive_component` が購読 |

軸→速度は**純粋な線形写像**です。デッドゾーン処理は入力ドライバ側
（`uart_joy_driver` の `deadzone` / joy パッケージの `deadzone`）で行われ、
本ノードには expo カーブ・ターボ/精密モード等はありません。

## 起動

統合起動は `launcher`（`questix_core.launch.xml`）経由が正規経路です。単体では:

```bash
# DualShock (joy_node) + joy_controller
ros2 launch joy_controller joy_controller.launch.xml controller_type:=dualshock

# UART コントローラ + joy_controller
ros2 launch joy_controller joy_controller.launch.xml controller_type:=uart

# デュアルスティックモード
ros2 launch joy_controller joy_controller.launch.xml dual_stick:=true

# GPIO レフェリーゲート付き（/joy_gated 経由）
ros2 launch joy_controller joy_controller_referee.launch.xml
```

## パラメータ

実効値の単一ソースは `config/joy_controller_params.yaml`（dual stick は
`config/joy_controller_dual_stick_params.yaml`）です。コード側の
`declare_parameter` デフォルトは YAML と同値に保つ運用です。

### joy_controller_node

| パラメータ | 既定値 | 意味 |
|---|---|---|
| `longitudinal_input_ratio` | 2.0 | フルスティック時の前後速度 [m/s] |
| `lateral_input_ratio` | 0.3 | フルスティック時の左右速度 [m/s]（ホロノミック用。差動駆動では未使用） |
| `angular_input_ratio` | 6.0 | フルスティック時の旋回速度 [rad/s]。符号で旋回方向 |
| `linear_x_axis` | 1 | 前後の軸番号（通常 左スティック Y） |
| `linear_y_axis` | 0 | 左右の軸番号（通常 左スティック X） |
| `angular_z_axis` | 3 | 旋回の軸番号（通常 右スティック X） |
| `joy_topic` | `/joy` | 入力トピック（launcher が `/joy_gated` へ切替える唯一のインライン override） |
| `debug_mode` | false | デバッグログ |

### joy_controller_dual_stick_node

| パラメータ | 既定値 | 意味 |
|---|---|---|
| `longitudinal_input_ratio` | 0.05 | 車輪速度スケール |
| `angular_input_ratio` | 0.05 | 旋回成分スケール |
| `left_stick_vertical_axis` | 1 | 左車輪の軸番号 |
| `right_stick_vertical_axis` | 4 | 右車輪の軸番号 |
| `joy_topic` | `/joy` | 入力トピック |
| `debug_mode` | false | デバッグログ |

## パラメータの動的変更

上記パラメータはすべて `ros2 param set` で即時反映されます:

```bash
ros2 param set /joy_controller longitudinal_input_ratio 1.0
ros2 param set /joy_controller debug_mode true
```

注意: 実行時変更は永続化されません（drive 系は respawn 起動のため、
プロセス再起動で YAML の値に戻ります）。恒久化する場合は YAML に反映してください。

## トラブルシューティング

```bash
# ジョイスティックデバイスを確認 (DualShock)
ls /dev/input/js*

# 入力の監視
ros2 topic echo /joy

# 出力の監視
ros2 topic echo /target_twist
```

## 依存関係

- rclcpp / rclcpp_components
- sensor_msgs / geometry_msgs
- joy（DualShock 経路の joy_node）
