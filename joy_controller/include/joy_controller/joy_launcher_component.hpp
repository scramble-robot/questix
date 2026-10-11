// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef JOY_CONTROLLER__JOY_LAUNCHER_COMPONENT_HPP_
#define JOY_CONTROLLER__JOY_LAUNCHER_COMPONENT_HPP_

#include <questix_msgs/msg/launcher_command.hpp>
#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/joy.hpp>

#include "joy_controller/launcher_mapping.hpp"

namespace joy_controller {

// joy_launcher: the controller's launcher buttons (fire, tilt up/down, roller) as a
// questix_msgs/LauncherCommand on launcher_command_topic, one per /joy message
// (launcher_mapping.hpp). esc_motor_control and shot_component obey /launcher_command only; a
// lesson launch remaps this node's output to /launcher_command/joy, command_arbiter's input.
// The mapping is operator tuning: the joy_launcher section of questix_control_config's profile.
class JoyLauncherComponent : public rclcpp::Node {
public:
  explicit JoyLauncherComponent(const rclcpp::NodeOptions& options);

  // QoS of /launcher_command and its inputs (questix_msgs/msg/LauncherCommand.msg).
  static rclcpp::QoS qos();

private:
  void joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg);

  LauncherMapping mapping_;
  rclcpp::Subscription<sensor_msgs::msg::Joy>::SharedPtr joy_sub_;
  rclcpp::Publisher<questix_msgs::msg::LauncherCommand>::SharedPtr command_pub_;
};

}  // namespace joy_controller

#endif  // JOY_CONTROLLER__JOY_LAUNCHER_COMPONENT_HPP_
