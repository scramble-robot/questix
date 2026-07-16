// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#pragma once

#include <memory>
#include <string>

#include "joy_gate/gate_logic.hpp"
#include "rclcpp/rclcpp.hpp"
#include "sensor_msgs/msg/joy.hpp"
#include "std_msgs/msg/bool.hpp"

namespace joy_gate {

class JoyGateComponent : public rclcpp::Node {
public:
  explicit JoyGateComponent(const rclcpp::NodeOptions& options);

private:
  void gpio_controllable_callback(const std_msgs::msg::Bool::SharedPtr msg);
  void joy_input_callback(const sensor_msgs::msg::Joy::SharedPtr msg);
  void timeout_check_callback();
  void publish_zero_joy();

  // Publishers and subscribers
  rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr gpio_controllable_sub_;
  rclcpp::Subscription<sensor_msgs::msg::Joy>::SharedPtr joy_input_sub_;
  rclcpp::Publisher<sensor_msgs::msg::Joy>::SharedPtr joy_output_pub_;
  rclcpp::TimerBase::SharedPtr timeout_timer_;

  // Topic names (loaded from YAML)
  std::string gpio_controllable_topic_;
  std::string joy_input_topic_;
  std::string joy_output_topic_;

  // /gpio/controllable reception timeout [s]; <= 0 disables the feature.
  double controllable_timeout_sec_{1.0};

  // Internal state
  // NOTE: single-threaded executor is assumed; no mutex guards gate_/
  // last_joy_msg_/has_received_joy_ because all callbacks run on one thread.
  GateLogic gate_;
  sensor_msgs::msg::Joy last_joy_msg_;
  bool has_received_joy_{false};
};

}  // namespace joy_gate
