// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__LIFECYCLE_AUTO_START_HPP_
#define MOTOR_CONTROL_APP__LIFECYCLE_AUTO_START_HPP_

#include <cmath>
#include <cstdint>
#include <lifecycle_msgs/msg/state.hpp>
#include <limits>

namespace motor_control_app::lifecycle_auto_start {

// auto_start タイマーが取るべきアクション
enum class AutoStartAction { kConfigure, kActivate, kStopTimer, kNone };

// 現在の lifecycle 状態 id から自動起動タイマーのアクションを決定する。
// unconfigured -> kConfigure（接続を試行）
// inactive     -> kActivate（運用状態へ遷移）
// active       -> kStopTimer（正常稼働中。手動 deactivate/cleanup を尊重して停止）
// finalized    -> kStopTimer（終了後にタイマーを残さない）
// transition/unknown -> kNone（何もしない）
inline AutoStartAction decideAutoStartAction(uint8_t state_id) {
  switch (state_id) {
    case lifecycle_msgs::msg::State::PRIMARY_STATE_UNCONFIGURED:
      return AutoStartAction::kConfigure;
    case lifecycle_msgs::msg::State::PRIMARY_STATE_INACTIVE:
      return AutoStartAction::kActivate;
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

inline bool isValidPositiveValue(double value) { return std::isfinite(value) && value > 0.0; }

inline double normalizeRetryPeriod(double value, double fallback) {
  return isValidPositiveValue(value) ? value : fallback;
}

inline int64_t statusTimerPeriodNanoseconds(double rate_hz) {
  if (!isValidPositiveValue(rate_hz)) {
    return 0;
  }
  constexpr long double kNanosecondsPerSecond = 1000000000.0L;
  const long double period_ns = kNanosecondsPerSecond / static_cast<long double>(rate_hz);
  if (!std::isfinite(period_ns) || period_ns < 1.0L ||
      period_ns > static_cast<long double>(std::numeric_limits<int64_t>::max())) {
    return 0;
  }
  return static_cast<int64_t>(period_ns);
}

inline bool isValidStatusPublishRate(double value) {
  return statusTimerPeriodNanoseconds(value) > 0;
}

}  // namespace motor_control_app::lifecycle_auto_start

#endif  // MOTOR_CONTROL_APP__LIFECYCLE_AUTO_START_HPP_
