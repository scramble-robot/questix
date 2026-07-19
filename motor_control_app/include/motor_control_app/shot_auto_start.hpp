// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__SHOT_AUTO_START_HPP_
#define MOTOR_CONTROL_APP__SHOT_AUTO_START_HPP_

#include <cstdint>
#include <lifecycle_msgs/msg/state.hpp>

namespace motor_control_app::shot_auto_start {

// auto_start タイマー / 非常停止解除エッジが取るべきアクション
enum class AutoStartAction { kConfigure, kActivate, kWaitEstopRelease, kStopTimer, kNone };

// 現在の lifecycle 状態と /gpio/controllable の受信状況から自動起動アクションを決定する。
// have_controllable: /gpio/controllable を1回でも受信したか。未受信の環境
//                    （enable_gpio_ref=false 等で publisher が居ない）では
//                    非常停止状態が分からないため、従来どおり周期リトライで接続を試す。
// controllable:      最終受信値。true = 非常停止解除（通電・操作可）。
// unconfigured -> kConfigure（接続を試行。非常停止中は kWaitEstopRelease で保留）
// inactive     -> kActivate（運用状態へ遷移。非常停止中は kWaitEstopRelease で保留）
// active       -> kStopTimer（正常稼働中。手動 deactivate/cleanup を尊重して停止）
// それ以外（finalized・遷移中など）-> kNone（何もしない）
inline AutoStartAction decideAutoStartAction(uint8_t state_id, bool have_controllable,
                                             bool controllable) {
  const bool estop_active = have_controllable && !controllable;
  switch (state_id) {
    case lifecycle_msgs::msg::State::PRIMARY_STATE_UNCONFIGURED:
      return estop_active ? AutoStartAction::kWaitEstopRelease : AutoStartAction::kConfigure;
    case lifecycle_msgs::msg::State::PRIMARY_STATE_INACTIVE:
      return estop_active ? AutoStartAction::kWaitEstopRelease : AutoStartAction::kActivate;
    case lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE:
      return AutoStartAction::kStopTimer;
    default:
      return AutoStartAction::kNone;
  }
}

}  // namespace motor_control_app::shot_auto_start

#endif  // MOTOR_CONTROL_APP__SHOT_AUTO_START_HPP_
