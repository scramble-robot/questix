# questix_msgs

QUESTiX 共通メッセージ定義パッケージ。統一緊急停止インターフェイス
`/emergency_stop` の一次文書はこの README です。

## メッセージ

### `EmergencyStop.msg`

| フィールド | 型 | 意味 |
|---|---|---|
| `header` | `std_msgs/Header` | `stamp` = 判定時刻。`frame_id` は未使用(`""`) |
| `active` | `bool` | `true` = 緊急停止発動 |
| `source` | `string` | 発行元識別子(例: `"operation_manager"`) |
| `reason` | `string` | 原因(例: `"pin 27 is false; "`、`"pin 27 timeout; "`)。解除時は `"released"` |

## `/emergency_stop` トピック契約

- **型**: `questix_msgs/msg/EmergencyStop`
- **QoS**: reliable + transient_local + keep-last(1)
  (`rclcpp::QoS(1).reliable().transient_local()`)。
  購読側も同一 QoS を使うこと。late-join した購読者は最新のラッチ状態を即時受信する。
- **発行元**: `operation_manager`。GPIO controllability 判定
  (`evaluate_controllability()`)の毎回実行時に発行する。
  すなわち GPIO 更新毎(公称 ~20 Hz)+ 1 秒周期タイマーがハートビート下限。
  `active = !controllable`。
- **発行者不在環境**: operation_manager は `enable_gpio_ref=true` の構成
  (`joy_controller_referee.launch.xml`)でのみ起動する。購読側は
  メッセージを一度も受信していない間は通常動作を継続しなければならない
  (発行者不在で停止してはならない)。
- **staleness 検出**: 購読側は「一度以上受信した後に」タイムアウト
  (推奨 1.0 s)を超えて受信が途絶えた場合をフェイルセーフ条件として
  扱ってよい(shot_component が実装)。

## 復帰挙動(active=false 受信時)

全購読者とも**自動復帰**。ただしモータが勝手に動き出すことはない。

| 購読者 | 停止時(active=true) | 解除時(active=false) |
|---|---|---|
| `drive_component` | フラグ設定 + `diff_drive_->stop()` を即時実行(best-effort)。以後の `/target_twist` は無視 | フラグ解除。`/target_twist` 受付再開。モータは次の twist コマンドまで停止のまま |
| `shot_component` | deactivate→cleanup でサーボバス解放(unconfigured へ) | auto-start 再アーム。configure→activate を自動リトライ |
| `esc_motor_control` | フラグ設定 + `set_motor_speed(0.0)` 即時実行。停止中はボタン入力を無視 | フラグ解除。フルスピードボタンの**新たな押下エッジ**まで 0 のまま(押しっぱなしでは再始動しない) |

## 移行メモ

- ESC の `/roller_emergency_status`(`std_msgs/Bool`, transient_local)は
  `/emergency_stop` の `active` のミラーとして 1 リリース並行 publish され、
  次リリースで削除予定(deprecated)。新規購読は `/emergency_stop` を使うこと。
- `joy_gate` は従来どおり `/gpio/controllable` を購読する(スコープ外)。
- drive_component の受信 staleness タイムアウトは未実装
  (既存のコマンド watchdog と物理電源断がフェイルセーフを担う)。
  ハートビートを利用したタイムアウト追加はフォローアップ候補。
