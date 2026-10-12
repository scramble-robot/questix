// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#ifndef OPERATION_MANAGER__REFEREE_MONITOR_COMPONENT_HPP_
#define OPERATION_MANAGER__REFEREE_MONITOR_COMPONENT_HPP_

#include <diagnostic_msgs/msg/diagnostic_array.hpp>
#include <map>     // NOLINT(build/include_order)
#include <memory>  // NOLINT(build/include_order)
#include <questix_msgs/msg/actuation_authority.hpp>
#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/bool.hpp>
#include <string>  // NOLINT(build/include_order)

#include "operation_manager/gpio_safety_evaluator.hpp"

namespace operation_manager {

// The AutoReferee's GPIO27 as the referee's vote for the motion permission (L2). Nothing else:
// a defeat is a state of the game, not a safety function, so it never reaches /emergency_stop
// here. GPIO27 true (safe-high) = the robot may move; false, not received or silent for
// timeout_seconds = it may not. The vote is a questix_msgs/ActuationAuthority (both flags equal)
// on vote_topic (/motion_vote/referee), reliable + volatile + keep-last(1), on every GPIO update
// and every 100 ms; MotionPermissionManager needs it in competition mode. The pin diagnostics
// (including pin_27_signal_limit) go to /diagnostics.
//
// Started by competition launches only (questix_core robot_mode competition).
class RefereeMonitorComponent : public rclcpp::Node {
public:
  explicit RefereeMonitorComponent(const rclcpp::NodeOptions& options);

  static constexpr const char* kSource = "referee";

private:
  void gpioCallback(const std_msgs::msg::Bool::SharedPtr msg, unsigned int pin);
  void evaluate();

  std::unique_ptr<GpioSafetyEvaluator> evaluator_;
  std::map<unsigned int, rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr> gpio_subs_;
  rclcpp::Publisher<questix_msgs::msg::ActuationAuthority>::SharedPtr vote_pub_;
  rclcpp::Publisher<diagnostic_msgs::msg::DiagnosticArray>::SharedPtr diagnostics_pub_;
  rclcpp::TimerBase::SharedPtr timer_;
  double timeout_seconds_{1.0};
  bool last_allowed_{false};
  bool reported_{false};
};

}  // namespace operation_manager

#endif  // OPERATION_MANAGER__REFEREE_MONITOR_COMPONENT_HPP_
