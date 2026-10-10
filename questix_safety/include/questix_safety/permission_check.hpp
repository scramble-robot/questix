// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#ifndef QUESTIX_SAFETY__PERMISSION_CHECK_HPP_
#define QUESTIX_SAFETY__PERMISSION_CHECK_HPP_

#include <cmath>

// The /motion_permission rule every actuating node follows (L2, the motion permission), ROS-free
// and clock-injected (ages in seconds of the node's own steady clock) so that it is unit-tested
// once. The ROS side (subscription, QoS, parameters) is permission_monitor.hpp.
//
// The rule: a permission is a lease. Never heard, silent for longer than its timeout, or a
// received "not allowed" all mean "do not move". Only an explicit diagnostic run may drop the
// whole check (required=false).
//
// A permission is not an emergency stop: /emergency_stop (estop_check.hpp, L1) is judged
// separately and wins when both block.
namespace questix_safety {

enum class PermissionState {
  kAllowed,  // heard, fresh and allowed (or not required)
  kUnknown,  // never heard (required)
  kStale,    // heard once, then silent for longer than the lease (required)
  kOff,      // the last message said not allowed (required)
};

struct PermissionInputs {
  bool required{true};      // false only for an explicit diagnostic opt-out
  bool known{false};        // at least one message was received
  bool allowed{false};      // the last message's flag (drive_allowed or launcher_allowed)
  double age_sec{0.0};      // since the last message, on the node's steady clock
  double timeout_sec{0.5};  // the lease; <= 0 or non-finite falls back to the default
};

inline constexpr double kDefaultPermissionTimeoutSec = 0.5;

// A permission always expires: an invalid or non-positive lease falls back to the default.
inline double permissionLease(double timeout_sec) {
  return std::isfinite(timeout_sec) && timeout_sec > 0.0 ? timeout_sec
                                                         : kDefaultPermissionTimeoutSec;
}

inline PermissionState evaluatePermission(const PermissionInputs& in) {
  if (!in.required) {
    return PermissionState::kAllowed;  // disabled: nothing else is looked at
  }
  if (!in.known) {
    return PermissionState::kUnknown;
  }
  // A lease: silence always closes it, even when the last message said "allowed". An unknown
  // (NaN) age is never fresh.
  if (!(in.age_sec <= permissionLease(in.timeout_sec))) {
    return PermissionState::kStale;
  }
  if (!in.allowed) {
    return PermissionState::kOff;
  }
  return PermissionState::kAllowed;
}

// Whether the state means "do not move".
inline bool blocks(PermissionState state) { return state != PermissionState::kAllowed; }

inline const char* permissionStateName(PermissionState state) {
  switch (state) {
    case PermissionState::kAllowed:
      return "allowed";
    case PermissionState::kUnknown:
      return "permission_unknown";
    case PermissionState::kStale:
      return "permission_stale";
    case PermissionState::kOff:
      return "permission_off";
  }
  return "permission_unknown";
}

}  // namespace questix_safety

#endif  // QUESTIX_SAFETY__PERMISSION_CHECK_HPP_
