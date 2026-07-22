// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#include "operation_manager/operation_manager_component.hpp"

#include <chrono>
#include <functional>
#include <rclcpp_components/register_node_macro.hpp>

namespace operation_manager {

OperationManagerComponent::OperationManagerComponent(const rclcpp::NodeOptions& options)
    : Node("operation_manager_node", options) {
  this->declare_parameter<std::vector<int64_t>>("monitored_pins", std::vector<int64_t>{27});
  this->declare_parameter<double>("timeout_seconds", 1.0);
  this->declare_parameter<std::string>("emergency_stop_topic", "/emergency_stop");

  monitored_pins_ = this->get_parameter("monitored_pins").as_integer_array();
  timeout_seconds_ = this->get_parameter("timeout_seconds").as_double();
  emergency_stop_topic_ = this->get_parameter("emergency_stop_topic").as_string();

  controllable_pub_ = this->create_publisher<std_msgs::msg::Bool>("/gpio/controllable", 1);
  diagnostic_pub_ =
      this->create_publisher<std_msgs::msg::String>("/gpio/controllable_diagnostic", 1);
  // Latched so late-joining subscribers immediately receive the current state
  // (topic contract: see questix_msgs/README.md).
  emergency_stop_pub_ = this->create_publisher<questix_msgs::msg::EmergencyStop>(
      emergency_stop_topic_, rclcpp::QoS(1).reliable().transient_local());

  for (const auto& pin : monitored_pins_) {
    unsigned int p = static_cast<unsigned int>(pin);
    gpio_states_[p] = false;
    gpio_last_update_[p] = this->now();
    std::string topic_name = "gpio_" + std::to_string(p);
    gpio_subs_[p] = this->create_subscription<std_msgs::msg::Bool>(
        topic_name, 1,
        [this, p](const std_msgs::msg::Bool::SharedPtr msg) { this->gpio_callback(msg, p); });
    RCLCPP_INFO(this->get_logger(), "Subscribed to %s", topic_name.c_str());
  }

  eval_timer_ = this->create_wall_timer(
      std::chrono::milliseconds(1000),
      std::bind(&OperationManagerComponent::evaluate_controllability, this));

  RCLCPP_INFO(this->get_logger(), "Operation Manager Component started");
}

OperationManagerComponent::~OperationManagerComponent() {}

void OperationManagerComponent::gpio_callback(const std_msgs::msg::Bool::SharedPtr msg,
                                              unsigned int pin) {
  gpio_states_[pin] = msg->data;
  gpio_last_update_[pin] = this->now();
  // Immediately evaluate on update
  evaluate_controllability();
}

void OperationManagerComponent::evaluate_controllability() {
  bool controllable = true;
  std::string diagnostic = "";
  rclcpp::Time now = this->now();

  for (const auto& pair : gpio_states_) {
    unsigned int pin = pair.first;
    bool state = pair.second;
    double elapsed = (now - gpio_last_update_[pin]).seconds();

    if (elapsed > timeout_seconds_) {
      controllable = false;
      diagnostic += "pin " + std::to_string(pin) + " timeout; ";
    } else if (!state) {  // GPIO値がfalseの場合
      controllable = false;
      diagnostic += "pin " + std::to_string(pin) + " is false; ";
    }
  }

  std_msgs::msg::Bool out;
  out.data = controllable;
  controllable_pub_->publish(out);

  std_msgs::msg::String diag_msg;
  if (controllable) {
    diag_msg.data = "controllable";
  } else {
    diag_msg.data = "not_controllable: " + diagnostic;
  }
  diagnostic_pub_->publish(diag_msg);

  questix_msgs::msg::EmergencyStop estop_msg;
  estop_msg.header.stamp = now;
  estop_msg.active = !controllable;
  estop_msg.source = "operation_manager";
  estop_msg.reason = controllable ? "released" : diagnostic;
  emergency_stop_pub_->publish(estop_msg);
}

}  // namespace operation_manager

RCLCPP_COMPONENTS_REGISTER_NODE(operation_manager::OperationManagerComponent)
