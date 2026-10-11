// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef COMMAND_ARBITER__DRIVE_ARBITER_COMPONENT_HPP_
#define COMMAND_ARBITER__DRIVE_ARBITER_COMPONENT_HPP_

#include <geometry_msgs/msg/twist.hpp>
#include <memory>
#include <optional>
#include <questix_msgs/msg/arbiter_status.hpp>
#include <rclcpp/rclcpp.hpp>

#include "command_arbiter/lab_permission.hpp"
#include "command_arbiter/source_selector.hpp"

namespace command_arbiter {

// The drive's input selection in a lesson: the controller (/target_twist/joy) or a QUESTiX LAB run
// (/target_twist/lab) -> /target_twist (drive_component). The rule is source_selector.hpp; on top
// of it only QUESTiX LAB's speed caps (lab_max_linear / lab_max_angular: faster lab commands are
// clamped) and the teacher's lesson permission (/lab_permission drive_allowed). A stick command
// below neutral_linear / neutral_angular is neutral; a lab command is neutral only when exactly
// zero (the lab bridge's stop). Status: /command_arbiter/status (mechanism "drive").
// Started by lesson launches only (questix_core robot_mode:=lesson).
class DriveArbiterComponent : public rclcpp::Node {
public:
  explicit DriveArbiterComponent(const rclcpp::NodeOptions& options);

private:
  void joyCallback(const geometry_msgs::msg::Twist& msg);
  void labCallback(const geometry_msgs::msg::Twist& msg);
  void tickCallback();
  void publishTwist(double linear, double angular);
  void publishStatus(bool force);
  double nowSec() const;

  SourceSelector selector_;
  double neutral_linear_{0.01};
  double neutral_angular_{0.025};
  double lab_max_linear_{0.15};
  double lab_max_angular_{0.5};
  std::unique_ptr<LabPermission> permission_;
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr joy_sub_;
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr lab_sub_;
  rclcpp::Publisher<geometry_msgs::msg::Twist>::SharedPtr output_pub_;
  rclcpp::Publisher<questix_msgs::msg::ArbiterStatus>::SharedPtr status_pub_;
  rclcpp::TimerBase::SharedPtr tick_timer_;
  rclcpp::TimerBase::SharedPtr status_timer_;
  rclcpp::Clock steady_clock_{RCL_STEADY_TIME};
  // Version of the status last published; the first publish always happens.
  std::optional<unsigned> sent_version_;
  bool last_permitted_{false};
};

}  // namespace command_arbiter

#endif  // COMMAND_ARBITER__DRIVE_ARBITER_COMPONENT_HPP_
