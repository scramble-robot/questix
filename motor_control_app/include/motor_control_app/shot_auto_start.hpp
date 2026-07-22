// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__SHOT_AUTO_START_HPP_
#define MOTOR_CONTROL_APP__SHOT_AUTO_START_HPP_

#include <cmath>
#include <cstdint>
#include <lifecycle_msgs/msg/state.hpp>

namespace motor_control_app::shot_auto_start {

// auto_start タイマー / 非常停止解除エッジが取るべきアクション
enum class AutoStartAction { kConfigure, kActivate, kWaitEstopRelease, kStopTimer, kNone };

enum class SafetyTeardownAction {
  kResetRetry,
  kRetryDeactivate,
  kRetryCleanup,
  kStopTimers,
  kNone
};

// 現在の lifecycle 状態と /emergency_stop の受信状況から自動起動アクションを決定する。
// have_controllable: /emergency_stop を1回でも受信したか。未受信の環境
//                    （enable_gpio_ref=false 等で publisher が居ない）では
//                    非常停止状態が分からないため、従来どおり周期リトライで接続を試す。
// controllable:      「操作可」状態。true = 非常停止解除（通電・操作可）。
//                    呼び出し側は EmergencyStop.active の否定を渡す。
// unconfigured -> kConfigure（接続を試行。非常停止中は kWaitEstopRelease で保留）
// inactive     -> kActivate（運用状態へ遷移。非常停止中は kWaitEstopRelease で保留）
// active       -> kStopTimer（正常稼働中。手動 deactivate/cleanup を尊重して停止）
// finalized    -> kStopTimer（以後の自動遷移を停止）
// 遷移中・unknown -> kNone（何もしない）
inline AutoStartAction decideAutoStartAction(uint8_t state_id, bool have_controllable,
                                             bool controllable) {
  const bool estop_active = have_controllable && !controllable;
  switch (state_id) {
    case lifecycle_msgs::msg::State::PRIMARY_STATE_UNCONFIGURED:
      return estop_active ? AutoStartAction::kWaitEstopRelease : AutoStartAction::kConfigure;
    case lifecycle_msgs::msg::State::PRIMARY_STATE_INACTIVE:
      return estop_active ? AutoStartAction::kWaitEstopRelease : AutoStartAction::kActivate;
    case lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE:
    case lifecycle_msgs::msg::State::PRIMARY_STATE_FINALIZED:
      return AutoStartAction::kStopTimer;
    default:
      return AutoStartAction::kNone;
  }
}

inline bool isTransitionState(uint8_t state_id) {
  switch (state_id) {
    case lifecycle_msgs::msg::State::TRANSITION_STATE_CONFIGURING:
    case lifecycle_msgs::msg::State::TRANSITION_STATE_CLEANINGUP:
    case lifecycle_msgs::msg::State::TRANSITION_STATE_SHUTTINGDOWN:
    case lifecycle_msgs::msg::State::TRANSITION_STATE_ACTIVATING:
    case lifecycle_msgs::msg::State::TRANSITION_STATE_DEACTIVATING:
    case lifecycle_msgs::msg::State::TRANSITION_STATE_ERRORPROCESSING:
      return true;
    default:
      return false;
  }
}

inline SafetyTeardownAction decideSafetyTeardownAction(uint8_t state_id) {
  switch (state_id) {
    case lifecycle_msgs::msg::State::PRIMARY_STATE_UNCONFIGURED:
      return SafetyTeardownAction::kResetRetry;
    case lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE:
      return SafetyTeardownAction::kRetryDeactivate;
    case lifecycle_msgs::msg::State::PRIMARY_STATE_INACTIVE:
      return SafetyTeardownAction::kRetryCleanup;
    case lifecycle_msgs::msg::State::PRIMARY_STATE_FINALIZED:
      return SafetyTeardownAction::kStopTimers;
    default:
      return SafetyTeardownAction::kNone;
  }
}

// A canceled auto-start timer in a manually reached stable pre-active state is an operator hold.
// Safety teardown still takes precedence while ACTIVE, even though normal activation cancels the
// timer.
inline bool shouldHoldManualLifecycle(uint8_t state_id, bool auto_start_timer_canceled) {
  if (!auto_start_timer_canceled) {
    return false;
  }
  return state_id == lifecycle_msgs::msg::State::PRIMARY_STATE_INACTIVE ||
         state_id == lifecycle_msgs::msg::State::PRIMARY_STATE_UNCONFIGURED;
}

// /emergency_stop の受信途絶判定。最後に「操作可」（active=false）だった信号だけを
// fail-safe teardown の対象にする（非常停止押下は teardown 済みのため latch 不要）。
// 呼び出し側は controllable に EmergencyStop.active の否定を渡す。未受信環境
// （publisher なし）を timeout にしない互換動作は呼び出し側の have_estop_msg_ ガードが担う。
inline bool isControllableSignalStale(double timeout_sec, bool controllable, double elapsed_sec) {
  return std::isfinite(timeout_sec) && timeout_sec > 0.0 && controllable &&
         elapsed_sec > timeout_sec;
}

inline bool isValidPositivePeriod(double value) { return std::isfinite(value) && value > 0.0; }

inline double normalizePositivePeriod(double value, double fallback) {
  return isValidPositivePeriod(value) ? value : fallback;
}

inline double normalizeControllableTimeout(double value, double fallback) {
  return std::isfinite(value) ? value : fallback;
}

}  // namespace motor_control_app::shot_auto_start

#endif  // MOTOR_CONTROL_APP__SHOT_AUTO_START_HPP_
