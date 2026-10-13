// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__DRIVE_REARM_HPP_
#define MOTOR_CONTROL_APP__DRIVE_REARM_HPP_

#include <cmath>

namespace motor_control_app::drive_rearm {

// Operator drift allowance, not a motion deadzone. Both velocity and current modes.
// Bounded below the LAB caps (0.15 m/s, 0.5 rad/s); these are operational limits,
// not measured controller calibration. Invalid settings fall back to strict zero.
inline constexpr double kMaxLinear = 0.05;
inline constexpr double kMaxAngular = 0.1;
inline bool validBand(double value, double maximum) {
  return std::isfinite(value) && value >= 0.0 && value <= maximum;
}
inline double bandOrZero(double value, double maximum) {
  return validBand(value, maximum) ? value : 0.0;
}

// Unlike drive_arbiter_component.cpp's LAB run-ending neutral (strict zero),
// this configurable band is used only to rearm the actuator, never to filter motion.
inline bool neutral(double linear, double angular, double linear_band, double angular_band) {
  return std::isfinite(linear) && std::isfinite(angular) &&
         std::abs(linear) <= linear_band && std::abs(angular) <= angular_band;
}

class Rearm {
public:
  enum class Decision { kAccept, kNeutral, kNeedsNeutral, kInhibited, kInvalid, kTimeout };
  void reset() {
    needs_neutral_ = true;
    heard_ = false;
  }
  bool needsNeutral() const { return needs_neutral_; }
  bool expired(double now, double timeout) const {
    return heard_ && timeout > 0.0 && now - accepted_at_ > timeout;
  }
  // Clock injected. A late callback must not overwrite the old command's deadline
  // before the control tick sends its timeout stop. Only accepted commands refresh it.
  Decision command(double linear, double angular, double now, double timeout,
                   bool inhibited, double linear_band, double angular_band) {
    if (inhibited) {
      reset();
      return Decision::kInhibited;
    }
    if (expired(now, timeout)) {
      needs_neutral_ = true;
      return Decision::kTimeout;
    }
    if (!std::isfinite(linear) || !std::isfinite(angular) || !std::isfinite(now)) {
      return Decision::kInvalid;
    }
    bool rearmed = false;
    if (needs_neutral_) {
      if (!neutral(linear, angular, linear_band, angular_band)) {
        return Decision::kNeedsNeutral;
      }
      needs_neutral_ = false;
      rearmed = true;
    }
    accepted_at_ = now;
    heard_ = true;
    return rearmed ? Decision::kNeutral : Decision::kAccept;
  }

private:
  bool needs_neutral_{true};
  bool heard_{false};
  double accepted_at_{0.0};
};
}  // namespace motor_control_app::drive_rearm

#endif  // MOTOR_CONTROL_APP__DRIVE_REARM_HPP_
