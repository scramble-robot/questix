// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#include "operation_manager/referee_monitor_component.hpp"

#include <chrono>  // NOLINT(build/include_order)
#include <rclcpp_components/register_node_macro.hpp>
#include <vector>  // NOLINT(build/include_order)

#include "operation_manager/gpio_diagnostics.hpp"

namespace {

double steady_now_seconds() {
  return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

}  // namespace

namespace operation_manager {

RefereeMonitorComponent::RefereeMonitorComponent(const rclcpp::NodeOptions& options)
    : Node("referee_monitor", options) {
  // GPIO27 = AutoReferee AR_in (safe-high: true = may move). Hardware also reads true when the
  // AutoReferee is disconnected, unpowered or its primary side is open (pin_27_signal_limit).
  const auto pins = this->declare_parameter<std::vector<int64_t>>("referee_pins", {27});
  timeout_seconds_ = this->declare_parameter<double>("timeout_seconds", 1.0);
  const auto vote_topic =
      this->declare_parameter<std::string>("vote_topic", "/motion_vote/referee");

  evaluator_ =
      std::make_unique<GpioSafetyEvaluator>(std::vector<int64_t>{}, pins, timeout_seconds_);
  // The vote contract of /actuation_authority: never latched, so a silent referee goes stale.
  vote_pub_ = this->create_publisher<questix_msgs::msg::ActuationAuthority>(
      vote_topic, rclcpp::QoS(1).reliable().durability_volatile());
  diagnostics_pub_ =
      this->create_publisher<diagnostic_msgs::msg::DiagnosticArray>("/diagnostics", 1);
  for (const auto pin : evaluator_->monitored_pins()) {
    gpio_subs_[pin] = this->create_subscription<std_msgs::msg::Bool>(
        "gpio_" + std::to_string(pin), 1,
        [this, pin](const std_msgs::msg::Bool::SharedPtr msg) { gpioCallback(msg, pin); });
  }
  timer_ = this->create_wall_timer(std::chrono::milliseconds(100), [this]() { evaluate(); });
  evaluate();  // an explicit "not allowed" before any GPIO message
  RCLCPP_INFO(this->get_logger(), "Referee vote on %s (GPIO safe-high, timeout %.2fs)",
              vote_topic.c_str(), timeout_seconds_);
}

void RefereeMonitorComponent::gpioCallback(const std_msgs::msg::Bool::SharedPtr msg,
                                           unsigned int pin) {
  evaluator_->update(pin, msg->data, steady_now_seconds());
  evaluate();
}

void RefereeMonitorComponent::evaluate() {
  // Freshness on the monotonic clock: a ROS/system-clock step cannot make a stale pin look fresh.
  const auto evaluation = evaluator_->evaluate(steady_now_seconds());
  const rclcpp::Time now = this->now();

  questix_msgs::msg::ActuationAuthority vote;
  vote.header.stamp = now;
  vote.drive_allowed = evaluation.controllable;
  vote.launcher_allowed = evaluation.controllable;
  vote.source = kSource;
  vote_pub_->publish(vote);

  diagnostic_msgs::msg::DiagnosticStatus status;
  status.name = "operation_manager: referee";
  status.hardware_id = "gpio";
  appendGpioPinValues(status, evaluation);
  // Not moving because of the referee is a game state (WARN); the signal missing is a fault.
  bool signal_ok = true;
  for (const auto& pin : evaluation.pins) {
    signal_ok = signal_ok && pin.received && pin.age_seconds <= timeout_seconds_;
  }
  status.level = evaluation.controllable ? diagnostic_msgs::msg::DiagnosticStatus::OK
                 : signal_ok             ? diagnostic_msgs::msg::DiagnosticStatus::WARN
                                         : diagnostic_msgs::msg::DiagnosticStatus::ERROR;
  status.message = evaluation.controllable ? "referee allows motion"
                                           : "referee does not allow motion: " + evaluation.reason;
  diagnostic_msgs::msg::DiagnosticArray array;
  array.header.stamp = now;
  array.status.push_back(status);
  diagnostics_pub_->publish(array);

  if (!reported_ || evaluation.controllable != last_allowed_) {
    if (evaluation.controllable) {
      RCLCPP_INFO(this->get_logger(), "Referee allows motion");
    } else {
      RCLCPP_WARN(this->get_logger(), "Referee does not allow motion: %s",
                  evaluation.reason.c_str());
    }
    reported_ = true;
    last_allowed_ = evaluation.controllable;
  }
}

}  // namespace operation_manager

RCLCPP_COMPONENTS_REGISTER_NODE(operation_manager::RefereeMonitorComponent)
