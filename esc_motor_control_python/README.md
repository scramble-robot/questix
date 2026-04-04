# ESC Motor Control Python Package

Python版のROS2 ESCモーター制御パッケージです。`test_esc.py`をベースに作成されています。

## 特徴

- **安全性重視**: 初期化時の安全警告と緊急停止機能
- **柔軟な制御**: ジョイスティック、cmd_vel、直接速度指令に対応
- **テストモード**: GPIO無しでの動作確認が可能
- **高精度PWM**: pigpioライブラリによる高精度PWM制御（利用可能時）

## パッケージ構成

```
esc_motor_control_python/
├── package.xml
├── setup.py
├── setup.cfg
├── resource/
├── esc_motor_control_python/
│   ├── __init__.py
│   ├── esc_motor_control_node.py    # メインの制御ノード
│   └── esc_motor_test_node.py       # テスト・手動制御ノード
├── config/
│   └── esc_motor_control_python.yaml
└── launch/
    ├── esc_motor_control_python.launch.py
    └── esc_motor_test.launch.py
```

## インストール

1. 依存関係のインストール:

```bash
sudo apt-get install python3-pip
pip3 install gpiozero pigpio
```

2. パッケージのビルド:

```bash
cd /home/asahi/questix_core
colcon build --packages-select esc_motor_control_python
source install/setup.bash
```

## 使用方法

### 基本的な制御ノード起動

```bash
# 実際のESCを使用
ros2 launch esc_motor_control_python esc_motor_control_python.launch.py

# テストモード（GPIO無し）
ros2 launch esc_motor_control_python esc_motor_control_python.launch.py test_mode:=true
```

### テスト・手動制御ノード起動

```bash
ros2 launch esc_motor_control_python esc_motor_test.launch.py
```

テストノードでは以下のコマンドが使用できます：

- `max` または `m`: 最大回転
- `stop` または `s`: 停止
- `test` または `t`: テストパターン実行
- `emergency` または `e`: 緊急停止
- `reset` または `r`: 緊急停止解除
- `quit` または `q`: 終了
- 数値 (例: `0.5`): 指定速度設定

## トピック

### 購読トピック

- `/joy` (sensor_msgs/Joy): ジョイスティック入力
- `/cmd_vel` (geometry_msgs/Twist): 速度指令
- `/motor_speed` (std_msgs/Float32): 直接速度指令
- `/emergency_stop` (std_msgs/Bool): 緊急停止指令

### 配信トピック

- `/motor_status` (std_msgs/Float32): 現在のモーター速度
- `/emergency_status` (std_msgs/Bool): 緊急停止状態

## 設定パラメータ

### PWM設定

- `pwm_pin`: PWM出力GPIOピン番号 (デフォルト: 13)
- `min_pulse_width`: 最小パルス幅 [ms] (デフォルト: 1.0)
- `max_pulse_width`: 最大パルス幅 [ms] (デフォルト: 2.0)
- `neutral_pulse_width`: 中立位置パルス幅 [ms] (デフォルト: 1.5)

### 速度制限

- `max_speed`: 最大前進速度 (デフォルト: 1.0)
- `min_speed`: 最大後進速度 (デフォルト: -1.0)

### 安全設定

- `enable_safety_stop`: 安全停止機能有効 (デフォルト: true)
- `safety_timeout`: 安全停止タイムアウト [秒] (デフォルト: 1.0)

### その他

- `test_mode`: テストモード（GPIO無効） (デフォルト: false)
- `full_speed_button`: フルスピードボタン番号 (デフォルト: 1)

## 安全に関する注意事項

⚠️ **重要な安全注意事項**:

1. **プロペラの取り外し**: テスト時は必ずプロペラを取り外してください
2. **モーターの固定**: モーターを安全に固定してください
3. **電源管理**: バッテリーとESCの電源を適切に管理してください
4. **初期化中の注意**: ESC初期化中はモーターが回転する可能性があります
5. **緊急停止**: 異常時はすぐに緊急停止を実行してください

## トラブルシューティング

### GPIO関連エラー

- `gpiozero`ライブラリがインストールされているか確認
- `pigpio`デーモンが起動しているか確認: `sudo systemctl start pigpiod`
- 権限の問題: `sudo`で実行するか、GPIOアクセス権限を設定

### テストモード

GPIO環境が無い場合や開発時は `test_mode:=true` でテストモードを使用してください。

## 元コードとの対応

- `test_esc.py`の安全確認機能 → 初期化時の安全警告
- ESC初期化シーケンス → `initialize_esc()` メソッド
- 手動制御インターフェース → `esc_motor_test_node.py`
- GPIO制御 → gpiozeroライブラリによるServo制御
- 安全停止機能 → 緊急停止とタイムアウト機能
