// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef COMMAND_ARBITER__LAB_PERMISSION_HPP_
#define COMMAND_ARBITER__LAB_PERMISSION_HPP_

#include <chrono>
#include <cmath>
#include <questix_msgs/msg/actuation_authority.hpp>
#include <rclcpp/rclcpp.hpp>
#include <string>

namespace command_arbiter {

// The teacher's lesson permission (/lab_permission, questix_msgs/ActuationAuthority from Robot
// Manager's heartbeat): whether QUESTiX LAB may drive (drive_allowed) or operate the launcher
// (launcher_allowed). A lease like every permission: never heard, silent for lease_sec or false
// means "not permitted". Reliable + volatile + keep-last(1): never latched.
class LabPermission {
public:
  enum class Flag { kDrive, kLauncher };

  template <class NodeT>
  LabPermission(NodeT& node, const std::string& topic, double lease_sec, Flag flag)
      : lease_sec_(std::isfinite(lease_sec) && lease_sec > 0.0 ? lease_sec : 1.0), flag_(flag) {
    if (!topic.empty()) {
      subscription_ = node.template create_subscription<questix_msgs::msg::ActuationAuthority>(
          topic, rclcpp::QoS(1).reliable().durability_volatile(),
          [this](const questix_msgs::msg::ActuationAuthority::SharedPtr msg) {
            if (msg) {
              receive(flag_ == Flag::kDrive ? msg->drive_allowed : msg->launcher_allowed);
            }
          });
    }
  }

  void receive(bool allowed) {
    known_ = true;
    allowed_ = allowed;
    received_ = std::chrono::steady_clock::now();
  }

  bool permitted() const {
    return known_ && allowed_ &&
           std::chrono::duration<double>(std::chrono::steady_clock::now() - received_).count() <=
               lease_sec_;
  }

private:
  double lease_sec_;
  Flag flag_;
  bool known_{false};
  bool allowed_{false};
  std::chrono::steady_clock::time_point received_{};
  rclcpp::Subscription<questix_msgs::msg::ActuationAuthority>::SharedPtr subscription_;
};

}  // namespace command_arbiter

#endif  // COMMAND_ARBITER__LAB_PERMISSION_HPP_
