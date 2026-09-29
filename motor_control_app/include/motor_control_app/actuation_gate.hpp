// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#ifndef MOTOR_CONTROL_APP__ACTUATION_GATE_HPP_
#define MOTOR_CONTROL_APP__ACTUATION_GATE_HPP_

#include <cmath>

// Whether the drive may actuate at all right now: the E-stop state and the teacher's runtime
// authority (practice), both fail-closed, plus a stop that could not be confirmed. ROS-free and
// clock-injected (ages in seconds of the node's steady clock) so every rule is unit-tested.
//
// Separate from the lifecycle: an ACTIVE node keeps polling feedback (passive telemetry, only a
// successfully sent zero frame is ever re-sent) while this gate is closed; it only decides
// whether a /target_twist may arm the drive and whether an armed drive must stop.
namespace motor_control_app::actuation_gate {

// Why actuation is refused, in the order they are checked (the first applies).
enum class Block {
  kNone,              // may actuate (a fresh command is still needed)
  kStopFault,         // a safety stop could not be sent: stays closed until a zero succeeds
  kEstopUnknown,      // /emergency_stop never received
  kEstopActive,       // E-stop pressed
  kEstopStale,        // /emergency_stop received once, then silent for longer than its timeout
  kAuthorityUnknown,  // no runtime authority heartbeat received
  kAuthorityOff,      // the teacher's authority says drive off
  kAuthorityStale,    // heartbeat silent for longer than its lease
};

struct Inputs {
  // /emergency_stop (questix_msgs/EmergencyStop). require_estop=false only for an explicit
  // diagnostic opt-out; the integrated launches never set it.
  bool require_estop{true};
  bool estop_known{false};
  bool estop_active{true};
  double estop_age_sec{0.0};
  double estop_timeout_sec{1.0};  // <= 0 or non-finite: no staleness check
  // The teacher's runtime authority (questix_msgs/ActuationAuthority, practice only).
  bool require_authority{true};
  bool authority_known{false};
  bool authority_allowed{false};
  double authority_age_sec{0.0};
  double authority_timeout_sec{1.0};  // <= 0 or non-finite: treated as 1.0 (a lease must expire)
  bool stop_fault{false};
};

inline constexpr double kDefaultLeaseSec = 1.0;

// A signal received once is stale when it has been silent for longer than timeout_sec.
// timeout_sec <= 0 or non-finite disables the check (E-stop only; see authorityLease).
inline bool isStale(double age_sec, double timeout_sec) {
  return std::isfinite(timeout_sec) && timeout_sec > 0.0 && !(age_sec <= timeout_sec);
}

// The authority is a lease: it always expires. An invalid timeout falls back to the default.
inline double authorityLease(double timeout_sec) {
  return std::isfinite(timeout_sec) && timeout_sec > 0.0 ? timeout_sec : kDefaultLeaseSec;
}

inline Block evaluate(const Inputs& in) {
  if (in.stop_fault) {
    return Block::kStopFault;
  }
  if (in.require_estop) {
    if (!in.estop_known) {
      return Block::kEstopUnknown;
    }
    if (in.estop_active) {
      return Block::kEstopActive;
    }
    if (isStale(in.estop_age_sec, in.estop_timeout_sec)) {
      return Block::kEstopStale;
    }
  } else if (in.estop_known && in.estop_active) {
    return Block::kEstopActive;  // opted out of requiring it, but a pressed E-stop still stops
  }
  if (in.require_authority) {
    if (!in.authority_known) {
      return Block::kAuthorityUnknown;
    }
    // A lease: silence always closes it, even when the last heartbeat said "allowed".
    if (!(in.authority_age_sec <= authorityLease(in.authority_timeout_sec))) {
      return Block::kAuthorityStale;
    }
    if (!in.authority_allowed) {
      return Block::kAuthorityOff;
    }
  }
  return Block::kNone;
}

inline bool isEstopBlock(Block block) {
  return block == Block::kEstopUnknown || block == Block::kEstopActive ||
         block == Block::kEstopStale;
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
    case Block::kAuthorityUnknown:
      return "authority_unknown";
    case Block::kAuthorityOff:
      return "authority_off";
    case Block::kAuthorityStale:
      return "authority_stale";
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
