# Motor Control Library

QUESTiX のモータ制御用共有ライブラリです。ROS ノードは含みません
（ノードは `motor_control_app` にあり、本ライブラリへ委譲します）。
ROS パラメータの宣言も行いません — 設定はすべて setter 経由で、
実効値の単一ソースは `launcher/config/drive_component.yaml` です。

## 構成

```
motor_control_lib/
├── include/motor_control_lib/
│   ├── ddt_motor_lib.hpp            # DDT M0602C モータ (UART, Protocol1/3)
│   ├── ddt_protocol.hpp             # フレームの pack/unpack 純関数 (CRC8/MAXIM)
│   ├── ddt_current_pi.hpp           # 電流モード用ソフトウェア PI (純関数)
│   ├── differential_drive.hpp       # 差動駆動 (2輪の DdtMotorLib を束ねる)
│   ├── differential_kinematics.hpp  # twist <-> 車輪RPM 変換 (純関数・単一ソース)
│   ├── drive_stop_gate.hpp          # 停止/走行ヒステリシス (純関数)
│   ├── servo_control.hpp            # FEETECH サーボ (Modbus)
│   ├── feetech_protocol.hpp
│   ├── shot_controller.hpp          # ショット系コントローラ
│   └── motor_manager.hpp
└── src/ (対応する .cpp)
```

## 走行系の主要クラス

### DdtMotorLib

DDT M0602C 1 台との UART 通信を担当します。

- **velocity モード（既定）**: 目標 RPM を Protocol 1 (0x64) で送信。
  速度閉ループは**モータファームウェア内**にあり、ホストは開ループ。
- **current モード（実験的）**: ホスト側で `ddt_current_pi` の RPM→電流 PI を回す。
- フィードバック（実測RPM・電流・fault code）は指令フレームへの応答としてのみ届く
  ため、観測レートは指令レートに拘束される。
- 実測 RPM の一次 LPF (`measured_lpf_tau_sec`) は**レポート/オドメトリ経路専用**。
  制御（電流PI）は生値を読む。
- 上限は M0602C 仕様の ±475 RPM にクランプ（`kSpecVelocityMaxRpm`）。

バイトオーダー等のプロトコル詳細は `ddt_protocol.hpp` と
`M0602C_234_仕様書_日本語訳.md` を参照。

### DifferentialDrive

左右 2 台の `DdtMotorLib` を束ね、`setWheelRpm()` / `commandStop()` /
`setVelocity()` を提供します。twist→RPM 変換は `differential_kinematics`
の純関数に委譲しており、変換式はそこが単一ソースです。

### 純関数ヘッダ（テスト容易性のため分離）

| ヘッダ | 責務 |
|---|---|
| `differential_kinematics.hpp` | twist <-> 車輪RPM（右輪の符号反転を含む） |
| `drive_stop_gate.hpp` | 低速不感帯 + 停止/走行ヒステリシス |
| `ddt_current_pi.hpp` | 電流モードの PI（アンチワインドアップ付き） |
| `ddt_protocol.hpp` | フレーム pack/unpack、CRC |

## 使用例（motor_control_app の drive_component が実際の利用者）

```cpp
#include "motor_control_lib/differential_drive.hpp"

motor_control_lib::DifferentialDrive drive("/dev/ttyACM0", 57600);
drive.setWheelParams(0.1 /* wheel_radius [m] */, 0.5 /* separation [m] */);
drive.setMotorIds(4 /* left */, 5 /* right */);
drive.initialize();

drive.setWheelRpm(100, -100);  // 左右車輪 RPM を直接指令
drive.commandStop();           // 停止
```

## テスト

```bash
colcon test --packages-select motor_control_lib
```

閉ループ挙動の回帰テスト（ファーム速度ループのプラントモデル込み）は
`motor_control_app/test/test_control_core.cpp` にあります。

## トラブルシューティング

1. **シリアルポートアクセス権限エラー**

   ```bash
   sudo usermod -a -G dialout $USER
   # ログアウト・ログインが必要
   ```

2. **モータが応答しない**
   - 配線とポート設定（`/dev/ttyACM0`, 57600 baud）を確認
   - `/drive_status` の fault code を確認（`questix_msgs/README.md` 参照）

## ライセンス

MIT License
