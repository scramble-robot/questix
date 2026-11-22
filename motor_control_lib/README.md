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
- **current モード（実験的）**: ホスト側で `ddt_current_pi` の RPM→電流 PI を回す。帰還は
  既定で車輪の角度から求めた速さ（`wheel_speed_estimator.hpp`。直前 2 区間、遅れ 約 20 ms、
  無効なら電流を出さない）。報告回転数（遅れ 100〜120 ms）は `CurrentMeasuredSource::Reported`
  で比較用に選べる。
- **応答欠落のラッチ**: current モードの `currentLinkLatched()` は、3 回連続の無効応答、
  非ゼロ目標に対する初回応答なし、通電中の古い応答、モード不一致などで作動し、全 current
  モータへ 0 A を送る。既存の鮮度の門・暴走ガードと解除条件は維持する。
  解除には停止指令だけの間に、全 current モータで mode 1・fault 0 の新しい応答が3回連続で必要。
- **velocity モードの門と走行中のラッチ**: 非ゼロ目標を送る前に、登録された全速度モータで
  mode 2・fault 0 の最新応答が **1.0 s 以下**かを確認する。停止中の約 0.32 s ごとの再送応答が
  1回欠けると約 0.64 s、2回欠けると約 0.96 s 前の応答になるため、この直後の再発進も通す値とした。
  初回応答なし・古い応答・不適切な mode/fault は、ラッチと別の「モーターの応答待ち」になる。
  他方の輪がゼロ目標でも待機が同じtick内で消えないよう、非ゼロを遮断した輪自身にも待機を残す。
  この間はゼロだけを送り、`velocityFeedbackWaiting()` と両方の `isHealthy()` で待機状態を反映する。
  その非ゼロ要求への即時ゼロ応答だけでは門を開けず、次の停止・IDLE の有効応答で開ける。
  drive_component が既存の停止経路で武装解除する前に保持入力で動き出すことを防ぐためである。
  activate 時も速度用の応答根拠を消し、新しい応答を取り直す（current の状態は変更しない）。
  停止・IDLE の欠落だけでは門を閉じず、健全性を偽にせず、ラッチの数にも入れない。
  **実際に非ゼロ目標を送った送受信で3回連続の無効応答**（CRC不一致・別IDも含む）があれば、
  `velocityLinkLatched()` が立ち、全速度モータへ停止を送り、既存のフォールト停止を使う。
  停止・IDLEの欠落は履歴を増減させず、有効な応答で連続欠落を0に戻す。50 Hzで約60 msが目安で、
  実時間の上限保証ではない。
  解除には停止指令だけの間に全速度モータそれぞれで mode 2・fault 0 の新しい有効応答が3回連続で必要。
  非ゼロ要求は回復カウントを消す。門の復帰・ラッチ解除後も、許可・非常停止解除・健全性を満たす
  新しい中立入力がなければ再始動しない。門とラッチはそれぞれ状態変化だけを別の文でログに出す。
  既存の `/drive_status` の項目だけでは門とラッチを区別できないため、fault_codeを偽装せずログで区別する。
  IDLE は許可OFF中も既存ゼロを再送する。非常停止がactiveの間は既存設計どおりIDLE取得を止め、
  解除後に再開する。E-stop不明／staleの間も取得可能（送信失敗のstop fault中はゼロの再送成功が先）。
  **通信断のモータにはホストの停止指令が届かない**。ファーム側で止まるかは未確認で、最後の頼りは非常停止と電源。
- フィードバック（実測RPM・電流・fault code）は指令フレームへの応答としてのみ届く
  ため、観測レートは指令レートに拘束される。
- 実測 RPM の一次 LPF (`measured_lpf_tau_sec`) は**レポート/オドメトリ経路専用**。
  制御（電流PI）はこのフィルタを通らない（角度から求めた速さか、報告回転数の生値を読む）。
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
