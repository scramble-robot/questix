# Motor Control Library - リファクタリング版

## 概要

このライブラリは、元の3つのモータ制御パッケージをデザインパターンに従ってリファクタリングし、統一されたモータ制御システムを提供します。

### 主な特徴

- **統一インターフェース**: すべてのモータが共通のインターフェースを使用
- **ファクトリーパターン**: 設定からモータインスタンスを動的生成
- **Drive/Shot分離**: 移動制御と射撃制御の機能を明確に分離
- **簡単セットアップ**: QuickSetupクラスで標準構成を自動設定

## アーキテクチャ

```
motor_control_lib/
├── include/motor_control_lib/
│   ├── motor_control_lib.hpp      # 統合ヘッダー
│   ├── base_motor_controller.hpp  # 基底クラス・インターフェース
│   ├── motor_factory.hpp          # ファクトリークラス
│   ├── ddt_motor_lib.hpp          # DDTモータライブラリ
│   ├── esc_motor_lib.hpp          # ESCモータライブラリ
│   ├── servo_motor_lib.hpp        # サーボモータライブラリ
│   ├── drive_controller.hpp       # ドライブコントローラ（レガシー）
│   └── shot_controller.hpp        # ショットコントローラ（レガシー）
└── src/
    ├── motor_factory.cpp
    ├── ddt_motor_lib.cpp
    ├── esc_motor_lib.cpp
    ├── servo_motor_lib.cpp
    ├── drive_controller.cpp
    └── shot_controller.cpp
```

## モータタイプ

### 1. DDTモータ (Drive用)

- **用途**: 差動駆動による移動制御
- **インターフェース**: IDriveMotor
- **特徴**: シリアル通信、M15データシート準拠、CRC8チェックサム

### 2. ESCモータ (Shot用)

- **用途**: ブラシレスモータの発射速度制御
- **インターフェース**: IShotMotor
- **特徴**: PWM制御、速度設定、テストモード対応

### 3. サーボモータ (Shot用)

- **用途**: 発射角度制御
- **インターフェース**: IShotMotor
- **特徴**: FEETECH磁気エンコーダ版、Modbus通信

## 基本的な使用方法

### 簡単セットアップ（推奨）

```cpp
#include "motor_control_lib/motor_control_lib.hpp"

int main() {
    // 統一コントローラの作成
    motor_control_lib::UnifiedMotorController controller;
    
    // 標準ロボット構成の自動セットアップ
    motor_control_lib::QuickSetup::setupStandardRobot(controller);
    
    // 初期化
    controller.initialize();
    
    // Drive制御
    controller.setVelocity(1.0, 0.5);  // 1.0 m/s前進, 0.5 rad/s回転
    
    // Shot制御
    controller.setShotParameters(0.8, 45.0);  // 速度0.8, 角度45度
    controller.executeFire();  // 発射
    
    return 0;
}
```

### 手動セットアップ

```cpp
// DDTモータ（Drive用）を追加
auto ddt_config = motor_control_lib::MotorFactory::createConfig("ddt", "main_drive", "drive");
ddt_config.string_params["serial_port"] = "/dev/ttyACM0";
ddt_config.double_params["wheel_radius"] = 0.1;
ddt_config.double_params["wheel_separation"] = 0.5;
controller.addMotor(ddt_config);

// ESCモータ（Shot用）を追加
auto esc_config = motor_control_lib::MotorFactory::createConfig("esc", "launcher", "shot");
esc_config.int_params["pwm_pin"] = 13;
controller.addMotor(esc_config);

// サーボモータ（Shot用）を追加
auto servo_config = motor_control_lib::MotorFactory::createConfig("servo", "turret", "shot");
servo_config.string_params["port"] = "/dev/ttyUSB0";
servo_config.int_params["servo_id"] = 1;
controller.addMotor(servo_config);
```

## ROS2ノードの使用

### 起動方法

```bash
# デフォルト設定で起動
ros2 run motor_control_app unified_motor_control_node

# カスタム設定で起動
ros2 run motor_control_app unified_motor_control_node \
  --ros-args \
  -p drive_port:="/dev/ttyACM1" \
  -p esc_pin:=18 \
  -p servo_port:="/dev/ttyUSB1"
```

### トピック

#### Subscribers

- `/cmd_vel` (geometry_msgs/Twist): 移動制御指令
- `/joy` (sensor_msgs/Joy): ジョイスティック入力
- `/shot_speed` (std_msgs/Float64): 発射速度設定
- `/shot_angle` (std_msgs/Float64): 発射角度設定
- `/fire_command` (std_msgs/Bool): 発射指令

#### Publishers

- `/system_health` (std_msgs/Bool): システム健康状態
- `/ready_to_fire` (std_msgs/Bool): 発射準備状態

### パラメータ

- `drive_port`: DDTモータのシリアルポート (default: "/dev/ttyACM0")
- `esc_pin`: ESCモータのPWMピン (default: 13)
- `servo_port`: サーボモータのシリアルポート (default: "/dev/ttyUSB0")
- `auto_setup`: 自動セットアップを使用するか (default: true)

## API リファレンス

### UnifiedMotorController

#### 主要メソッド

```cpp
// モータの追加・管理
bool addMotor(const MotorConfig& config);
bool initialize();
void shutdown();

// Drive制御
bool setVelocity(double linear_x, double angular_z, const std::string& motor_name = "");

// Shot制御
bool setShotParameters(double speed, double angle, const std::string& motor_name = "");
bool executeFire(const std::string& motor_name = "");

// 安全機能
void stopAll();
void emergencyStopAll();
bool isHealthy() const;

// 情報取得
std::vector<std::string> getMotorNames() const;
std::vector<std::string> getDriveMotorNames() const;
std::vector<std::string> getShotMotorNames() const;
```

### MotorFactory

#### 設定作成

```cpp
// サポートされているタイプ: "ddt", "esc", "servo"
// モード: "drive", "shot"
MotorConfig createConfig(const std::string& motor_type, 
                        const std::string& motor_name,
                        const std::string& mode);

// 動的生成
std::shared_ptr<BaseMotorController> createMotor(const MotorConfig& config);
```

## 設定例

### DDTモータ設定

```cpp
auto config = MotorFactory::createConfig("ddt", "main_drive", "drive");
config.string_params["serial_port"] = "/dev/ttyACM0";
config.int_params["baud_rate"] = 115200;
config.double_params["wheel_radius"] = 0.1;
config.double_params["wheel_separation"] = 0.5;
config.int_params["left_motor_id"] = 1;
config.int_params["right_motor_id"] = 2;
config.int_params["max_motor_rpm"] = 330;
```

### ESCモータ設定

```cpp
auto config = MotorFactory::createConfig("esc", "launcher", "shot");
config.int_params["pwm_pin"] = 13;
config.double_params["min_pulse_width"] = 1.0;  // ms
config.double_params["max_pulse_width"] = 2.0;   // ms
config.double_params["neutral_pulse_width"] = 1.5;  // ms
config.bool_params["test_mode"] = true;
```

### サーボモータ設定

```cpp
auto config = MotorFactory::createConfig("servo", "turret", "shot");
config.string_params["port"] = "/dev/ttyUSB0";
config.int_params["baudrate"] = 115200;
config.int_params["servo_id"] = 1;
```

## ビルド方法

```bash
cd /path/to/your/workspace
colcon build --packages-select motor_control_lib motor_control_app
source install/setup.bash
```

## テスト

```bash
# 基本機能テスト
ros2 run motor_control_app unified_motor_control_node

# Drive制御テスト
ros2 topic pub /cmd_vel geometry_msgs/Twist "linear: {x: 0.5}" --once

# Shot制御テスト
ros2 topic pub /shot_speed std_msgs/Float64 "data: 0.8" --once
ros2 topic pub /shot_angle std_msgs/Float64 "data: 45.0" --once
ros2 topic pub /fire_command std_msgs/Bool "data: true" --once

# システム状態確認
ros2 topic echo /system_health
```

## 移行ガイド

### 旧バージョンからの移行

#### 従来のコード

```cpp
// 旧バージョン
ddt_motor_control_cpp::DdtMotorControllerComponent ddt_motor;
esc_motor_control_python::ESCMotorControlNode esc_motor;
servo_control_ros2::ServoNode servo_motor;
```

#### 新バージョン

```cpp
// 新バージョン
motor_control_lib::UnifiedMotorController controller;
motor_control_lib::QuickSetup::setupStandardRobot(controller);
controller.initialize();
```

## トラブルシューティング

### よくある問題

1. **シリアルポートアクセス権限エラー**

   ```bash
   sudo usermod -a -G dialout $USER
   # ログアウト・ログインが必要
   ```

2. **GPIO権限エラー**

   ```bash
   sudo usermod -a -G gpio $USER
   ```

3. **モータが応答しない**
   - 配線とポート設定を確認
   - ボーレート設定を確認
   - `isHealthy()`でステータス確認

## ライセンス

MIT License

## 作者

- リファクタリング: GitHub Copilot
- 元コード: questix_core プロジェクト
