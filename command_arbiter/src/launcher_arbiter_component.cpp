// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "command_arbiter/launcher_arbiter_component.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <rclcpp_components/register_node_macro.hpp>
#include <stdexcept>
#include <string>

namespace command_arbiter {

namespace {

std::chrono::nanoseconds periodOf(double hz) {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::duration<double>(1.0 / std::clamp(std::isfinite(hz) ? hz : 20.0, 1.0, 100.0)));
}

// reliable + volatile + keep-last(1) (questix_msgs/msg/LauncherCommand.msg).
rclcpp::QoS commandQos() { return rclcpp::QoS(1).reliable().durability_volatile(); }

LauncherFlow::Command toCommand(const questix_msgs::msg::LauncherCommand& msg) {
  LauncherFlow::Command command;
  command.roller_power = msg.roller_power;
  command.tilt_deg = msg.tilt_deg;
  command.tilt_steps = msg.tilt_steps;
  command.fire_seq = msg.fire_seq;
  return command;
}

}  // namespace

LauncherArbiterComponent::LauncherArbiterComponent(const rclcpp::NodeOptions& options)
    : Node("launcher_arbiter", options) {
  const auto joy_topic = this->declare_parameter<std::string>("joy_topic", "/launcher_command/joy");
  const auto lab_topic = this->declare_parameter<std::string>("lab_topic", "/launcher_command/lab");
  const auto output_topic =
      this->declare_parameter<std::string>("output_topic", "/launcher_command");
  const auto status_topic =
      this->declare_parameter<std::string>("status_topic", "/command_arbiter/status");
  const auto permission_topic =
      this->declare_parameter<std::string>("lab_permission_topic", "/lab_permission");
  const double lease_sec = this->declare_parameter<double>("lab_permission_lease_sec", 1.0);
  const double tick_hz = this->declare_parameter<double>("tick_hz", 20.0);
  const double status_hz = this->declare_parameter<double>("status_hz", 5.0);
  LauncherFlow::Config config;
  config.selector.controller_quiet_sec =
      this->declare_parameter<double>("controller_quiet_sec", 1.0);
  config.selector.joy_timeout_sec = this->declare_parameter<double>("joy_timeout_sec", 0.5);
  config.selector.lab_timeout_sec = this->declare_parameter<double>("lab_timeout_sec", 1.0);
  config.input_timeout_sec = this->declare_parameter<double>("input_timeout_sec", 1.0);
  config.lab_max_power = this->declare_parameter<double>("lab_max_power", 0.8);
  config.lab_tilt_min_deg = this->declare_parameter<double>("lab_tilt_min_deg", 0.0);
  config.lab_tilt_max_deg = this->declare_parameter<double>("lab_tilt_max_deg", 120.0);
  config.min_fire_power = this->declare_parameter<double>("min_fire_power", 0.2);
  config.spin_up_sec = this->declare_parameter<double>("spin_up_sec", 1.0);
  config.fire_interval_sec = this->declare_parameter<double>("fire_interval_sec", 2.0);
  for (const double value : {config.lab_max_power, config.lab_tilt_min_deg, config.lab_tilt_max_deg,
                             config.min_fire_power, config.spin_up_sec, config.fire_interval_sec}) {
    if (!std::isfinite(value)) {
      throw std::invalid_argument(
          "launcher_arbiter: the lab caps and shot settings must be finite");
    }
  }
  if (config.lab_max_power < 0.0 || config.lab_max_power > 1.0 ||
      config.lab_tilt_min_deg > config.lab_tilt_max_deg) {
    throw std::invalid_argument(
        "launcher_arbiter: lab_max_power must be 0..1 and lab_tilt_min_deg <= lab_tilt_max_deg");
  }
  flow_.configure(config);

  permission_ = std::make_unique<LabPermission>(*this, permission_topic, lease_sec,
                                                LabPermission::Flag::kLauncher);
  output_pub_ =
      this->create_publisher<questix_msgs::msg::LauncherCommand>(output_topic, commandQos());
  status_pub_ = this->create_publisher<questix_msgs::msg::ArbiterStatus>(
      status_topic, rclcpp::QoS(10).reliable().durability_volatile());
  joy_sub_ = this->create_subscription<questix_msgs::msg::LauncherCommand>(
      joy_topic, commandQos(),
      [this](const questix_msgs::msg::LauncherCommand::SharedPtr msg) { joyCallback(*msg); });
  lab_sub_ = this->create_subscription<questix_msgs::msg::LauncherCommand>(
      lab_topic, commandQos(),
      [this](const questix_msgs::msg::LauncherCommand::SharedPtr msg) { labCallback(*msg); });
  tick_timer_ = this->create_wall_timer(periodOf(tick_hz), [this]() { tickCallback(); });
  status_timer_ = this->create_wall_timer(periodOf(status_hz), [this]() { publishStatus(true); });

  publishStatus(true);
  RCLCPP_INFO(this->get_logger(),
              "launcher_arbiter: %s (controller) / %s (QUESTiX LAB, roller max %.2f, tilt "
              "%.0f..%.0f deg, shot after %.1f s at %.2f, every %.1f s) -> %s",
              joy_topic.c_str(), lab_topic.c_str(), config.lab_max_power, config.lab_tilt_min_deg,
              config.lab_tilt_max_deg, config.spin_up_sec, config.min_fire_power,
              config.fire_interval_sec, output_topic.c_str());
}

double LauncherArbiterComponent::nowSec() const { return steady_clock_.now().seconds(); }

void LauncherArbiterComponent::publish(const LauncherFlow::Output& output) {
  if (!output.publish) {
    return;
  }
  questix_msgs::msg::LauncherCommand msg;
  msg.header.stamp = this->now();
  msg.roller_power = static_cast<float>(output.command.roller_power);
  msg.tilt_deg = static_cast<float>(output.command.tilt_deg);
  msg.tilt_steps = output.command.tilt_steps;
  msg.fire_seq = output.command.fire_seq;
  msg.source = SourceSelector::sourceName(output.source);
  output_pub_->publish(msg);
}

void LauncherArbiterComponent::joyCallback(const questix_msgs::msg::LauncherCommand& msg) {
  const bool was_locked = flow_.selector().labLocked();
  publish(flow_.onJoy(toCommand(msg), nowSec()));
  if (!was_locked && flow_.selector().labLocked()) {
    RCLCPP_INFO(this->get_logger(), "controller took the launcher over from QUESTiX LAB");
  }
  publishStatus(false);
}

void LauncherArbiterComponent::labCallback(const questix_msgs::msg::LauncherCommand& msg) {
  const auto before = flow_.precondition();
  publish(flow_.onLab(toCommand(msg), permission_->permitted(), nowSec()));
  if (flow_.precondition() != before && flow_.precondition() != LauncherFlow::Precondition::kNone) {
    RCLCPP_INFO(this->get_logger(), "QUESTiX LAB shot refused: %s", flow_.labRefusal());
  }
  publishStatus(false);
}

void LauncherArbiterComponent::tickCallback() {
  const bool permitted = permission_->permitted();
  const auto output = flow_.onTick(permitted, nowSec());
  if (output.publish) {
    publish(output);
    RCLCPP_INFO(this->get_logger(), "QUESTiX LAB run ended (%s): roller stopped",
                SourceSelector::reasonName(flow_.selector().reason()));
  }
  publishStatus(permitted != last_permitted_);
}

void LauncherArbiterComponent::publishStatus(bool force) {
  const bool permitted = permission_->permitted();
  if (!force && sent_version_ && *sent_version_ == flow_.version() &&
      permitted == last_permitted_) {
    return;
  }
  sent_version_ = flow_.version();
  last_permitted_ = permitted;
  const auto& selector = flow_.selector();
  const auto& config = flow_.config();
  const double now = nowSec();
  questix_msgs::msg::ArbiterStatus status;
  status.header.stamp = this->now();
  status.mechanism = "launcher";
  status.active_source = SourceSelector::sourceName(selector.source());
  status.switch_reason = SourceSelector::reasonName(selector.reason());
  status.lab_permitted = permitted;
  status.lab_locked = selector.labLocked();
  status.lab_refusal = flow_.labRefusal();
  status.lab_count = selector.labCount();
  status.max_linear = std::numeric_limits<float>::quiet_NaN();
  status.max_angular = std::numeric_limits<float>::quiet_NaN();
  status.max_power = static_cast<float>(config.lab_max_power);
  status.tilt_min_deg = static_cast<float>(config.lab_tilt_min_deg);
  status.tilt_max_deg = static_cast<float>(config.lab_tilt_max_deg);
  status.min_fire_power = static_cast<float>(config.min_fire_power);
  status.spin_up_sec = static_cast<float>(config.spin_up_sec);
  status.fire_interval_sec = static_cast<float>(config.fire_interval_sec);
  status.next_fire_in_sec = static_cast<float>(flow_.nextFireInSec(now));
  status.spin_ready_in_sec = static_cast<float>(flow_.spinReadyInSec(now));
  status_pub_->publish(status);
}

}  // namespace command_arbiter

RCLCPP_COMPONENTS_REGISTER_NODE(command_arbiter::LauncherArbiterComponent)
