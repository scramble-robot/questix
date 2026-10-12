// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef COMMAND_ARBITER__LAUNCHER_ARBITER_COMPONENT_HPP_
#define COMMAND_ARBITER__LAUNCHER_ARBITER_COMPONENT_HPP_

#include <memory>
#include <optional>
#include <questix_msgs/msg/arbiter_status.hpp>
#include <questix_msgs/msg/launcher_command.hpp>
#include <rclcpp/rclcpp.hpp>

#include "command_arbiter/lab_permission.hpp"
#include "command_arbiter/launcher_flow.hpp"

namespace command_arbiter {

// The launcher's input selection in a lesson: the controller (/launcher_command/joy, joy_launcher)
// or a QUESTiX LAB run (/launcher_command/lab, the lab bridge) -> /launcher_command
// (esc_motor_control, shot_component). The rule and QUESTiX LAB's caps and shot preconditions are
// launcher_flow.hpp; the teacher's lesson permission is /lab_permission launcher_allowed. Status:
// /command_arbiter/status (mechanism "launcher"). Started by lesson launches only.
class LauncherArbiterComponent : public rclcpp::Node {
public:
  explicit LauncherArbiterComponent(const rclcpp::NodeOptions& options);

private:
  void joyCallback(const questix_msgs::msg::LauncherCommand& msg);
  void labCallback(const questix_msgs::msg::LauncherCommand& msg);
  void tickCallback();
  void publish(const LauncherFlow::Output& output);
  void publishStatus(bool force);
  double nowSec() const;

  LauncherFlow flow_;
  std::unique_ptr<LabPermission> permission_;
  rclcpp::Subscription<questix_msgs::msg::LauncherCommand>::SharedPtr joy_sub_;
  rclcpp::Subscription<questix_msgs::msg::LauncherCommand>::SharedPtr lab_sub_;
  rclcpp::Publisher<questix_msgs::msg::LauncherCommand>::SharedPtr output_pub_;
  rclcpp::Publisher<questix_msgs::msg::ArbiterStatus>::SharedPtr status_pub_;
  rclcpp::TimerBase::SharedPtr tick_timer_;
  rclcpp::TimerBase::SharedPtr status_timer_;
  rclcpp::Clock steady_clock_{RCL_STEADY_TIME};
  // Version of the status last published; the first publish always happens.
  std::optional<unsigned> sent_version_;
  bool last_permitted_{false};
};

}  // namespace command_arbiter

#endif  // COMMAND_ARBITER__LAUNCHER_ARBITER_COMPONENT_HPP_
