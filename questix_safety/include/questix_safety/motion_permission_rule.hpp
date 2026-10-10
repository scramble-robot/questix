// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#ifndef QUESTIX_SAFETY__MOTION_PERMISSION_RULE_HPP_
#define QUESTIX_SAFETY__MOTION_PERMISSION_RULE_HPP_

#include <map>
#include <string>
#include <vector>

#include "questix_safety/permission_check.hpp"

// How MotionPermissionManager (operation_manager) combines votes into /motion_permission (L2).
// ROS-free and clock-injected (ages in seconds of the manager's steady clock).
//
// A vote is a questix_msgs/ActuationAuthority on its own topic (the teacher's
// /actuation_authority from Robot Manager, the referee's /motion_vote/referee from RefereeMonitor,
// ...). The running mode lists the votes it needs; the manager knows nothing else about them. For
// each required vote: never heard -> "<name>:unknown", silent for longer than the lease ->
// "<name>:stale" (both flags), a received false -> "<name>:off" (that flag). A flag is allowed
// only when no required vote blocks it; a mode that needs no vote is always allowed.
namespace questix_safety {

struct Vote {
  bool known{false};  // at least one message was received
  bool drive_allowed{false};
  bool launcher_allowed{false};
  double age_sec{0.0};  // since the last message, on the manager's steady clock
};

struct MotionPermissionDecision {
  bool drive_allowed{false};
  bool launcher_allowed{false};
  std::vector<std::string> drive_blockers;
  std::vector<std::string> launcher_blockers;
};

inline MotionPermissionDecision decideMotionPermission(const std::vector<std::string>& required,
                                                       const std::map<std::string, Vote>& votes,
                                                       double lease_sec) {
  MotionPermissionDecision decision;
  const double lease = permissionLease(lease_sec);
  for (const auto& name : required) {
    const auto it = votes.find(name);
    const Vote vote = it == votes.end() ? Vote{} : it->second;
    if (!vote.known) {
      decision.drive_blockers.push_back(name + ":unknown");
      decision.launcher_blockers.push_back(name + ":unknown");
      continue;
    }
    if (!(vote.age_sec <= lease)) {
      decision.drive_blockers.push_back(name + ":stale");
      decision.launcher_blockers.push_back(name + ":stale");
      continue;
    }
    if (!vote.drive_allowed) {
      decision.drive_blockers.push_back(name + ":off");
    }
    if (!vote.launcher_allowed) {
      decision.launcher_blockers.push_back(name + ":off");
    }
  }
  decision.drive_allowed = decision.drive_blockers.empty();
  decision.launcher_allowed = decision.launcher_blockers.empty();
  return decision;
}

}  // namespace questix_safety

#endif  // QUESTIX_SAFETY__MOTION_PERMISSION_RULE_HPP_
