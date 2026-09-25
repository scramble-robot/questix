# QUESTiX Launcher

QUESTiXシステムの各ノードを起動するためのlauncherファイル群です。XMLベースのROS 2 launchファイルを使用します。

## GPIO安全系

`questix_core.launch.xml` の `enable_gpio_ref:=true` は、drive/shot の有無に
関係なく `gpio_reader` と `operation_manager` をそれぞれ1プロセス起動します。
drive が使う `joy_controller_referee.launch.xml` 内の operation_manager は統合時に
無効化されるため、同名ノードは重複しません。standalone referee launch は互換性の
ため既定で operation_manager を起動します。

`enable_autoreferee` の既定値は `false` です。

- `false` (practice): GPIO5だけを読み、physical E-stopをsafe-lowとして判定
- `true` (competition): GPIO5とGPIO27を読み、GPIO27 AutoRefereeを
  safe-highとして追加判定

`questix_robot_launcher.sh` は、`/etc/questix_robot/mode` が `competition` のとき
（電源投入時の自動起動を含む）、必ず `enable_gpio_ref:=true` と
`enable_autoreferee:=true` を固定値で渡します。`practice` のときは電源投入時には起動せず、
Robot Manager の「起動」が置いた起動要求があるときだけ、`enable_autoreferee:=false`
（twist_arbiter と教材からの発射あり）と `launch.env` の `ENABLE_GPIO_REF`（既定 true）で起動します。既存の `launch.env` に
`ENABLE_GPIO_REF=false` が残っていても competition 起動では無視され、GPIO5と
GPIO27の安全系は常時有効です。`enable_gpio_ref:=false` は手動の開発・診断用途に
限定されます。`enable_autoreferee:=true` と `enable_gpio_ref:=false` の組合せは
通常運用上無効であり、`questix_core.launch.xml` はその組合せを検出して起動を
中止します。

GPIO5の物理非常停止回路はRLY1で左右DDT駆動モーター、ローラー用ESC、Shot用サーボ、
Tilt用サーボの動力をハードウェア遮断します。Raspberry Pi、5 V I/O、3.3 V I/Oは
通電を維持するため、GPIO5は状態をROSへ通知し続けます。GPIO5のraw値は解除時
`false`、押下時 `true` です。物理遮断とROSソフトウェア停止は独立した二重の
安全経路です。

GPIO27は大会用AutoReferee `AR_in` で、クライアント撃破出力（撃破時5 V、
非撃破時0 V）をHATのフォトカプラで反転します。撃破時は `false`/停止、
非撃破時はR2（10 kΩ）の3.3 Vプルアップにより `true`/許可です。ただし
AutoReferee未接続、クライアント無通電、一次側断線も `true` となり、現行
ハードウェアでは非撃破と区別できません。この制約は `/diagnostics` の
`pin_27_signal_limit` にも表示されます。

| Mode | GPIO5 physical E-stop | GPIO27 AutoReferee | Controllable |
|---|---:|---:|---:|
| practice | false | not monitored | true |
| practice | true | not monitored | false |
| competition | false | true | true |
| competition | true | any | false |
| competition | any | false | false |
| any | missing or stale required input | - | false |

安全系だけを非通電で起動するコマンド例:

```bash
ros2 launch questix_launcher questix_core.launch.xml \
  enable_lidar:=false enable_shot:=false enable_drive:=false \
  enable_gpio_ref:=true enable_autoreferee:=false enable_rviz:=false
```

## コントローラーと QUESTiX LAB の走行実験（twist_arbiter）

`questix_core.launch.xml` は練習用の起動では切り替えノード `twist_arbiter` を入れます
（`enable_twist_arbiter` 既定 `true`）。joy_controller の出力は `/target_twist/joy` に付け替えられ、
QUESTiX LAB の教材ブリッジは `/target_twist/lab` に出し、`twist_arbiter` がどちらかを
`/target_twist`（drive_component）へ渡します。起動し直す必要はありません。

- ふだんはコントローラーの指令が通ります。
- 教材が走り始めると、スティックが中立なら教材の指令に切り替わります。
- 教材の走行中にスティックを倒すと、すぐにコントローラーへ戻り、教材の走行は止まります
  （その走行が終わるまで教材は割り込めません）。
- 教材の指令が途切れると、コントローラーに戻ります。

`enable_autoreferee:=true`（大会用の起動、`questix_robot_launcher.sh`）では
`enable_twist_arbiter` の値にかかわらず入れず、joy_controller が `/target_twist` を直接出す
今までの経路のままです。規則は `twist_arbiter/include/twist_arbiter/arbiter_logic.hpp`、
パラメータは `twist_arbiter/config/twist_arbiter.yaml` にあります。

## ファイル構成

### メインlaunchファイル

- `launch/questix_core.launch.xml` - 全システムを起動するメインファイル
- `launch/navigation_launch.xml` - ナビゲーション用システム（LiDAR + モータ + Joy）
- `launch/test_launch.xml` - テスト・デバッグ用の最小構成
- `launch/servo_system_launch.xml` - サーボ制御システム
- `launch/ddt_motor_launch.xml` - DDTモータコントローラ単体

### 各パッケージ用launchファイル

- `joy_controller/launch/joy_controller.launch.xml` - ジョイスティックコントローラ
- `esc_motor_control_cpp/launch/esc_motor_control_cpp.launch.xml` - ESCモータコントローラ
- `ydlidar_ros2_driver/launch/ydlidar_launch.xml` - YDLiDAR
- `ydlidar_ros2_driver/launch/ydlidar_launch_view.xml` - YDLiDAR + RViz

## 実行時のsource依存

`questix_launcher` は以下のパッケージが同じcolcon workspaceにある前提でlaunchします。
これらはaptで入る依存ではなく、source/workspace依存です。

- `ydlidar_ros2_driver`
- `esc_motor_control_cpp`
- `motor_control_app`

LiDARなど実機依存のパッケージは追加取得とJazzy互換性確認が必要です。取得できても、
対象ハードウェアでの動作を保証するものではありません。

### ユーティリティスクリプト

- `launch_questix.sh` - 便利なシェルスクリプト

## 使用方法

### 1. 直接launchファイルを使用

```bash
# 全システムを起動
ros2 launch questix_launcher questix_core.launch.xml

# ナビゲーションシステムを起動
ros2 launch questix_launcher navigation_launch.xml

# テスト構成を起動
ros2 launch questix_launcher test_launch.xml

# DDTモータのみ起動
ros2 launch questix_launcher ddt_motor_launch.xml
```

### 2. シェルスクリプトを使用（推奨）

```bash
# 基本的な使用方法
./launcher/launch_questix.sh <コマンド> [オプション]

# 全システムを起動
./launcher/launch_questix.sh full

# ナビゲーションシステムを起動（RViz付き）
./launcher/launch_questix.sh navigation --rviz

# サーボシステムを起動
./launcher/launch_questix.sh servo

# テスト構成を起動
./launcher/launch_questix.sh test
```

## コマンド一覧

| コマンド | 説明 |
|---------|------|
| `full` | 全システムを起動（デフォルト構成） |
| `navigation` | ナビゲーション用システム（LiDAR + モータ + Joy） |
| `servo` | サーボ制御システム |
| `test` | テスト用最小構成 |
| `ddt-motor` | DDTモータコントローラのみ |
| `lidar` | LiDARのみ |
| `joy` | ジョイスティックコントローラのみ |

## オプション

| オプション | 説明 | デフォルト |
|----------|------|-----------|
| `--sim-time` | シミュレーション時間を使用 | false |
| `--rviz` | RVizを起動 | false |
| `--no-rviz` | RVizを起動しない | - |
| `--joy-device DEV` | ジョイスティックデバイス | /dev/input/js0 |
| `--motor-type TYPE` | モータタイプ（ddt/esc） | ddt |

## 使用例

```bash
# 全システム + RViz
./launcher/launch_questix.sh full --rviz

# ESCモータでナビゲーション
./launcher/launch_questix.sh navigation --motor-type esc --rviz

# 別のジョイスティックデバイスでテスト
./launcher/launch_questix.sh test --joy-device /dev/input/js1

# シミュレーション時間でサーボシステム
./launcher/launch_questix.sh servo --sim-time
```

## XML launchファイルの利点

1. **可読性**: XMLは構造が明確で設定が直感的
2. **メンテナンス性**: 設定変更が簡単
3. **コメント**: XMLコメントでドキュメント化が容易
4. **構造化**: 階層構造で複雑な設定も整理しやすい

## トラブルシューティング

### ワークスペースがビルドされていない場合

```bash
cd <your_workspace_path>
colcon build --symlink-install
source install/setup.bash
```

### デバイスアクセス権限の問題

```bash
# シリアルポートの権限設定
sudo chmod 666 /dev/ttyACM0
sudo chmod 666 /dev/ttyUSB0

# ジョイスティックの権限設定  
sudo chmod 666 /dev/input/js0
```

### ログの確認

```bash
# ROS2ログの確認
ros2 node list
ros2 topic list
ros2 topic echo /cmd_vel

# システムログの確認
journalctl -f
```

## 注意事項

- 各ノードを起動する前に、対応するハードウェアが接続されていることを確認してください
- シリアルポートのアクセス権限が適切に設定されていることを確認してください
- 複数のモータコントローラ（DDT/ESC）を同時に起動しないよう注意してください

## 操作・速度の設定

Joy のキー割り当て、射出・ローラー操作、走行速度・加速度は
[QUESTiX 共通操作設定](../questix_control_config/README.md) に集約しています。
robot_manager の「操作・速度」タブでコントローラー別に編集・保存し、
ロボットの次回起動／再起動で反映します。保存による自動再起動は行いません。
管理画面には未保存表示・初期値への復元・入力検証・同時編集の競合検出があります。
