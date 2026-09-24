// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#pragma once

#include <optional>
#include <string>

#include "geometry_msgs/msg/twist.hpp"
#include "rclcpp/rclcpp.hpp"
#include "std_msgs/msg/string.hpp"
#include "twist_arbiter/arbiter_logic.hpp"

namespace twist_arbiter {

// Two velocity inputs in (joy_controller, QUESTiX LAB bridge), one out (drive_component's
// /target_twist), plus a latched status for the lab bridge. See arbiter_logic.hpp for the rules.
// Only practice launches start it; competition launches keep joy_controller -> /target_twist.
class TwistArbiterComponent : public rclcpp::Node {
public:
  explicit TwistArbiterComponent(const rclcpp::NodeOptions& options);

private:
  void joyCallback(const geometry_msgs::msg::Twist::SharedPtr msg);
  void labCallback(const geometry_msgs::msg::Twist::SharedPtr msg);
  void tickCallback();
  void publishCommand(const std::optional<ArbiterLogic::Command>& command);
  void publishStatus();
  double nowSec() const;

  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr joy_sub_;
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr lab_sub_;
  rclcpp::Publisher<geometry_msgs::msg::Twist>::SharedPtr output_pub_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr status_pub_;
  rclcpp::TimerBase::SharedPtr tick_timer_;
  rclcpp::Clock steady_clock_{RCL_STEADY_TIME};

  // NOTE: single-threaded executor is assumed; no mutex guards logic_ because all callbacks run
  // on one thread (as in joy_gate).
  ArbiterLogic logic_;
  // Version of the status last published; the first publish always happens.
  std::optional<unsigned> sent_version_;
};

}  // namespace twist_arbiter
