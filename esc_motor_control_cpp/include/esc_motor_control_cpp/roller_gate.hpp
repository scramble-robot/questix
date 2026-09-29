// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#pragma once

#include <cmath>

namespace esc_motor_control_cpp {

// Whether the roller may spin at all right now (ROS-free, clock-injected: ages in seconds of
// the node's steady clock). The E-stop and the teacher's runtime authority are both fail-closed.
// The rules are the same as motor_control_app/actuation_gate.hpp (drive and shot); the two
// packages do not depend on each other, so keep both headers and their tests in step.
enum class RollerBlock {
  kNone,              // may spin (a fresh press or lab command is still needed)
  kEstopUnknown,      // /emergency_stop never received (require_emergency_stop)
  kEstopActive,       // E-stop pressed
  kEstopStale,        // /emergency_stop received once, then silent for longer than its timeout
  kAuthorityUnknown,  // no runtime authority heartbeat received (practice)
  kAuthorityOff,      // the teacher's authority says launcher off
  kAuthorityStale,    // heartbeat silent for longer than its lease
};

struct RollerGateInputs {
  bool require_estop{true};  // false only for an explicit diagnostic opt-out
  bool estop_known{false};
  bool estop_active{true};
  double estop_age_sec{0.0};
  double estop_timeout_sec{1.0};  // <= 0 or non-finite: no staleness check
  bool require_authority{true};   // practice true, competition false
  bool authority_known{false};
  bool authority_allowed{false};
  double authority_age_sec{0.0};
  double authority_timeout_sec{1.0};  // <= 0 or non-finite: treated as 1.0 (a lease expires)
};

inline bool rollerSignalStale(double age_sec, double timeout_sec) {
  return std::isfinite(timeout_sec) && timeout_sec > 0.0 && !(age_sec <= timeout_sec);
}

inline double rollerAuthorityLease(double timeout_sec) {
  return std::isfinite(timeout_sec) && timeout_sec > 0.0 ? timeout_sec : 1.0;
}

inline RollerBlock evaluateRollerGate(const RollerGateInputs& in) {
  if (in.require_estop) {
    if (!in.estop_known) {
      return RollerBlock::kEstopUnknown;
    }
    if (in.estop_active) {
      return RollerBlock::kEstopActive;
    }
    if (rollerSignalStale(in.estop_age_sec, in.estop_timeout_sec)) {
      return RollerBlock::kEstopStale;
    }
  } else if (in.estop_known && in.estop_active) {
    return RollerBlock::kEstopActive;
  }
  if (in.require_authority) {
    if (!in.authority_known) {
      return RollerBlock::kAuthorityUnknown;
    }
    if (!(in.authority_age_sec <= rollerAuthorityLease(in.authority_timeout_sec))) {
      return RollerBlock::kAuthorityStale;
    }
    if (!in.authority_allowed) {
      return RollerBlock::kAuthorityOff;
    }
  }
  return RollerBlock::kNone;
}

inline bool isRollerEstopBlock(RollerBlock block) {
  return block == RollerBlock::kEstopUnknown || block == RollerBlock::kEstopActive ||
         block == RollerBlock::kEstopStale;
}

inline bool isRollerAuthorityBlock(RollerBlock block) {
  return block == RollerBlock::kAuthorityUnknown || block == RollerBlock::kAuthorityOff ||
         block == RollerBlock::kAuthorityStale;
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
    case RollerBlock::kAuthorityUnknown:
      return "authority_unknown";
    case RollerBlock::kAuthorityOff:
      return "authority_off";
    case RollerBlock::kAuthorityStale:
      return "authority_stale";
  }
  return "unknown";
}

}  // namespace esc_motor_control_cpp
