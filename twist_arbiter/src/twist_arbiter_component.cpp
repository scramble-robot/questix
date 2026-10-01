// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "twist_arbiter/twist_arbiter_component.hpp"

#include <algorithm>
#include <chrono>
#include <rclcpp_components/register_node_macro.hpp>

namespace twist_arbiter {

TwistArbiterComponent::TwistArbiterComponent(const rclcpp::NodeOptions& options)
    : Node("twist_arbiter", options) {
  const auto joy_topic = this->declare_parameter<std::string>("joy_topic", "/target_twist/joy");
  const auto lab_topic = this->declare_parameter<std::string>("lab_topic", "/target_twist/lab");
  const auto output_topic = this->declare_parameter<std::string>("output_topic", "/target_twist");
  const auto status_topic =
      this->declare_parameter<std::string>("status_topic", "/twist_arbiter/status");
  const double tick_hz = this->declare_parameter<double>("tick_hz", 20.0);
  ArbiterLogic::Config config;
  config.neutral_linear = this->declare_parameter<double>("neutral_linear", 0.02);
  config.neutral_angular = this->declare_parameter<double>("neutral_angular", 0.05);
  config.lab_timeout_sec = this->declare_parameter<double>("lab_timeout_sec", 0.3);
  config.joy_timeout_sec = this->declare_parameter<double>("joy_timeout_sec", 0.5);
  logic_.configure(config);

  // Depth 1 like drive_component's own /target_twist subscription: only the newest counts.
  output_pub_ = this->create_publisher<geometry_msgs::msg::Twist>(output_topic, rclcpp::QoS(1));
  // Latched, so a lab bridge started later learns the current source at once.
  status_pub_ = this->create_publisher<std_msgs::msg::String>(
      status_topic, rclcpp::QoS(1).reliable().transient_local());
  joy_sub_ = this->create_subscription<geometry_msgs::msg::Twist>(
      joy_topic, rclcpp::QoS(1),
      std::bind(&TwistArbiterComponent::joyCallback, this, std::placeholders::_1));
  lab_sub_ = this->create_subscription<geometry_msgs::msg::Twist>(
      lab_topic, rclcpp::QoS(1),
      std::bind(&TwistArbiterComponent::labCallback, this, std::placeholders::_1));
  const auto period = std::chrono::duration<double>(1.0 / std::max(1.0, tick_hz));
  tick_timer_ =
      this->create_wall_timer(std::chrono::duration_cast<std::chrono::nanoseconds>(period),
                              std::bind(&TwistArbiterComponent::tickCallback, this));

  publishStatus();
  RCLCPP_INFO(this->get_logger(), "twist_arbiter: %s (controller) / %s (QUESTiX LAB) -> %s",
              joy_topic.c_str(), lab_topic.c_str(), output_topic.c_str());
}

double TwistArbiterComponent::nowSec() const { return steady_clock_.now().seconds(); }

void TwistArbiterComponent::publishCommand(const std::optional<ArbiterLogic::Command>& command) {
  if (!command) {
    return;
  }
  geometry_msgs::msg::Twist msg;
  msg.linear.x = command->linear;
  msg.angular.z = command->angular;
  output_pub_->publish(msg);
}

void TwistArbiterComponent::joyCallback(const geometry_msgs::msg::Twist::SharedPtr msg) {
  publishCommand(logic_.onJoy(msg->linear.x, msg->angular.z, nowSec()));
  publishStatus();
}

void TwistArbiterComponent::labCallback(const geometry_msgs::msg::Twist::SharedPtr msg) {
  publishCommand(logic_.onLab(msg->linear.x, msg->angular.z, nowSec()));
  publishStatus();
}

void TwistArbiterComponent::tickCallback() {
  logic_.onTick(nowSec());
  publishStatus();
}

void TwistArbiterComponent::publishStatus() {
  if (sent_version_ && *sent_version_ == logic_.version()) {
    return;
  }
  sent_version_ = logic_.version();
  // A tiny JSON object, read by questix_lab_bridge (bridge_node.py).
  std_msgs::msg::String status;
  status.data = std::string("{\"active\":\"") + ArbiterLogic::sourceName(logic_.source()) +
                "\",\"reason\":\"" + ArbiterLogic::reasonName(logic_.reason()) +
                "\",\"lab_locked\":" + (logic_.labLocked() ? "true" : "false") + "}";
  status_pub_->publish(status);
  // Logged when the stick takes over (the lock is set then), not again when the lock is lifted.
  if (logic_.reason() == ArbiterLogic::Reason::kController && logic_.labLocked()) {
    RCLCPP_INFO(this->get_logger(), "controller took over from QUESTiX LAB");
  }
}

}  // namespace twist_arbiter

RCLCPP_COMPONENTS_REGISTER_NODE(twist_arbiter::TwistArbiterComponent)
