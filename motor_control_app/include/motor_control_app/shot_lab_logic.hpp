// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__SHOT_LAB_LOGIC_HPP_
#define MOTOR_CONTROL_APP__SHOT_LAB_LOGIC_HPP_

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>
#include <string>
#include <vector>

#include "motor_control_app/tilt_input.hpp"

namespace motor_control_app::shot_lab {

// When a QUESTiX LAB request (/shot/lab/tilt, /shot/lab/fire) may move the launcher.
// ROS-free and clock-injected (monotonic seconds) so every rule is unit-tested. The controller
// always wins: its own fire and tilt inputs are never gated by this. A lab request is applied
// only while
// - the node accepts lab input (accept_lab_input, practice launches only),
// - the E-stop is released,
// - the node is ACTIVE (servos connected),
// - no shot sequence is running,
// - the controller's launcher inputs (fire button, tilt buttons/axis) were idle for
//   joy_quiet_sec,
// and, for firing, at least min_fire_interval_sec passed since the last shot from any source.
// Refused requests are never queued.
enum class Refusal {
  kNone,
  kNotAccepted,
  kEmergencyStop,
  kInactive,
  kShooting,
  kController,
  kInterval,
  kInvalid,
  kRateLimited,  // the tilt servo got a command less than command_rate_limit_ms ago
};

struct Conditions {
  bool accept{false};
  bool estop{false};
  bool active{false};
  bool shooting{false};
  double now_sec{0.0};
  double joy_active_at_sec{-std::numeric_limits<double>::infinity()};
  double joy_quiet_sec{1.0};
};

inline const char* refusalName(Refusal refusal) {
  switch (refusal) {
    case Refusal::kNotAccepted:
      return "not_accepted";
    case Refusal::kEmergencyStop:
      return "emergency_stop";
    case Refusal::kInactive:
      return "inactive";
    case Refusal::kShooting:
      return "shooting";
    case Refusal::kController:
      return "controller";
    case Refusal::kInterval:
      return "interval";
    case Refusal::kInvalid:
      return "invalid";
    case Refusal::kRateLimited:
      return "rate_limited";
    case Refusal::kNone:
    default:
      return "none";
  }
}

// The checks shared by tilt and fire, in the order the reasons are reported.
inline Refusal checkCommon(const Conditions& c) {
  if (!c.accept) {
    return Refusal::kNotAccepted;
  }
  if (c.estop) {
    return Refusal::kEmergencyStop;
  }
  if (!c.active) {
    return Refusal::kInactive;
  }
  if (c.shooting) {
    return Refusal::kShooting;
  }
  if (c.now_sec - c.joy_active_at_sec <= c.joy_quiet_sec) {
    return Refusal::kController;
  }
  return Refusal::kNone;
}

struct TiltDecision {
  Refusal refusal{Refusal::kNone};
  double target_deg{0.0};  // clamped to [min_deg, max_deg]
};

inline TiltDecision decideTilt(const Conditions& c, double requested_deg, double min_deg,
                               double max_deg) {
  TiltDecision decision;
  if (!std::isfinite(requested_deg)) {
    decision.refusal = Refusal::kInvalid;
    return decision;
  }
  decision.refusal = checkCommon(c);
  if (decision.refusal == Refusal::kNone) {
    decision.target_deg = std::max(min_deg, std::min(max_deg, requested_deg));
  }
  return decision;
}

// Seconds until the next lab shot is allowed (0 = now). last_fire_sec is -inf before any shot.
inline double nextFireInSec(double now_sec, double last_fire_sec, double min_interval_sec) {
  const double remaining = min_interval_sec - (now_sec - last_fire_sec);
  return std::isfinite(remaining) && remaining > 0.0 ? remaining : 0.0;
}

inline Refusal decideFire(const Conditions& c, double last_fire_sec, double min_interval_sec) {
  const Refusal common = checkCommon(c);
  if (common != Refusal::kNone) {
    return common;
  }
  if (nextFireInSec(c.now_sec, last_fire_sec, min_interval_sec) > 0.0) {
    return Refusal::kInterval;
  }
  return Refusal::kNone;
}

// Whether a /joy message shows the controller using the launcher: the fire button, or either tilt
// direction as that direction is configured (tilt_input.hpp: its axis past +-0.5 in its sign, or
// its button when the axis is -1) -- the same test joyCallback uses to move the tilt servo.
// Every index is bounds-checked against the message; a negative index is "not configured".
struct TiltControl {
  int axis;
  int sign;
  int button;
};

inline bool joyUsesLauncher(const std::vector<int32_t>& buttons, const std::vector<float>& axes,
                            int fire_button, const TiltControl& up, const TiltControl& down) {
  if (fire_button >= 0 && static_cast<std::size_t>(fire_button) < buttons.size() &&
      buttons[static_cast<std::size_t>(fire_button)] == 1) {
    return true;
  }
  return tiltInputPressed(axes, buttons, up.axis, up.sign, up.button) ||
         tiltInputPressed(axes, buttons, down.axis, down.sign, down.button);
}

enum class FireSource { kNone, kJoy, kLab };

inline const char* fireSourceJson(FireSource source) {
  switch (source) {
    case FireSource::kJoy:
      return "\"joy\"";
    case FireSource::kLab:
      return "\"lab\"";
    case FireSource::kNone:
    default:
      return "null";
  }
}

// /shot/status payload (std_msgs/String JSON). Every value is a number, a bool or one of the
// fixed names above, so nothing needs escaping.
struct Status {
  double tilt_deg{0.0};
  bool shooting{false};
  long fired_count{0};
  FireSource last_fire_source{FireSource::kNone};
  bool lab_accepted{false};
  bool estop{false};
  bool active{false};
  double tilt_min_deg{0.0};
  double tilt_max_deg{0.0};
  double next_fire_in_sec{0.0};
  Refusal lab_refused{Refusal::kNone};
};

inline std::string statusJson(const Status& s) {
  const auto finite = [](double value) { return std::isfinite(value) ? value : 0.0; };
  const auto flag = [](bool value) { return value ? "true" : "false"; };
  char refused[32];
  if (s.lab_refused == Refusal::kNone) {
    std::snprintf(refused, sizeof(refused), "null");
  } else {
    std::snprintf(refused, sizeof(refused), "\"%s\"", refusalName(s.lab_refused));
  }
  char buffer[512];
  std::snprintf(buffer, sizeof(buffer),
                "{\"tilt_deg\": %.1f, \"shooting\": %s, \"fired_count\": %ld, "
                "\"last_fire_source\": %s, \"lab_accepted\": %s, \"estop\": %s, "
                "\"active\": %s, \"tilt_min_deg\": %.1f, \"tilt_max_deg\": %.1f, "
                "\"next_fire_in_sec\": %.2f, \"lab_refused\": %s}",
                finite(s.tilt_deg), flag(s.shooting), s.fired_count,
                fireSourceJson(s.last_fire_source), flag(s.lab_accepted), flag(s.estop),
                flag(s.active), finite(s.tilt_min_deg), finite(s.tilt_max_deg),
                finite(s.next_fire_in_sec), refused);
  return std::string(buffer);
}

}  // namespace motor_control_app::shot_lab

#endif  // MOTOR_CONTROL_APP__SHOT_LAB_LOGIC_HPP_
