// Copyright 2026 scramble-robot
//
#pragma once

#include <memory>
#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/joy.hpp>
#include <std_msgs/msg/bool.hpp>
#include <string>

namespace joy_gate {

class JoyGateComponent : public rclcpp::Node {
public:
  explicit JoyGateComponent(const rclcpp::NodeOptions& options);

private:
  void gpio_controllable_callback(const std_msgs::msg::Bool::SharedPtr msg);
  void joy_input_callback(const sensor_msgs::msg::Joy::SharedPtr msg);

  // Publishers and subscribers
  rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr gpio_controllable_sub_;
  rclcpp::Subscription<sensor_msgs::msg::Joy>::SharedPtr joy_input_sub_;
  rclcpp::Publisher<sensor_msgs::msg::Joy>::SharedPtr joy_output_pub_;

  // Topic names (loaded from YAML)
  std::string gpio_controllable_topic_;
  std::string joy_input_topic_;
  std::string joy_output_topic_;

  // Internal state
  bool is_controllable_;
  sensor_msgs::msg::Joy last_joy_msg_;
  bool has_received_joy_;
};

}  // namespace joy_gate
