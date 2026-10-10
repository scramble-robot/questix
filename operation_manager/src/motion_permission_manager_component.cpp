// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#include "operation_manager/motion_permission_manager_component.hpp"

#include <algorithm>  // NOLINT(build/include_order)
#include <cmath>      // NOLINT(build/include_order)
#include <rclcpp_components/register_node_macro.hpp>
#include <set>        // NOLINT(build/include_order)
#include <stdexcept>  // NOLINT(build/include_order)

namespace {

std::string join(const std::vector<std::string>& items) {
  std::string text;
  for (const auto& item : items) {
    text += (text.empty() ? "" : ", ") + item;
  }
  return text.empty() ? "none" : text;
}

bool sameDecision(const questix_safety::MotionPermissionDecision& a,
                  const questix_safety::MotionPermissionDecision& b) {
  return a.drive_allowed == b.drive_allowed && a.launcher_allowed == b.launcher_allowed &&
         a.drive_blockers == b.drive_blockers && a.launcher_blockers == b.launcher_blockers;
}

// The vote names and required lists are nested YAML maps (votes.<name>, required.<mode>), read
// from the overrides: the names are the YAML's, not the code's.
rclcpp::NodeOptions withOverridesDeclared(rclcpp::NodeOptions options) {
  options.automatically_declare_parameters_from_overrides(true);
  return options;
}

}  // namespace

namespace operation_manager {

MotionPermissionManagerComponent::MotionPermissionManagerComponent(
    const rclcpp::NodeOptions& options)
    : Node("motion_permission_manager", withOverridesDeclared(options)) {
  const auto declare = [this](const std::string& name, const rclcpp::ParameterValue& value) {
    if (!this->has_parameter(name)) {
      this->declare_parameter(name, value);
    }
    return this->get_parameter(name);
  };
  mode_ = declare("mode", rclcpp::ParameterValue(std::string(""))).as_string();
  const auto modes =
      declare("modes",
              rclcpp::ParameterValue(std::vector<std::string>{"lesson", "practice", "competition"}))
          .as_string_array();
  lease_sec_ = declare("lease_sec", rclcpp::ParameterValue(1.0)).as_double();
  const double rate_hz = declare("publish_rate_hz", rclcpp::ParameterValue(20.0)).as_double();
  const auto topic =
      declare("topic", rclcpp::ParameterValue(std::string("/motion_permission"))).as_string();

  if (std::find(modes.begin(), modes.end(), mode_) == modes.end()) {
    RCLCPP_FATAL(this->get_logger(),
                 "Unknown mode '%s' (known: %s): refusing to start, an unknown mode is never "
                 "allowed to move",
                 mode_.c_str(), join(modes).c_str());
    throw std::invalid_argument("motion_permission_manager: unknown mode '" + mode_ + "'");
  }
  if (!std::isfinite(lease_sec_) || lease_sec_ <= 0.0) {
    RCLCPP_WARN(this->get_logger(), "Invalid lease_sec=%g; using 1.0 s", lease_sec_);
    lease_sec_ = 1.0;
  }

  const std::string required_name = "required." + mode_;
  if (this->has_parameter(required_name)) {
    required_ = this->get_parameter(required_name).as_string_array();
  }
  std::set<std::string> seen;
  for (const auto& name : required_) {
    if (!seen.insert(name).second) {
      throw std::invalid_argument("motion_permission_manager: vote '" + name +
                                  "' is required twice in " + required_name);
    }
    const std::string vote_name = "votes." + name;
    if (!this->has_parameter(vote_name) ||
        this->get_parameter(vote_name).get_type() != rclcpp::ParameterType::PARAMETER_STRING ||
        this->get_parameter(vote_name).as_string().empty()) {
      RCLCPP_FATAL(this->get_logger(), "Mode '%s' requires the vote '%s', but %s lists no topic",
                   mode_.c_str(), name.c_str(), vote_name.c_str());
      throw std::invalid_argument("motion_permission_manager: no topic for vote '" + name + "'");
    }
    const auto vote_topic = this->get_parameter(vote_name).as_string();
    votes_[name] = VoteState{};
    // The vote contract (/actuation_authority): reliable + volatile, never latched.
    vote_subs_.push_back(this->create_subscription<questix_msgs::msg::ActuationAuthority>(
        vote_topic, rclcpp::QoS(1).reliable().durability_volatile(),
        [this, name](const questix_msgs::msg::ActuationAuthority::SharedPtr msg) {
          if (msg) {
            voteCallback(name, *msg);
          }
        }));
    RCLCPP_INFO(this->get_logger(), "Vote '%s' on %s", name.c_str(), vote_topic.c_str());
  }

  publisher_ = this->create_publisher<questix_msgs::msg::MotionPermission>(topic, qos());
  const double period = 1.0 / std::clamp(std::isfinite(rate_hz) ? rate_hz : 20.0, 1.0, 100.0);
  timer_ = this->create_wall_timer(
      std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::duration<double>(period)),
      [this]() { decideAndPublish(true); });
  RCLCPP_INFO(this->get_logger(), "Motion permission on %s: mode '%s' needs %s (lease %.2fs)",
              topic.c_str(), mode_.c_str(), required_.empty() ? "no vote" : join(required_).c_str(),
              lease_sec_);
  decideAndPublish(true);
}

void MotionPermissionManagerComponent::voteCallback(
    const std::string& name, const questix_msgs::msg::ActuationAuthority& msg) {
  auto& vote = votes_[name];
  vote.known = true;
  vote.drive_allowed = msg.drive_allowed;
  vote.launcher_allowed = msg.launcher_allowed;
  vote.received = std::chrono::steady_clock::now();
  decideAndPublish(false);  // a change goes out at once, not at the next tick
}

void MotionPermissionManagerComponent::decideAndPublish(bool force) {
  const auto now = std::chrono::steady_clock::now();
  std::map<std::string, questix_safety::Vote> votes;
  for (const auto& [name, state] : votes_) {
    questix_safety::Vote vote;
    vote.known = state.known;
    vote.drive_allowed = state.drive_allowed;
    vote.launcher_allowed = state.launcher_allowed;
    vote.age_sec = state.known ? std::chrono::duration<double>(now - state.received).count() : 0.0;
    votes[name] = vote;
  }
  const auto decision = questix_safety::decideMotionPermission(required_, votes, lease_sec_);
  const bool changed = !last_ || !sameDecision(*last_, decision);
  if (!force && !changed) {
    return;
  }
  if (changed) {
    if (decision.drive_allowed && decision.launcher_allowed) {
      RCLCPP_INFO(this->get_logger(), "Motion allowed (%s)", mode_.c_str());
    } else {
      RCLCPP_WARN(this->get_logger(), "Motion permission (%s): drive %s [%s], launcher %s [%s]",
                  mode_.c_str(), decision.drive_allowed ? "allowed" : "not allowed",
                  join(decision.drive_blockers).c_str(),
                  decision.launcher_allowed ? "allowed" : "not allowed",
                  join(decision.launcher_blockers).c_str());
    }
  }
  last_ = decision;
  questix_msgs::msg::MotionPermission msg;
  msg.header.stamp = this->now();
  msg.drive_allowed = decision.drive_allowed;
  msg.launcher_allowed = decision.launcher_allowed;
  msg.mode = mode_;
  msg.drive_blockers = decision.drive_blockers;
  msg.launcher_blockers = decision.launcher_blockers;
  publisher_->publish(msg);
}

}  // namespace operation_manager

RCLCPP_COMPONENTS_REGISTER_NODE(operation_manager::MotionPermissionManagerComponent)
