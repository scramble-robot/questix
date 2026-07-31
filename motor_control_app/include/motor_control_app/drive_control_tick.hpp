// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__DRIVE_CONTROL_TICK_HPP_
#define MOTOR_CONTROL_APP__DRIVE_CONTROL_TICK_HPP_

#include <cmath>

#include "motor_control_app/drive_watchdog.hpp"

namespace motor_control_app::drive_control_tick {

// 制御 tick（固定周期の制御ステップ）が取るべきアクション。
// kIdle        : 何も送らない（目標未受信 = 未武装、モータ未準備、非常停止中）
// kTimeoutStop : コマンドタイムアウト。停止指令を送り、武装解除する
// kFaultStop   : モータ異常。停止指令を送り、武装解除する
// kDrive       : スルーレート制限を適用して駆動指令を送る
enum class TickAction { kIdle, kTimeoutStop, kFaultStop, kDrive };

// 制御 tick のアクションを決定する。
// 従来 twistCallback + watchdogTimerCallback に分かれていた判定の統合版:
// - 目標未受信（起動直後・タイムアウト/非常停止/フォールト停止後の武装解除中）は kIdle。
//   次の /target_twist 受信で再武装される。
// - 非常停止中は twistCallback 側で目標を保存しないため通常ここには来ないが、
//   多重の防御として kIdle を返す。
// - タイムアウト判定は drive_watchdog::shouldTimeoutStop と同一
//   （elapsed == timeout は発火しない。timeout <= 0 で無効）。
inline TickAction decideTickAction(bool has_target, bool motor_ready, bool emergency_stop,
                                   bool healthy, double elapsed_since_target_sec,
                                   double cmd_timeout_sec) {
  if (!has_target || !motor_ready || emergency_stop) {
    return TickAction::kIdle;
  }
  if (drive_watchdog::shouldTimeoutStop(elapsed_since_target_sec, cmd_timeout_sec, has_target)) {
    return TickAction::kTimeoutStop;
  }
  if (!healthy) {
    return TickAction::kFaultStop;
  }
  return TickAction::kDrive;
}

// 不正な control_rate に対するフォールバック dt [s]（= 50 Hz）。
// 通常は on_configure のバリデーションで弾かれるため使われない。
inline constexpr double kFallbackDtSec = 0.02;

// 固定周期 tick のスルーレート制限に使う dt [s]。dt が定数になることで、
// 実効加速度プロファイルが上流の publish レート（DualShock 20 Hz / UART 50 Hz）や
// メッセージ取りこぼしに依存しなくなる（従来は /target_twist の到着間隔が dt だった）。
inline double tickDtSec(double control_rate_hz) {
  if (!std::isfinite(control_rate_hz) || control_rate_hz <= 0.0) {
    return kFallbackDtSec;
  }
  return 1.0 / control_rate_hz;
}

}  // namespace motor_control_app::drive_control_tick

#endif  // MOTOR_CONTROL_APP__DRIVE_CONTROL_TICK_HPP_
