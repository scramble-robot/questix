// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#ifndef QUESTIX_SAFETY__ESTOP_CHECK_HPP_
#define QUESTIX_SAFETY__ESTOP_CHECK_HPP_

#include <cmath>

// The /emergency_stop rule every actuating node follows, ROS-free and clock-injected (ages in
// seconds of the node's own steady clock) so that it is unit-tested once. The ROS side
// (subscription, QoS, parameters) is emergency_stop_monitor.hpp.
//
// The rule: an E-stop that has never been heard, or that went silent for longer than its timeout,
// counts as pressed; a received active=true is pressed. operation_manager always publishes it in
// questix_core (also without the GPIO safety path, as "released (no GPIO safety path)"), so this
// is one rule for every wiring. Only an explicit diagnostic run may drop the "unheard / silent"
// part (required=false); a received pressed E-stop stops even then.
//
// The teacher's permission (/actuation_authority) is a different concept and is not here.
namespace questix_safety {

enum class EstopState {
  kReleased,  // heard, released and fresh (or, not required, simply not pressed)
  kUnknown,   // never heard (required)
  kPressed,   // the last message said active=true
  kStale,     // heard once, then silent for longer than the timeout (required)
};

struct EstopInputs {
  bool required{true};  // false only for an explicit diagnostic opt-out (require_emergency_stop)
  bool known{false};    // at least one message was received
  bool active{true};    // the last message's active
  double age_sec{0.0};  // since the last message, on the node's steady clock
  double timeout_sec{1.0};  // <= 0 disables the staleness check; non-finite never is fresh
};

inline constexpr double kDefaultEstopTimeoutSec = 1.0;

// A signal received once is stale when it has been silent for longer than timeout_sec.
// timeout_sec <= 0 or non-finite disables the check; an unknown (NaN) age is never fresh.
inline bool isStale(double age_sec, double timeout_sec) {
  return std::isfinite(timeout_sec) && timeout_sec > 0.0 && !(age_sec <= timeout_sec);
}

// The configured timeout as the monitor uses it: a non-finite value falls back to the default
// (it must not silently disable the check), <= 0 keeps meaning "no staleness check".
inline double normalizeEstopTimeout(double timeout_sec) {
  return std::isfinite(timeout_sec) ? timeout_sec : kDefaultEstopTimeoutSec;
}

inline EstopState evaluateEstop(const EstopInputs& in) {
  if (!in.known) {
    return in.required ? EstopState::kUnknown : EstopState::kReleased;
  }
  if (in.active) {
    return EstopState::kPressed;  // a received pressed E-stop always stops
  }
  if (in.required && isStale(in.age_sec, in.timeout_sec)) {
    return EstopState::kStale;
  }
  return EstopState::kReleased;
}

// Whether the state means "do not move".
inline bool engaged(EstopState state) { return state != EstopState::kReleased; }

inline const char* estopStateName(EstopState state) {
  switch (state) {
    case EstopState::kReleased:
      return "released";
    case EstopState::kUnknown:
      return "estop_unknown";
    case EstopState::kPressed:
      return "estop_active";
    case EstopState::kStale:
      return "estop_stale";
  }
  return "unknown";
}

}  // namespace questix_safety

#endif  // QUESTIX_SAFETY__ESTOP_CHECK_HPP_
