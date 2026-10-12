// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "command_arbiter/drive_arbiter_component.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <rclcpp_components/register_node_macro.hpp>
#include <stdexcept>
#include <string>

namespace command_arbiter {

namespace {

double finiteOrZero(double value) { return std::isfinite(value) ? value : 0.0; }

std::chrono::nanoseconds periodOf(double hz) {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::duration<double>(1.0 / std::clamp(std::isfinite(hz) ? hz : 20.0, 1.0, 100.0)));
}

}  // namespace

DriveArbiterComponent::DriveArbiterComponent(const rclcpp::NodeOptions& options)
    : Node("drive_arbiter", options) {
  const auto joy_topic = this->declare_parameter<std::string>("joy_topic", "/target_twist/joy");
  const auto lab_topic = this->declare_parameter<std::string>("lab_topic", "/target_twist/lab");
  const auto output_topic = this->declare_parameter<std::string>("output_topic", "/target_twist");
  const auto status_topic =
      this->declare_parameter<std::string>("status_topic", "/command_arbiter/status");
  const auto permission_topic =
      this->declare_parameter<std::string>("lab_permission_topic", "/lab_permission");
  const double lease_sec = this->declare_parameter<double>("lab_permission_lease_sec", 1.0);
  const double tick_hz = this->declare_parameter<double>("tick_hz", 20.0);
  const double status_hz = this->declare_parameter<double>("status_hz", 5.0);
  neutral_linear_ = this->declare_parameter<double>("neutral_linear", 0.01);
  neutral_angular_ = this->declare_parameter<double>("neutral_angular", 0.025);
  lab_max_linear_ = std::abs(this->declare_parameter<double>("lab_max_linear", 0.15));
  lab_max_angular_ = std::abs(this->declare_parameter<double>("lab_max_angular", 0.5));
  SourceSelector::Config config;
  config.controller_quiet_sec = this->declare_parameter<double>("controller_quiet_sec", 0.0);
  config.joy_timeout_sec = this->declare_parameter<double>("joy_timeout_sec", 0.5);
  config.lab_timeout_sec = this->declare_parameter<double>("lab_timeout_sec", 0.3);
  selector_.configure(config);
  if (!std::isfinite(lab_max_linear_) || !std::isfinite(lab_max_angular_)) {
    throw std::invalid_argument("drive_arbiter: lab_max_linear and lab_max_angular must be finite");
  }

  permission_ = std::make_unique<LabPermission>(*this, permission_topic, lease_sec,
                                                LabPermission::Flag::kDrive);
  // Depth 1 like drive_component's own /target_twist subscription: only the newest counts.
  output_pub_ = this->create_publisher<geometry_msgs::msg::Twist>(output_topic, rclcpp::QoS(1));
  status_pub_ = this->create_publisher<questix_msgs::msg::ArbiterStatus>(
      status_topic, rclcpp::QoS(10).reliable().durability_volatile());
  joy_sub_ = this->create_subscription<geometry_msgs::msg::Twist>(
      joy_topic, rclcpp::QoS(1),
      [this](const geometry_msgs::msg::Twist::SharedPtr msg) { joyCallback(*msg); });
  lab_sub_ = this->create_subscription<geometry_msgs::msg::Twist>(
      lab_topic, rclcpp::QoS(1),
      [this](const geometry_msgs::msg::Twist::SharedPtr msg) { labCallback(*msg); });
  tick_timer_ = this->create_wall_timer(periodOf(tick_hz), [this]() { tickCallback(); });
  status_timer_ = this->create_wall_timer(periodOf(status_hz), [this]() { publishStatus(true); });

  publishStatus(true);
  RCLCPP_INFO(this->get_logger(),
              "drive_arbiter: %s (controller) / %s (QUESTiX LAB, max %.2f m/s, %.2f rad/s) -> %s",
              joy_topic.c_str(), lab_topic.c_str(), lab_max_linear_, lab_max_angular_,
              output_topic.c_str());
}

double DriveArbiterComponent::nowSec() const { return steady_clock_.now().seconds(); }

void DriveArbiterComponent::publishTwist(double linear, double angular) {
  geometry_msgs::msg::Twist msg;
  msg.linear.x = linear;
  msg.angular.z = angular;
  output_pub_->publish(msg);
}

void DriveArbiterComponent::joyCallback(const geometry_msgs::msg::Twist& msg) {
  const double linear = finiteOrZero(msg.linear.x);
  const double angular = finiteOrZero(msg.angular.z);
  const bool active = std::abs(linear) >= neutral_linear_ || std::abs(angular) >= neutral_angular_;
  const auto before = selector_.labLocked();
  if (selector_.onJoy(active, nowSec())) {
    publishTwist(linear, angular);
  }
  if (!before && selector_.labLocked()) {
    RCLCPP_INFO(this->get_logger(), "controller took over from QUESTiX LAB");
  }
  publishStatus(false);
}

void DriveArbiterComponent::labCallback(const geometry_msgs::msg::Twist& msg) {
  const double now = nowSec();
  const bool permitted = permission_->permitted();
  if (!std::isfinite(msg.linear.x) || !std::isfinite(msg.angular.z)) {
    // A broken command is never forwarded as given: it ends a run the lab has, with a stop.
    if (selector_.source() == SourceSelector::Source::kLab) {
      selector_.onLab(true, permitted, now);
      publishTwist(0.0, 0.0);
    }
    selector_.refuse(SourceSelector::Refusal::kInvalid);
    publishStatus(false);
    return;
  }
  const double linear = std::clamp(msg.linear.x, -lab_max_linear_, lab_max_linear_);
  const double angular = std::clamp(msg.angular.z, -lab_max_angular_, lab_max_angular_);
  const bool neutral = linear == 0.0 && angular == 0.0;
  const auto decision = selector_.onLab(neutral, permitted, now);
  if (decision.forward) {
    publishTwist(linear, angular);
  } else if (decision.stop) {
    publishTwist(0.0, 0.0);
  }
  publishStatus(false);
}

void DriveArbiterComponent::tickCallback() {
  const bool permitted = permission_->permitted();
  if (selector_.onTick(permitted, nowSec())) {
    publishTwist(0.0, 0.0);  // the lab had the drive and its run ended without a stop
    RCLCPP_INFO(this->get_logger(), "QUESTiX LAB run ended (%s): drive stopped",
                SourceSelector::reasonName(selector_.reason()));
  }
  publishStatus(permitted != last_permitted_);
}

void DriveArbiterComponent::publishStatus(bool force) {
  const bool permitted = permission_->permitted();
  if (!force && sent_version_ && *sent_version_ == selector_.version() &&
      permitted == last_permitted_) {
    return;
  }
  sent_version_ = selector_.version();
  last_permitted_ = permitted;
  const float nan = std::numeric_limits<float>::quiet_NaN();
  questix_msgs::msg::ArbiterStatus status;
  status.header.stamp = this->now();
  status.mechanism = "drive";
  status.active_source = SourceSelector::sourceName(selector_.source());
  status.switch_reason = SourceSelector::reasonName(selector_.reason());
  status.lab_permitted = permitted;
  status.lab_locked = selector_.labLocked();
  status.lab_refusal = SourceSelector::refusalName(selector_.refusal());
  status.lab_count = selector_.labCount();
  status.max_linear = static_cast<float>(lab_max_linear_);
  status.max_angular = static_cast<float>(lab_max_angular_);
  status.max_power = nan;
  status.tilt_min_deg = nan;
  status.tilt_max_deg = nan;
  status.min_fire_power = nan;
  status.spin_up_sec = nan;
  status.fire_interval_sec = nan;
  status.next_fire_in_sec = nan;
  status.spin_ready_in_sec = nan;
  status_pub_->publish(status);
}

}  // namespace command_arbiter

RCLCPP_COMPONENTS_REGISTER_NODE(command_arbiter::DriveArbiterComponent)
