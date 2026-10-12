// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "joy_controller/joy_launcher_component.hpp"

#include <limits>
#include <rclcpp_components/register_node_macro.hpp>
#include <string>

namespace joy_controller {

rclcpp::QoS JoyLauncherComponent::qos() { return rclcpp::QoS(1).reliable().durability_volatile(); }

JoyLauncherComponent::JoyLauncherComponent(const rclcpp::NodeOptions& options)
    : Node("joy_launcher", options) {
  // Defaults match the old shot_component / esc_motor_control ones; the robot's values come from
  // the joy_launcher section of the controls profile (questix_control_config).
  const LauncherMappingConfig defaults;
  LauncherMappingConfig config;
  config.fire_button = static_cast<int>(declare_parameter("fire_button", defaults.fire_button));
  // Legacy profiles still work: tilt_axis is used by a direction whose own axis is -2 (unset).
  const int legacy_tilt_axis = static_cast<int>(declare_parameter("tilt_axis", -1));
  config.tilt_up_axis = static_cast<int>(declare_parameter("tilt_up_axis", -2));
  config.tilt_down_axis = static_cast<int>(declare_parameter("tilt_down_axis", -2));
  if (config.tilt_up_axis == -2) {
    config.tilt_up_axis = legacy_tilt_axis;
  }
  if (config.tilt_down_axis == -2) {
    config.tilt_down_axis = legacy_tilt_axis;
  }
  config.tilt_up_axis_sign =
      static_cast<int>(declare_parameter("tilt_up_axis_sign", defaults.tilt_up_axis_sign));
  config.tilt_down_axis_sign =
      static_cast<int>(declare_parameter("tilt_down_axis_sign", defaults.tilt_down_axis_sign));
  config.tilt_up_button_index =
      static_cast<int>(declare_parameter("tilt_up_button_index", defaults.tilt_up_button_index));
  config.tilt_down_button_index = static_cast<int>(
      declare_parameter("tilt_down_button_index", defaults.tilt_down_button_index));
  config.full_speed_button =
      static_cast<int>(declare_parameter("full_speed_button", defaults.full_speed_button));
  config.full_speed_value = declare_parameter("full_speed_value", defaults.full_speed_value);
  const std::string joy_topic = declare_parameter("joy_topic", std::string("/joy"));
  const std::string command_topic =
      declare_parameter("launcher_command_topic", std::string("/launcher_command"));

  if (!validTiltInputs(config)) {
    // Never guess another input: the tilt stays unused until the profile is fixed.
    RCLCPP_ERROR(get_logger(),
                 "Invalid or duplicate tilt inputs (up: axis %d sign %d button %d; down: axis %d "
                 "sign %d button %d): the controller's tilt is disabled",
                 config.tilt_up_axis, config.tilt_up_axis_sign, config.tilt_up_button_index,
                 config.tilt_down_axis, config.tilt_down_axis_sign, config.tilt_down_button_index);
    config.tilt_up_axis = config.tilt_down_axis = -2;  // never pressed (tilt_input.hpp)
  }
  mapping_.configure(config);
  if (mapping_.config().full_speed_value != config.full_speed_value) {
    RCLCPP_WARN(get_logger(), "full_speed_value=%g is outside [0, 1]; using %.2f",
                config.full_speed_value, mapping_.config().full_speed_value);
  }

  command_pub_ = create_publisher<questix_msgs::msg::LauncherCommand>(command_topic, qos());
  joy_sub_ = create_subscription<sensor_msgs::msg::Joy>(
      joy_topic, 10, [this](const sensor_msgs::msg::Joy::SharedPtr msg) { joyCallback(msg); });
  RCLCPP_INFO(get_logger(),
              "joy_launcher: %s -> %s (fire button %d, roller button %d at %.2f, tilt up axis %d "
              "sign %d button %d, down axis %d sign %d button %d)",
              joy_topic.c_str(), command_topic.c_str(), config.fire_button,
              config.full_speed_button, mapping_.config().full_speed_value,
              mapping_.config().tilt_up_axis, config.tilt_up_axis_sign, config.tilt_up_button_index,
              mapping_.config().tilt_down_axis, config.tilt_down_axis_sign,
              config.tilt_down_button_index);
}

void JoyLauncherComponent::joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg) {
  if (!msg) {
    return;
  }
  const auto output = mapping_.onJoy(msg->axes, msg->buttons);
  questix_msgs::msg::LauncherCommand command;
  command.header.stamp = now();
  command.roller_power = output.roller_power;
  command.tilt_deg = std::numeric_limits<float>::quiet_NaN();  // the controller steps the tilt
  command.tilt_steps = output.tilt_steps;
  command.fire_seq = output.fire_seq;
  command.source = "joy";
  command_pub_->publish(command);
}

}  // namespace joy_controller

RCLCPP_COMPONENTS_REGISTER_NODE(joy_controller::JoyLauncherComponent)
