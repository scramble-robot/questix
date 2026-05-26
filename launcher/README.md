# Questix Launcher

Questixシステムの各ノードを起動するためのlauncherファイル群です。XMLベースのROS2 launchファイルを使用しており、Pythonよりも読みやすく設定が直感的です。

## ファイル構成

### メインlaunchファイル

- `launch/questix_core_launch.xml` - 全システムを起動するメインファイル
- `launch/navigation_launch.xml` - ナビゲーション用システム（LiDAR + モータ + Joy）
- `launch/test_launch.xml` - テスト・デバッグ用の最小構成
- `launch/servo_system_launch.xml` - サーボ制御システム
- `launch/ddt_motor_launch.xml` - DDTモータコントローラ単体

### 各パッケージ用launchファイル

- `joy_controller/launch/joy_controller.launch.xml` - ジョイスティックコントローラ
- `esc_motor_control/launch/esc_motor_control.launch.xml` - ESCモータコントローラ  
- `servo_control_ros2/launch/servo_launch.xml` - サーボコントローラ
- `ydlidar_ros2_driver/launch/ydlidar_launch.xml` - YDLiDAR
- `ydlidar_ros2_driver/launch/ydlidar_launch_view.xml` - YDLiDAR + RViz

## 実行時のsource依存

`questix_launcher` は以下のパッケージが同じcolcon workspaceにある前提でlaunchします。
これらはaptで入る依存ではなく、source/workspace依存です。

- `ydlidar_ros2_driver`
- `servo_control_ros2`
- `esc_motor_control`
- `ddt_motor_control`

LiDARなど実機依存のパッケージは追加取得とJazzy互換性確認が必要です。取得できても、
対象ハードウェアでの動作を保証するものではありません。

### ユーティリティスクリプト

- `launch_questix.sh` - 便利なシェルスクリプト

## 使用方法

### 1. 直接launchファイルを使用

```bash
# 全システムを起動
ros2 launch questix_launcher questix_core_launch.xml

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
