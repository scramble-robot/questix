// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#include "operation_manager/emergency_stop_manager_component.hpp"

#include <chrono>      // NOLINT(build/include_order)
#include <functional>  // NOLINT(build/include_order)
#include <rclcpp_components/register_node_macro.hpp>
#include <vector>  // NOLINT(build/include_order)

#include "operation_manager/gpio_diagnostics.hpp"

namespace {

double steady_now_seconds() {
  return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

}  // namespace

namespace operation_manager {

EmergencyStopManagerComponent::EmergencyStopManagerComponent(const rclcpp::NodeOptions& options)
    : Node("emergency_stop_manager", options) {
  // false: no GPIO safety path (questix_core enable_gpio_ref:=false, an explicit diagnostic run
  // only). The node still owns /emergency_stop and publishes "released" with that reason, so every
  // subscriber keeps one rule (unheard or silent = stopped) whatever the robot is wired with.
  this->declare_parameter<bool>("gpio_safety_enabled", true);
  // The physical E-stop circuit's GPIO pins: safe-low (false = released). GPIO5 on the QUESTiX
  // HAT. Nothing that is not a safety function belongs here (no AutoReferee GPIO27).
  this->declare_parameter<std::vector<int64_t>>("safe_low_pins", std::vector<int64_t>{5});
  this->declare_parameter<double>("timeout_seconds", 1.0);
  this->declare_parameter<std::string>("emergency_stop_topic", "/emergency_stop");

  gpio_safety_enabled_ = this->get_parameter("gpio_safety_enabled").as_bool();
  emergency_stop_topic_ = this->get_parameter("emergency_stop_topic").as_string();
  diagnostics_pub_ =
      this->create_publisher<diagnostic_msgs::msg::DiagnosticArray>("/diagnostics", 1);
  // Latched so late-joining subscribers immediately receive the current state
  // (topic contract: see questix_msgs/README.md).
  emergency_stop_pub_ = this->create_publisher<questix_msgs::msg::EmergencyStop>(
      emergency_stop_topic_, emergency_stop_qos());

  if (!gpio_safety_enabled_) {
    eval_timer_ = this->create_wall_timer(
        std::chrono::milliseconds(100),
        std::bind(&EmergencyStopManagerComponent::publishWithoutGpio, this));
    publishWithoutGpio();
    RCLCPP_WARN(this->get_logger(),
                "GPIO safety path disabled (gpio_safety_enabled=false): the physical E-stop is "
                "not monitored; %s reports \"%s\"",
                emergency_stop_topic_.c_str(), kNoGpioReason);
    return;
  }

  safety_evaluator_ = std::make_unique<GpioSafetyEvaluator>(
      this->get_parameter("safe_low_pins").as_integer_array(), std::vector<int64_t>{},
      this->get_parameter("timeout_seconds").as_double());
  for (const auto pin : safety_evaluator_->monitored_pins()) {
    const std::string topic_name = "gpio_" + std::to_string(pin);
    gpio_subs_[pin] = this->create_subscription<std_msgs::msg::Bool>(
        topic_name, 1,
        [this, pin](const std_msgs::msg::Bool::SharedPtr msg) { gpioCallback(msg, pin); });
    RCLCPP_INFO(this->get_logger(), "Subscribed to %s", topic_name.c_str());
  }
  eval_timer_ = this->create_wall_timer(std::chrono::milliseconds(100),
                                        std::bind(&EmergencyStopManagerComponent::evaluate, this));
  // Publish an explicit fail-safe state before any GPIO message has arrived.
  evaluate();
  RCLCPP_INFO(this->get_logger(), "Emergency stop manager started (%s)",
              emergency_stop_topic_.c_str());
}

rclcpp::QoS EmergencyStopManagerComponent::emergency_stop_qos() {
  return rclcpp::QoS(1).reliable().transient_local();
}

void EmergencyStopManagerComponent::publishWithoutGpio() {
  const rclcpp::Time now = this->now();

  diagnostic_msgs::msg::DiagnosticStatus status;
  status.name = "operation_manager: emergency_stop";
  status.hardware_id = "gpio";
  status.level = diagnostic_msgs::msg::DiagnosticStatus::WARN;
  status.message = "GPIO safety path disabled: the physical E-stop is not monitored";
  diagnostic_msgs::msg::DiagnosticArray diag_array;
  diag_array.header.stamp = now;
  diag_array.status.push_back(status);
  diagnostics_pub_->publish(diag_array);

  questix_msgs::msg::EmergencyStop estop_msg;
  estop_msg.header.stamp = now;
  estop_msg.active = false;
  estop_msg.source = kSource;
  estop_msg.reason = kNoGpioReason;
  emergency_stop_pub_->publish(estop_msg);
}

void EmergencyStopManagerComponent::gpioCallback(const std_msgs::msg::Bool::SharedPtr msg,
                                                 unsigned int pin) {
  safety_evaluator_->update(pin, msg->data, steady_now_seconds());
  evaluate();  // immediately on every update
}

void EmergencyStopManagerComponent::evaluate() {
  // ROS time remains authoritative for message stamps. Freshness uses a monotonic
  // clock so a ROS/system-clock adjustment cannot make stale GPIO data look fresh.
  const rclcpp::Time now = this->now();
  const auto evaluation = safety_evaluator_->evaluate(steady_now_seconds());
  const bool released = evaluation.controllable;

  diagnostic_msgs::msg::DiagnosticStatus status;
  status.name = "operation_manager: emergency_stop";
  status.hardware_id = "gpio";
  appendGpioPinValues(status, evaluation);
  status.level = released ? diagnostic_msgs::msg::DiagnosticStatus::OK
                          : diagnostic_msgs::msg::DiagnosticStatus::ERROR;
  status.message = released ? "released" : "emergency stop: " + evaluation.reason;
  diagnostic_msgs::msg::DiagnosticArray diag_array;
  diag_array.header.stamp = now;
  diag_array.status.push_back(status);
  diagnostics_pub_->publish(diag_array);

  questix_msgs::msg::EmergencyStop estop_msg;
  estop_msg.header.stamp = now;
  estop_msg.active = !released;
  estop_msg.source = kSource;
  estop_msg.reason = released ? "released" : evaluation.reason;
  emergency_stop_pub_->publish(estop_msg);
}

}  // namespace operation_manager

RCLCPP_COMPONENTS_REGISTER_NODE(operation_manager::EmergencyStopManagerComponent)
