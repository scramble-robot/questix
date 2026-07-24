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
  this->declare_parameter<std::vector<int64_t>>("safe_low_pins", std::vector<int64_t>{5});
  this->declare_parameter<std::vector<int64_t>>("safe_high_pins", std::vector<int64_t>{});
  this->declare_parameter<double>("timeout_seconds", 1.0);
  this->declare_parameter<std::string>("emergency_stop_topic", "/emergency_stop");

  const auto safe_low_pins = this->get_parameter("safe_low_pins").as_integer_array();
  const auto safe_high_pins = this->get_parameter("safe_high_pins").as_integer_array();
  const auto timeout_seconds = this->get_parameter("timeout_seconds").as_double();
  emergency_stop_topic_ = this->get_parameter("emergency_stop_topic").as_string();
  safety_evaluator_ =
      std::make_unique<GpioSafetyEvaluator>(safe_low_pins, safe_high_pins, timeout_seconds);

  controllable_pub_ = this->create_publisher<std_msgs::msg::Bool>("/gpio/controllable", 1);
  diagnostics_pub_ =
      this->create_publisher<diagnostic_msgs::msg::DiagnosticArray>("/diagnostics", 1);
  // Latched so late-joining subscribers immediately receive the current state
  // (topic contract: see questix_msgs/README.md).
  emergency_stop_pub_ = this->create_publisher<questix_msgs::msg::EmergencyStop>(
      emergency_stop_topic_, emergency_stop_qos());

  for (const auto pin : safety_evaluator_->monitored_pins()) {
    std::string topic_name = "gpio_" + std::to_string(pin);
    gpio_subs_[pin] = this->create_subscription<std_msgs::msg::Bool>(
        topic_name, 1,
        [this, pin](const std_msgs::msg::Bool::SharedPtr msg) { this->gpio_callback(msg, pin); });
    RCLCPP_INFO(this->get_logger(), "Subscribed to %s", topic_name.c_str());
  }

  eval_timer_ = this->create_wall_timer(
      std::chrono::milliseconds(100),
      std::bind(&OperationManagerComponent::evaluate_controllability, this));

  // Publish an explicit fail-safe state before any GPIO message has arrived.
  evaluate_controllability();
  RCLCPP_INFO(this->get_logger(), "Operation Manager Component started");
}

OperationManagerComponent::~OperationManagerComponent() {}

rclcpp::QoS OperationManagerComponent::emergency_stop_qos() {
  return rclcpp::QoS(1).reliable().transient_local();
}

void OperationManagerComponent::gpio_callback(const std_msgs::msg::Bool::SharedPtr msg,
                                              unsigned int pin) {
  safety_evaluator_->update(pin, msg->data, this->now().seconds());
  // Immediately evaluate on update
  evaluate_controllability();
}

void OperationManagerComponent::evaluate_controllability() {
  rclcpp::Time now = this->now();
  const auto evaluation = safety_evaluator_->evaluate(now.seconds());

  // 標準 DiagnosticArray 用に、ピンごとの状態を KeyValue として収集する。
  diagnostic_msgs::msg::DiagnosticStatus status;
  status.name = "operation_manager: gpio_controllability";
  status.hardware_id = "gpio";

  for (const auto& pin : evaluation.pins) {
    diagnostic_msgs::msg::KeyValue kv_state;
    kv_state.key = "pin_" + std::to_string(pin.pin) + "_state";
    kv_state.value = pin.received ? (pin.value ? "true" : "false") : "not_received";
    status.values.push_back(kv_state);
    diagnostic_msgs::msg::KeyValue kv_expected;
    kv_expected.key = "pin_" + std::to_string(pin.pin) + "_expected";
    kv_expected.value = pin.expected_value ? "true" : "false";
    status.values.push_back(kv_expected);
    diagnostic_msgs::msg::KeyValue kv_received;
    kv_received.key = "pin_" + std::to_string(pin.pin) + "_received";
    kv_received.value = pin.received ? "true" : "false";
    status.values.push_back(kv_received);
    diagnostic_msgs::msg::KeyValue kv_age;
    kv_age.key = "pin_" + std::to_string(pin.pin) + "_age_sec";
    kv_age.value = pin.received ? std::to_string(pin.age_seconds) : "not_received";
    status.values.push_back(kv_age);
    if (pin.pin == 27U) {
      diagnostic_msgs::msg::KeyValue kv_signal_limit;
      kv_signal_limit.key = "pin_27_signal_limit";
      kv_signal_limit.value =
          "true cannot distinguish permission, disconnected, client unpowered, or "
          "primary-side open";
      status.values.push_back(kv_signal_limit);
    }
  }

  std_msgs::msg::Bool out;
  out.data = evaluation.controllable;
  controllable_pub_->publish(out);

  // 標準 DiagnosticArray（rqt_runtime_monitor が設定なしで消費可）。
  status.level = evaluation.controllable ? diagnostic_msgs::msg::DiagnosticStatus::OK
                                         : diagnostic_msgs::msg::DiagnosticStatus::ERROR;
  status.message =
      evaluation.controllable ? "controllable" : "not_controllable: " + evaluation.reason;
  diagnostic_msgs::msg::DiagnosticArray diag_array;
  diag_array.header.stamp = now;
  diag_array.status.push_back(status);
  diagnostics_pub_->publish(diag_array);

  questix_msgs::msg::EmergencyStop estop_msg;
  estop_msg.header.stamp = now;
  estop_msg.active = !evaluation.controllable;
  estop_msg.source = "operation_manager";
  estop_msg.reason = evaluation.controllable ? "released" : evaluation.reason;
  emergency_stop_pub_->publish(estop_msg);
}

}  // namespace operation_manager

RCLCPP_COMPONENTS_REGISTER_NODE(operation_manager::OperationManagerComponent)
