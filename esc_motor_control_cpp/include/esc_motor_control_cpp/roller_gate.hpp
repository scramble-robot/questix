// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#pragma once

#include <cmath>

#include "questix_safety/estop_check.hpp"

namespace esc_motor_control_cpp {

// Whether the roller may spin at all right now (ROS-free, clock-injected: ages in seconds of
// the node's steady clock). Two separate concepts are judged separately and only then combined:
// the emergency stop (a safety function; with RollerEstopInputs::required, false only for an
// explicit diagnostic opt-out, unknown and silent count as pressed) and the teacher's permission
// (/actuation_authority; not an emergency stop; a practice opt-in, never looked at when not
// required). The E-stop rule is the shared questix_safety one (estop_check.hpp), as for the drive
// and the shot; the teacher permission rules match motor_control_app/actuation_gate.hpp (the two
// packages do not depend on each other, so keep those and their tests in step).
enum class RollerBlock {
  kNone,                      // may spin (a fresh press or lab command is still needed)
  kEstopUnknown,              // /emergency_stop never received (only when required)
  kEstopActive,               // E-stop pressed
  kEstopStale,                // /emergency_stop received once, then silent (only when required)
  kTeacherPermissionUnknown,  // no teacher permission heartbeat received (only when opted in)
  kTeacherPermissionOff,      // the teacher's permission says launcher off (only when opted in)
  kTeacherPermissionStale,    // heartbeat silent for longer than its lease (only when opted in)
};

using RollerEstopInputs = questix_safety::EstopInputs;

struct RollerTeacherPermissionInputs {
  bool required{false};  // practice opt-in (require_teacher_permission)
  bool known{false};
  bool allowed{false};
  double age_sec{0.0};
  double timeout_sec{1.0};  // <= 0 or non-finite: treated as 1.0 (a lease expires)
};

struct RollerGateInputs {
  RollerEstopInputs estop;
  RollerTeacherPermissionInputs teacher_permission;
};

inline double rollerTeacherPermissionLease(double timeout_sec) {
  return std::isfinite(timeout_sec) && timeout_sec > 0.0 ? timeout_sec : 1.0;
}

// The shared E-stop state as this gate's reason.
inline RollerBlock toRollerBlock(questix_safety::EstopState state) {
  switch (state) {
    case questix_safety::EstopState::kReleased:
      return RollerBlock::kNone;
    case questix_safety::EstopState::kUnknown:
      return RollerBlock::kEstopUnknown;
    case questix_safety::EstopState::kPressed:
      return RollerBlock::kEstopActive;
    case questix_safety::EstopState::kStale:
      return RollerBlock::kEstopStale;
  }
  return RollerBlock::kEstopUnknown;  // fail closed on anything unexpected
}

// The E-stop alone: kNone (released, or not required and not heard), or an E-stop reason.
inline RollerBlock evaluateRollerEstop(const RollerEstopInputs& in) {
  return toRollerBlock(questix_safety::evaluateEstop(in));
}

// The teacher's permission alone. Not required means disabled: nothing else is looked at.
inline RollerBlock evaluateRollerTeacherPermission(const RollerTeacherPermissionInputs& in) {
  if (!in.required) {
    return RollerBlock::kNone;
  }
  if (!in.known) {
    return RollerBlock::kTeacherPermissionUnknown;
  }
  if (!(in.age_sec <= rollerTeacherPermissionLease(in.timeout_sec))) {
    return RollerBlock::kTeacherPermissionStale;
  }
  if (!in.allowed) {
    return RollerBlock::kTeacherPermissionOff;
  }
  return RollerBlock::kNone;
}

inline RollerBlock evaluateRollerGate(const RollerGateInputs& in) {
  const RollerBlock estop = evaluateRollerEstop(in.estop);
  if (estop != RollerBlock::kNone) {
    return estop;
  }
  return evaluateRollerTeacherPermission(in.teacher_permission);
}

inline bool isRollerEstopBlock(RollerBlock block) {
  return block == RollerBlock::kEstopUnknown || block == RollerBlock::kEstopActive ||
         block == RollerBlock::kEstopStale;
}

inline bool isRollerTeacherPermissionBlock(RollerBlock block) {
  return block == RollerBlock::kTeacherPermissionUnknown ||
         block == RollerBlock::kTeacherPermissionOff ||
         block == RollerBlock::kTeacherPermissionStale;
}

inline const char* rollerBlockName(RollerBlock block) {
  switch (block) {
    case RollerBlock::kNone:
      return "none";
    case RollerBlock::kEstopUnknown:
      return "estop_unknown";
    case RollerBlock::kEstopActive:
      return "estop_active";
    case RollerBlock::kEstopStale:
      return "estop_stale";
    case RollerBlock::kTeacherPermissionUnknown:
      return "teacher_permission_unknown";
    case RollerBlock::kTeacherPermissionOff:
      return "teacher_permission_off";
    case RollerBlock::kTeacherPermissionStale:
      return "teacher_permission_stale";
  }
  return "unknown";
}

}  // namespace esc_motor_control_cpp
