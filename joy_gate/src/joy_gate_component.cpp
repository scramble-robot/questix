// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "joy_gate/joy_gate_component.hpp"

#include <rclcpp_components/register_node_macro.hpp>

namespace joy_gate {

JoyGateComponent::JoyGateComponent(const rclcpp::NodeOptions& options) : Node("joy_gate", options) {
  // Declare and load parameters from YAML
  gpio_controllable_topic_ =
      this->declare_parameter<std::string>("gpio_controllable_topic", "/gpio/controllable");
  joy_input_topic_ = this->declare_parameter<std::string>("joy_input_topic", "/joy");
  joy_output_topic_ = this->declare_parameter<std::string>("joy_output_topic", "/joy_gated");
  // qos_depth applies to the gpio_controllable subscription (RELIABLE).
  // Joy input/output intentionally use depth 1 to avoid stale-input latency.
  const int qos_depth = this->declare_parameter<int>("qos_depth", 10);
  // /gpio/controllable normally arrives at ~20 Hz; 1.0s default leaves a large
  // margin. <= 0 disables the timeout fallback.
  controllable_timeout_sec_ = this->declare_parameter<double>("controllable_timeout_sec", 1.0);

  gate_.configure(controllable_timeout_sec_);

  // Initialize last joy message with empty state
  last_joy_msg_.header.stamp = this->now();
  last_joy_msg_.axes.clear();
  last_joy_msg_.buttons.clear();

  // Subscribe to GPIO controllable status
  gpio_controllable_sub_ = this->create_subscription<std_msgs::msg::Bool>(
      gpio_controllable_topic_,
      rclcpp::QoS(qos_depth).reliability(RMW_QOS_POLICY_RELIABILITY_RELIABLE),
      std::bind(&JoyGateComponent::gpio_controllable_callback, this, std::placeholders::_1));

  // Subscribe to input joy messages
  joy_input_sub_ = this->create_subscription<sensor_msgs::msg::Joy>(
      joy_input_topic_, rclcpp::QoS(1),
      std::bind(&JoyGateComponent::joy_input_callback, this, std::placeholders::_1));

  // Publish gated joy messages
  joy_output_pub_ =
      this->create_publisher<sensor_msgs::msg::Joy>(joy_output_topic_, rclcpp::QoS(1));

  if (controllable_timeout_sec_ > 0.0) {
    timeout_timer_ = this->create_wall_timer(
        std::chrono::milliseconds(100), std::bind(&JoyGateComponent::timeout_check_callback, this));
  } else {
    RCLCPP_WARN(this->get_logger(),
                "controllable_timeout_sec <= 0: %s reception timeout is disabled",
                gpio_controllable_topic_.c_str());
  }

  RCLCPP_INFO(this->get_logger(), "Joy Gate Node initialized");
  RCLCPP_INFO(this->get_logger(), "Subscribing to: %s, %s", gpio_controllable_topic_.c_str(),
              joy_input_topic_.c_str());
  RCLCPP_INFO(this->get_logger(), "Publishing to: %s", joy_output_topic_.c_str());
}

void JoyGateComponent::gpio_controllable_callback(const std_msgs::msg::Bool::SharedPtr msg) {
  const auto r = gate_.onControllableMsg(msg->data, this->now().seconds());

  if (r.recovered) {
    RCLCPP_INFO(this->get_logger(), "%s reception recovered", gpio_controllable_topic_.c_str());
  }

  if (r.changed) {
    RCLCPP_INFO(this->get_logger(), "GPIO controllable status changed to: %s",
                gate_.isControllable() ? "TRUE" : "FALSE");
  }

  // If we just became uncontrollable, publish a zero joy message
  if (r.publish_zero && has_received_joy_) {
    publish_zero_joy();
    RCLCPP_DEBUG(this->get_logger(), "Published zero joy message due to uncontrollable state");
  }
}

void JoyGateComponent::timeout_check_callback() {
  const auto r = gate_.onTimerCheck(this->now().seconds());

  if (r.timed_out) {
    RCLCPP_WARN(this->get_logger(),
                "no %s update for more than %.2fs: falling back to uncontrollable",
                gpio_controllable_topic_.c_str(), controllable_timeout_sec_);

    if (has_received_joy_) {
      publish_zero_joy();
    }
  }
}

void JoyGateComponent::publish_zero_joy() {
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
}

void JoyGateComponent::joy_input_callback(const sensor_msgs::msg::Joy::SharedPtr msg) {
  // Always store the last received message structure
  last_joy_msg_ = *msg;
  has_received_joy_ = true;

  if (gate_.isControllable()) {
    // If controllable, pass through the joy message
    joy_output_pub_->publish(*msg);
    RCLCPP_DEBUG(this->get_logger(), "Joy message passed through (controllable=true)");
  } else {
    // If not controllable, publish a zero message with the same structure
    publish_zero_joy();
    RCLCPP_DEBUG(this->get_logger(),
                 "Joy message blocked (controllable=false), published zero message");
  }
}

}  // namespace joy_gate

RCLCPP_COMPONENTS_REGISTER_NODE(joy_gate::JoyGateComponent)
