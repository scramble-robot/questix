// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#ifndef OPERATION_MANAGER__MOTION_PERMISSION_MANAGER_COMPONENT_HPP_
#define OPERATION_MANAGER__MOTION_PERMISSION_MANAGER_COMPONENT_HPP_

#include <chrono>
#include <map>
#include <optional>
#include <questix_msgs/msg/actuation_authority.hpp>
#include <questix_msgs/msg/motion_permission.hpp>
#include <questix_safety/motion_permission_rule.hpp>
#include <rclcpp/rclcpp.hpp>
#include <string>  // NOLINT(build/include_order)
#include <vector>  // NOLINT(build/include_order)

namespace operation_manager {

// The motion permission (L2): combines the votes the running mode needs into /motion_permission
// (questix_msgs/MotionPermission, reliable + volatile + keep-last(1), 20 Hz and at once on a
// change). It knows no GPIO, no teacher and no referee: only votes, each a
// questix_msgs/ActuationAuthority on its own topic, listed in the YAML
// (config/operation_manager.permission.yaml):
//
//   votes:     {<name>: <topic>, ...}        e.g. referee: /motion_vote/referee
//   modes:     [lesson, practice, competition]  the modes this robot knows
//   required:  {<mode>: [<name>, ...], ...}  a mode left out needs no vote (always allowed)
//   mode:      the running mode (questix_core passes its robot_mode)
//
// A new condition is a node that publishes a vote and one line in that YAML. The rule is
// questix_safety/motion_permission_rule.hpp (ROS-free, unit-tested there). An unknown mode, or a
// required vote that is not listed, refuses to start: an unknown mode never means "allowed".
class MotionPermissionManagerComponent : public rclcpp::Node {
public:
  explicit MotionPermissionManagerComponent(const rclcpp::NodeOptions& options);

  // Never transient_local: a permission must not be latched (questix_msgs/README.md).
  static rclcpp::QoS qos() { return rclcpp::QoS(1).reliable().durability_volatile(); }

  const std::string& mode() const { return mode_; }
  const std::vector<std::string>& required() const { return required_; }

private:
  struct VoteState {
    bool known{false};
    bool drive_allowed{false};
    bool launcher_allowed{false};
    std::chrono::steady_clock::time_point received{};
  };

  void voteCallback(const std::string& name, const questix_msgs::msg::ActuationAuthority& msg);
  // Decides now; publishes when forced (the periodic tick) or when the decision changed.
  void decideAndPublish(bool force);

  std::string mode_;
  double lease_sec_{1.0};
  std::vector<std::string> required_;
  std::map<std::string, VoteState> votes_;
  std::vector<rclcpp::Subscription<questix_msgs::msg::ActuationAuthority>::SharedPtr> vote_subs_;
  rclcpp::Publisher<questix_msgs::msg::MotionPermission>::SharedPtr publisher_;
  rclcpp::TimerBase::SharedPtr timer_;
  std::optional<questix_safety::MotionPermissionDecision> last_;
};

}  // namespace operation_manager

#endif  // OPERATION_MANAGER__MOTION_PERMISSION_MANAGER_COMPONENT_HPP_
