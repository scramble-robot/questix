// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__DRIVE_WATCHDOG_HPP_
#define MOTOR_CONTROL_APP__DRIVE_WATCHDOG_HPP_

namespace motor_control_app::drive_watchdog {

// コマンド受信ウォッチドッグが有効かどうか（timeout_sec <= 0 で無効）
inline bool isEnabled(double timeout_sec) { return timeout_sec > 0.0; }

// タイムアウト停止すべきかどうかを判定する。
// 有効かつ既に指令を受信済み(has_cmd)で、経過時間が制限を厳密に超過した場合のみ true。
// elapsed_sec == timeout_sec は発火しない（ESC 側 safety_check の挙動に合わせる）。
inline bool shouldTimeoutStop(double elapsed_sec, double timeout_sec, bool has_cmd) {
  return isEnabled(timeout_sec) && has_cmd && elapsed_sec > timeout_sec;
}

// twistCallback が取るべきアクション
enum class TwistAction { kIgnore, kFaultStop, kDrive };

// Twist 受信時のアクションを決定する。
// 未初期化 or 非常停止中 -> kIgnore（無視）
// モータ準備完了だが異常 -> kFaultStop（停止指令）
// それ以外（準備完了かつ正常）-> kDrive（駆動）
inline TwistAction decideTwistAction(bool motor_ready, bool emergency_stop, bool healthy) {
  if (!motor_ready || emergency_stop) {
    return TwistAction::kIgnore;
  }
  if (!healthy) {
    return TwistAction::kFaultStop;
  }
  return TwistAction::kDrive;
}

}  // namespace motor_control_app::drive_watchdog

#endif  // MOTOR_CONTROL_APP__DRIVE_WATCHDOG_HPP_
