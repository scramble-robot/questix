// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#ifndef MOTOR_CONTROL_APP__ACTUATION_GATE_HPP_
#define MOTOR_CONTROL_APP__ACTUATION_GATE_HPP_

#include <cmath>

#include "questix_safety/estop_check.hpp"

// Whether the drive may actuate at all right now. Two separate concepts are judged separately
// and only then combined:
//
// * the emergency stop (a safety function, /emergency_stop): evaluateEstop. With
//   EstopInputs::required (the default; operation_manager always publishes it in questix_core,
//   also without the GPIO safety path) an unheard or silent E-stop counts as pressed; the
//   diagnostic opt-out only stops on a received pressed E-stop.
// * the teacher's permission (a permission, not an emergency stop, /actuation_authority):
//   evaluateTeacherPermission. It is a practice opt-in; when not required it is never looked at and
//   always allows.
//
// plus a stop that could not be confirmed. ROS-free and clock-injected (ages in seconds of the
// node's steady clock) so every rule is unit-tested.
//
// Separate from the lifecycle: an ACTIVE node keeps polling feedback (passive telemetry, only a
// successfully sent zero frame is ever re-sent) while this gate is closed; it only decides
// whether a /target_twist may arm the drive and whether an armed drive must stop.
namespace motor_control_app::actuation_gate {

// Why actuation is refused, in the order they are checked (the first applies).
enum class Block {
  kNone,                      // may actuate (a fresh command is still needed)
  kStopFault,                 // a safety stop could not be sent: stays closed until a zero succeeds
  kEstopUnknown,              // /emergency_stop never received (only when the E-stop is required)
  kEstopActive,               // E-stop pressed
  kEstopStale,                // /emergency_stop received once, then silent (only when required)
  kTeacherPermissionUnknown,  // no teacher permission heartbeat received (only when opted in)
  kTeacherPermissionOff,      // the teacher's permission says drive off (only when opted in)
  kTeacherPermissionStale,    // heartbeat silent for longer than its lease (only when opted in)
};

// The emergency stop: /emergency_stop (questix_msgs/EmergencyStop). The rule and its inputs are
// the shared questix_safety one (estop_check.hpp; the node gets them from EmergencyStopMonitor).
using EstopInputs = questix_safety::EstopInputs;

// The teacher's permission: questix_msgs/ActuationAuthority (one flag of it). A
// permission, not an emergency stop; the default is "not required" (practice opt-in).
struct TeacherPermissionInputs {
  bool required{false};
  bool known{false};
  bool allowed{false};
  double age_sec{0.0};
  double timeout_sec{1.0};  // <= 0 or non-finite: treated as 1.0 (a lease must expire)
};

struct Inputs {
  EstopInputs estop;
  TeacherPermissionInputs teacher_permission;
  bool stop_fault{false};
};

inline constexpr double kDefaultLeaseSec = 1.0;

using questix_safety::isStale;

// The teacher permission is a lease: it always expires. An invalid timeout falls back to the
// default.
inline double teacherPermissionLease(double timeout_sec) {
  return std::isfinite(timeout_sec) && timeout_sec > 0.0 ? timeout_sec : kDefaultLeaseSec;
}

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

// The E-stop alone: kNone (released, or not required and not heard), or an E-stop reason.
inline Block evaluateEstop(const EstopInputs& in) {
  return toBlock(questix_safety::evaluateEstop(in));
}

// The teacher's permission alone: kNone (allowed, or not required), or a teacher permission reason.
// Not required means disabled: none of the other fields is looked at.
inline Block evaluateTeacherPermission(const TeacherPermissionInputs& in) {
  if (!in.required) {
    return Block::kNone;
  }
  if (!in.known) {
    return Block::kTeacherPermissionUnknown;
  }
  // A lease: silence always closes it, even when the last heartbeat said "allowed".
  if (!(in.age_sec <= teacherPermissionLease(in.timeout_sec))) {
    return Block::kTeacherPermissionStale;
  }
  if (!in.allowed) {
    return Block::kTeacherPermissionOff;
  }
  return Block::kNone;
}

// Both, plus the stop fault: the first reason in Block order.
inline Block evaluate(const Inputs& in) {
  if (in.stop_fault) {
    return Block::kStopFault;
  }
  const Block estop = toBlock(questix_safety::evaluateEstop(in.estop));
  if (estop != Block::kNone) {
    return estop;
  }
  return evaluateTeacherPermission(in.teacher_permission);
}

inline bool isEstopBlock(Block block) {
  return block == Block::kEstopUnknown || block == Block::kEstopActive ||
         block == Block::kEstopStale;
}

inline bool isTeacherPermissionBlock(Block block) {
  return block == Block::kTeacherPermissionUnknown || block == Block::kTeacherPermissionOff ||
         block == Block::kTeacherPermissionStale;
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
    case Block::kTeacherPermissionUnknown:
      return "teacher_permission_unknown";
    case Block::kTeacherPermissionOff:
      return "teacher_permission_off";
    case Block::kTeacherPermissionStale:
      return "teacher_permission_stale";
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
