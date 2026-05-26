// Copyright 2026 scramble-robot
//
#include "joy_gate/joy_gate_component.hpp"

#include <rclcpp_components/register_node_macro.hpp>

namespace joy_gate {

JoyGateComponent::JoyGateComponent(const rclcpp::NodeOptions& options)
    : Node("joy_gate", options), is_controllable_(false), has_received_joy_(false) {
  // Initialize last joy message with empty state
  last_joy_msg_.header.stamp = this->now();
  last_joy_msg_.axes.clear();
  last_joy_msg_.buttons.clear();

  // Subscribe to GPIO controllable status
  gpio_controllable_sub_ = this->create_subscription<std_msgs::msg::Bool>(
      "/gpio/controllable", rclcpp::QoS(10).reliability(RMW_QOS_POLICY_RELIABILITY_RELIABLE),
      std::bind(&JoyGateComponent::gpio_controllable_callback, this, std::placeholders::_1));

  // Subscribe to input joy messages
  joy_input_sub_ = this->create_subscription<sensor_msgs::msg::Joy>(
      "/joy", rclcpp::QoS(1),
      std::bind(&JoyGateComponent::joy_input_callback, this, std::placeholders::_1));

  // Publish gated joy messages
  joy_output_pub_ = this->create_publisher<sensor_msgs::msg::Joy>("/joy_gated", rclcpp::QoS(1));

  RCLCPP_INFO(this->get_logger(), "Joy Gate Node initialized");
  RCLCPP_INFO(this->get_logger(), "Subscribing to: /gpio/controllable, /joy");
  RCLCPP_INFO(this->get_logger(), "Publishing to: /joy_gated");
}

void JoyGateComponent::gpio_controllable_callback(const std_msgs::msg::Bool::SharedPtr msg) {
  bool prev_controllable = is_controllable_;
  is_controllable_ = msg->data;

  if (prev_controllable != is_controllable_) {
    RCLCPP_INFO(this->get_logger(), "GPIO controllable status changed to: %s",
                is_controllable_ ? "TRUE" : "FALSE");
  }

  // If we just became uncontrollable, publish a zero joy message
  if (!is_controllable_ && has_received_joy_) {
    sensor_msgs::msg::Joy zero_joy = last_joy_msg_;
    zero_joy.header.stamp = this->now();

    // Set all axes and buttons to zero
    for (auto& axis : zero_joy.axes) {
      axis = 0.0;
    }
    for (auto& button : zero_joy.buttons) {
      button = 0;
    }

    joy_output_pub_->publish(zero_joy);
    RCLCPP_DEBUG(this->get_logger(), "Published zero joy message due to uncontrollable state");
  }
}

void JoyGateComponent::joy_input_callback(const sensor_msgs::msg::Joy::SharedPtr msg) {
  // Always store the last received message structure
  last_joy_msg_ = *msg;
  has_received_joy_ = true;

  if (is_controllable_) {
    // If controllable, pass through the joy message
    joy_output_pub_->publish(*msg);
    RCLCPP_DEBUG(this->get_logger(), "Joy message passed through (controllable=true)");
  } else {
    // If not controllable, publish a zero message with the same structure
    sensor_msgs::msg::Joy zero_joy = *msg;
    zero_joy.header.stamp = this->now();

    // Set all axes and buttons to zero
    for (auto& axis : zero_joy.axes) {
      axis = 0.0;
    }
    for (auto& button : zero_joy.buttons) {
      button = 0;
    }

    joy_output_pub_->publish(zero_joy);
    RCLCPP_DEBUG(this->get_logger(),
                 "Joy message blocked (controllable=false), published zero message");
  }
}

}  // namespace joy_gate

RCLCPP_COMPONENTS_REGISTER_NODE(joy_gate::JoyGateComponent)
