// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#pragma once

#include <cmath>

namespace esc_motor_control_cpp {

// Whether the roller may spin at all right now (ROS-free, clock-injected: ages in seconds of
// the node's steady clock). Two separate concepts are judged separately and only then combined:
// the emergency stop (a safety function; with RollerEstopInputs::required, which questix_core
// sets from enable_gpio_ref, unknown and silent count as pressed) and the teacher's runtime
// authority (a permission, not an emergency stop; a practice opt-in, never looked at when not
// required). The rules are the same as motor_control_app/actuation_gate.hpp (drive and shot);
// the two packages do not depend on each other, so keep both headers and their tests in step.
enum class RollerBlock {
  kNone,              // may spin (a fresh press or lab command is still needed)
  kEstopUnknown,      // /emergency_stop never received (only when required)
  kEstopActive,       // E-stop pressed
  kEstopStale,        // /emergency_stop received once, then silent (only when required)
  kAuthorityUnknown,  // no runtime authority heartbeat received (only when opted in)
  kAuthorityOff,      // the teacher's authority says launcher off (only when opted in)
  kAuthorityStale,    // heartbeat silent for longer than its lease (only when opted in)
};

struct RollerEstopInputs {
  bool required{true};  // questix_core: enable_gpio_ref (false: no /emergency_stop publisher)
  bool known{false};
  bool active{true};
  double age_sec{0.0};
  double timeout_sec{1.0};  // <= 0 or non-finite: no staleness check
};

struct RollerAuthorityInputs {
  bool required{false};  // practice opt-in (require_runtime_actuation_authority)
  bool known{false};
  bool allowed{false};
  double age_sec{0.0};
  double timeout_sec{1.0};  // <= 0 or non-finite: treated as 1.0 (a lease expires)
};

struct RollerGateInputs {
  RollerEstopInputs estop;
  RollerAuthorityInputs authority;
};

inline bool rollerSignalStale(double age_sec, double timeout_sec) {
  return std::isfinite(timeout_sec) && timeout_sec > 0.0 && !(age_sec <= timeout_sec);
}

inline double rollerAuthorityLease(double timeout_sec) {
  return std::isfinite(timeout_sec) && timeout_sec > 0.0 ? timeout_sec : 1.0;
}

// The E-stop alone: kNone (released, or not required and not heard), or an E-stop reason.
inline RollerBlock evaluateRollerEstop(const RollerEstopInputs& in) {
  if (!in.known) {
    return in.required ? RollerBlock::kEstopUnknown : RollerBlock::kNone;
  }
  if (in.active) {
    return RollerBlock::kEstopActive;  // a received pressed E-stop always stops
  }
  if (in.required && rollerSignalStale(in.age_sec, in.timeout_sec)) {
    return RollerBlock::kEstopStale;
  }
  return RollerBlock::kNone;
}

// The teacher's authority alone. Not required means disabled: nothing else is looked at.
inline RollerBlock evaluateRollerAuthority(const RollerAuthorityInputs& in) {
  if (!in.required) {
    return RollerBlock::kNone;
  }
  if (!in.known) {
    return RollerBlock::kAuthorityUnknown;
  }
  if (!(in.age_sec <= rollerAuthorityLease(in.timeout_sec))) {
    return RollerBlock::kAuthorityStale;
  }
  if (!in.allowed) {
    return RollerBlock::kAuthorityOff;
  }
  return RollerBlock::kNone;
}

inline RollerBlock evaluateRollerGate(const RollerGateInputs& in) {
  const RollerBlock estop = evaluateRollerEstop(in.estop);
  if (estop != RollerBlock::kNone) {
    return estop;
  }
  return evaluateRollerAuthority(in.authority);
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
