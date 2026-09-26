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
（`uart_joy_driver` / `web_joy_driver` / joy パッケージの `deadzone`）で行われ、
本ノードには expo カーブ・ターボ/精密モード等はありません。

## 起動

統合起動は `launcher`（`questix_core.launch.xml`）経由が正規経路です。単体では:

```bash
# DualShock (joy_node) + joy_controller
ros2 launch joy_controller joy_controller.launch.xml controller_type:=dualshock

# UART コントローラ + joy_controller
ros2 launch joy_controller joy_controller.launch.xml controller_type:=uart

# ブラウザ・スマホ (web_joy_driver) + joy_controller（操作設定 controls.web.yaml）
ros2 launch joy_controller joy_controller.launch.xml controller_type:=web

# デュアルスティックモード
ros2 launch joy_controller joy_controller.launch.xml dual_stick:=true

# GPIO レフェリーゲート付き（/joy_gated 経由）
ros2 launch joy_controller joy_controller_referee.launch.xml
```

## パラメータ

操作割り当て・速度の単一ソースは
[`questix_control_config`](../questix_control_config/README.md) のコントローラー別プロファイルです。
robot_manager の「操作・速度」タブで編集できます。
このパッケージの YAML にはデバッグ等のノード設定を残しています。

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

`ros2 param set` で即時反映されるパラメータは、現行実装では次のとおりです。

| モード | 実行時に即時反映されるパラメータ |
|---|---|
| single-stick | `longitudinal_input_ratio`, `lateral_input_ratio`, `angular_input_ratio`, `linear_x_axis`, `linear_y_axis`, `angular_z_axis`, `debug_mode` |
| dual-stick | `longitudinal_input_ratio`, `angular_input_ratio`, `debug_mode` |

dual-stickの `left_stick_vertical_axis` / `right_stick_vertical_axis` はstartup/config専用です。
YAMLを変更してノードを再起動してください。両モードの `joy_topic` はlaunch/startup時の
指定専用で、実行時に変更しても購読先は切り替わりません。

即時反映されるパラメータの変更例:

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

standard / referee 両 XML launch は、ノード設定の後に共通操作プロファイルを読みます。
独自のキー割り当て・速度設定は `control_config_file:=...` で指定してください。
dual-stick の起動時ノード名は `/joy_controller_dual_stick` です。
