// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#pragma once

#include "questix_safety/estop_check.hpp"
#include "questix_safety/permission_check.hpp"

namespace esc_motor_control_cpp {

// Whether the roller may spin at all right now (ROS-free, clock-injected: ages in seconds of
// the node's steady clock). Two separate concepts, two gates in a fixed order
// (design/safety_permission_input_refactor.md, section 2.1), as for the drive and the shot:
// 1. the motion permission (L2, /motion_permission launcher_allowed; not an emergency stop: the
//    referee in competition, the teacher in a lesson, always allowed in practice), then
// 2. the emergency stop (L1, a safety function, the last gate: its reason wins when both are
//    closed; with RollerEstopInputs::required, false only for an explicit diagnostic opt-out,
//    unknown and silent count as pressed).
// The rules are the shared questix_safety ones (estop_check.hpp, permission_check.hpp); the
// reasons match motor_control_app/actuation_gate.hpp (the two packages do not depend on each
// other, so keep the names and their tests in step).
enum class RollerBlock {
  kNone,               // may spin (a fresh press or lab command is still needed)
  kEstopUnknown,       // /emergency_stop never received (only when required)
  kEstopActive,        // E-stop pressed
  kEstopStale,         // /emergency_stop received once, then silent (only when required)
  kPermissionUnknown,  // /motion_permission never received (only when required)
  kPermissionStale,    // /motion_permission silent for longer than its lease (only when required)
  kPermissionOff,      // /motion_permission says the launcher may not move
  kPwmFault,           // backend fault latched until node restart
};

using RollerEstopInputs = questix_safety::EstopInputs;
using RollerPermissionInputs = questix_safety::PermissionInputs;

struct RollerGateInputs {
  RollerPermissionInputs permission;
  RollerEstopInputs estop;
  bool pwm_fault{false};
};

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

// The shared permission state as this gate's reason.
inline RollerBlock toRollerBlock(questix_safety::PermissionState state) {
  switch (state) {
    case questix_safety::PermissionState::kAllowed:
      return RollerBlock::kNone;
    case questix_safety::PermissionState::kUnknown:
      return RollerBlock::kPermissionUnknown;
    case questix_safety::PermissionState::kStale:
      return RollerBlock::kPermissionStale;
    case questix_safety::PermissionState::kOff:
      return RollerBlock::kPermissionOff;
  }
  return RollerBlock::kPermissionUnknown;  // fail closed on anything unexpected
}

// The E-stop alone: kNone (released, or not required and not heard), or an E-stop reason.
inline RollerBlock evaluateRollerEstop(const RollerEstopInputs& in) {
  return toRollerBlock(questix_safety::evaluateEstop(in));
}

// The motion permission alone: kNone (allowed, or not required), or a permission reason.
inline RollerBlock evaluateRollerPermission(const RollerPermissionInputs& in) {
  return toRollerBlock(questix_safety::evaluatePermission(in));
}

// Both gates in their order (L2, then L1): spinning needs both open; when both are closed the
// later gate (the E-stop) is the reason.
inline RollerBlock evaluateRollerGate(const RollerGateInputs& in) {
  RollerBlock block = evaluateRollerPermission(in.permission);  // L2
  const RollerBlock estop = evaluateRollerEstop(in.estop);      // L1: the last gate wins
  if (estop != RollerBlock::kNone) {
    block = estop;
  }
  if (block == RollerBlock::kNone && in.pwm_fault) {
    block = RollerBlock::kPwmFault;
  }
  return block;
}

inline bool isRollerEstopBlock(RollerBlock block) {
  return block == RollerBlock::kEstopUnknown || block == RollerBlock::kEstopActive ||
         block == RollerBlock::kEstopStale;
}

inline bool isRollerPermissionBlock(RollerBlock block) {
  return block == RollerBlock::kPermissionUnknown || block == RollerBlock::kPermissionStale ||
         block == RollerBlock::kPermissionOff;
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
    case RollerBlock::kPermissionUnknown:
      return "permission_unknown";
    case RollerBlock::kPermissionStale:
      return "permission_stale";
    case RollerBlock::kPermissionOff:
      return "permission_off";
    case RollerBlock::kPwmFault:
      return "pwm_fault";
  }
  return "unknown";
}

}  // namespace esc_motor_control_cpp
