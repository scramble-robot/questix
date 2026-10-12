// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#ifndef MOTOR_CONTROL_APP__ACTUATION_GATE_HPP_
#define MOTOR_CONTROL_APP__ACTUATION_GATE_HPP_

#include <cmath>

#include "questix_safety/estop_check.hpp"
#include "questix_safety/permission_check.hpp"

// Whether the drive may actuate at all right now. Two separate concepts, two gates in a fixed
// order (design/safety_permission_input_refactor.md, section 2.1):
//
// 1. the motion permission (L2, /motion_permission, drive_allowed): evaluatePermission. A
//    permission, not an emergency stop: the referee in competition, the teacher in a lesson,
//    always allowed in practice; MotionPermissionManager decides, this node only obeys. Never
//    heard, silent for its lease or a received false close it; only an explicit diagnostic run
//    drops it (PermissionInputs::required).
// 2. the emergency stop (L1, a safety function, /emergency_stop): evaluateEstop. The last gate
//    before the motors: when both are closed its reason wins. With EstopInputs::required (the
//    default) an unheard or silent E-stop counts as pressed; the diagnostic opt-out only stops on
//    a received pressed E-stop.
//
// plus a stop that could not be confirmed. ROS-free and clock-injected (ages in seconds of the
// node's steady clock) so every rule is unit-tested; the rules themselves are questix_safety's.
//
// Separate from the lifecycle: an ACTIVE node keeps polling feedback (passive telemetry, only a
// successfully sent zero frame is ever re-sent) while this gate is closed; it only decides
// whether a /target_twist may arm the drive and whether an armed drive must stop.
namespace motor_control_app::actuation_gate {

// Why actuation is refused. When several apply, the one reported is the strongest: a stop fault,
// then the E-stop (L1, the last gate), then the motion permission (L2).
enum class Block {
  kNone,               // may actuate (a fresh command is still needed)
  kStopFault,          // a safety stop could not be sent: stays closed until a zero succeeds
  kEstopUnknown,       // /emergency_stop never received (only when the E-stop is required)
  kEstopActive,        // E-stop pressed
  kEstopStale,         // /emergency_stop received once, then silent (only when required)
  kPermissionUnknown,  // /motion_permission never received (only when required)
  kPermissionStale,    // /motion_permission silent for longer than its lease (only when required)
  kPermissionOff,      // /motion_permission says the drive may not move (referee, teacher, ...)
};

// The emergency stop (L1) and the motion permission (L2): the inputs and rules are the shared
// questix_safety ones (estop_check.hpp, permission_check.hpp; the node gets them from
// EmergencyStopMonitor and PermissionMonitor).
using EstopInputs = questix_safety::EstopInputs;
using PermissionInputs = questix_safety::PermissionInputs;

struct Inputs {
  PermissionInputs permission;
  EstopInputs estop;
  bool stop_fault{false};
};

using questix_safety::isStale;

// The shared E-stop state as this gate's reason.
inline Block toBlock(questix_safety::EstopState state) {
  switch (state) {
    case questix_safety::EstopState::kReleased:
      return Block::kNone;
    case questix_safety::EstopState::kUnknown:
      return Block::kEstopUnknown;
    case questix_safety::EstopState::kPressed:
      return Block::kEstopActive;
    case questix_safety::EstopState::kStale:
      return Block::kEstopStale;
  }
  return Block::kEstopUnknown;  // fail closed on anything unexpected
}

// The shared permission state as this gate's reason.
inline Block toBlock(questix_safety::PermissionState state) {
  switch (state) {
    case questix_safety::PermissionState::kAllowed:
      return Block::kNone;
    case questix_safety::PermissionState::kUnknown:
      return Block::kPermissionUnknown;
    case questix_safety::PermissionState::kStale:
      return Block::kPermissionStale;
    case questix_safety::PermissionState::kOff:
      return Block::kPermissionOff;
  }
  return Block::kPermissionUnknown;  // fail closed on anything unexpected
}

// The E-stop alone: kNone (released, or not required and not heard), or an E-stop reason.
inline Block evaluateEstop(const EstopInputs& in) {
  return toBlock(questix_safety::evaluateEstop(in));
}

// The motion permission alone: kNone (allowed, or not required), or a permission reason.
inline Block evaluatePermission(const PermissionInputs& in) {
  return toBlock(questix_safety::evaluatePermission(in));
}

// Both gates in their order (L2, then L1), plus the stop fault. Moving needs both open; when both
// are closed the later gate (the E-stop) is the reason.
inline Block evaluate(const Inputs& in) {
  if (in.stop_fault) {
    return Block::kStopFault;
  }
  // Qualified: the questix_safety functions of the same name would also be found (ADL).
  Block block = actuation_gate::evaluatePermission(in.permission);  // L2
  const Block estop = actuation_gate::evaluateEstop(in.estop);      // L1: the last gate wins
  if (estop != Block::kNone) {
    block = estop;
  }
  return block;
}

inline bool isEstopBlock(Block block) {
  return block == Block::kEstopUnknown || block == Block::kEstopActive ||
         block == Block::kEstopStale;
}

inline bool isPermissionBlock(Block block) {
  return block == Block::kPermissionUnknown || block == Block::kPermissionStale ||
         block == Block::kPermissionOff;
}

inline const char* blockName(Block block) {
  switch (block) {
    case Block::kNone:
      return "none";
    case Block::kStopFault:
      return "stop_fault";
    case Block::kEstopUnknown:
      return "estop_unknown";
    case Block::kEstopActive:
      return "estop_active";
    case Block::kEstopStale:
      return "estop_stale";
    case Block::kPermissionUnknown:
      return "permission_unknown";
    case Block::kPermissionStale:
      return "permission_stale";
    case Block::kPermissionOff:
      return "permission_off";
  }
  return "unknown";
}

// What the control tick does about the gate.
enum class GateAction {
  kNone,        // open and stays open, or closed and nothing is armed any more
  kSafetyStop,  // just closed (or closed with a command still armed): stop now, disarm
};

// A closed gate always disarms; the stop is sent on the edge into "closed", and again whenever
// something is still armed (a command that raced the edge). Reopening never re-arms by itself:
// the drive stays stopped until the next /target_twist that arrives while open.
inline GateAction decideGateAction(Block previous, Block now, bool has_target) {
  if (now == Block::kNone) {
    return GateAction::kNone;
  }
  if (previous == Block::kNone || has_target) {
    return GateAction::kSafetyStop;
  }
  return GateAction::kNone;
}

// Whether a stop that could not be sent may be retried now (bounded rate).
inline bool shouldRetryStop(bool stop_fault, double since_last_retry_sec, double retry_period_sec) {
  return stop_fault && std::isfinite(since_last_retry_sec) &&
         since_last_retry_sec >= (retry_period_sec > 0.0 ? retry_period_sec : 0.5);
}

}  // namespace motor_control_app::actuation_gate

#endif  // MOTOR_CONTROL_APP__ACTUATION_GATE_HPP_
