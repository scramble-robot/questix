// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__WHEEL_POSITION_ODOMETRY_HPP_
#define MOTOR_CONTROL_APP__WHEEL_POSITION_ODOMETRY_HPP_

#include <algorithm>
#include <cmath>
#include <cstdint>

#include "motor_control_app/odometry_integrator.hpp"
#include "motor_control_lib/ddt_protocol.hpp"

namespace motor_control_app::wheel_position {

inline constexpr double kTwoPi = 6.28318530717958647692;
// The nearest integer turn candidate is unique below 0.5 turn. Use half that
// tolerance, leaving room for integer RPM bias and periodic encoder error.
inline constexpr double kMaxPredictionErrorTurns = 0.25;
inline constexpr double kMaxAssistedGapSec = 0.2;

struct Limits {
  double radius{0.05};
  double separation{0.5};
  double max_rpm{475.0};
  double linear_accel{1.5};
  double angular_accel{1.5};
};

// Conditional on the wheel tracking the commanded acceleration bound:
// a_turns = (linear_accel + B/2 * angular_accel) / (R * 2pi).
// Endpoint trapezoid prediction error <= a_turns*T^2/4. Half the theoretical
// time bound budgets <= 0.0625 turn for acceleration, rather than 0.25 turn.
// Defaults give a=5.968 turns/s^2, theoretical T=0.409 s; cap at 0.2 s.
// A changed geometry/acceleration setting can only shorten this cap. Disabled
// limits disable RPM-assisted multi-turn recovery; shortest-wrap can still be
// used when max_rpm*dt/60 < half a turn. Host limits are not measured physical
// bounds: external forces, tracking overshoot and emergency braking are outside
// this acceleration contract. Identical zero-speed endpoints within the cap are
// treated as stationary; a hidden externally forced whole turn is not detectable.
inline double assistedGapLimit(const Limits& limits) {
  if (!(limits.linear_accel > 0.0) || !(limits.angular_accel > 0.0)) {
    return 0.0;
  }
  const double acceleration =
      (limits.linear_accel + limits.separation * limits.angular_accel / 2.0) /
      (limits.radius * kTwoPi);
  if (!std::isfinite(acceleration) || !(acceleration > 0.0)) {
    return 0.0;
  }
  return std::min(kMaxAssistedGapSec,
                  0.5 * std::sqrt(4.0 * kMaxPredictionErrorTurns / acceleration));
}

struct Sample {
  uint16_t position{0};
  double native_rpm{0.0};
  double time_sec{0.0};  // monotonic feedback receive time, not publishing time
  uint64_t count{0};     // valid feedback_count, not a diagnostic topic
  bool received{false};
  uint8_t fault{0};
};

enum class State { kAnchored, kWaiting, kIntegrated, kReset };
enum class Reason { kNone, kInvalid, kStale, kFault, kGap, kAmbiguous };

inline const char* reasonName(Reason reason) {
  switch (reason) {
    case Reason::kNone:
      return "none";
    case Reason::kInvalid:
      return "invalid feedback or geometry";
    case Reason::kStale:
      return "stale feedback";
    case Reason::kFault:
      return "motor fault";
    case Reason::kGap:
      return "feedback pairing time limit";
    case Reason::kAmbiguous:
      return "ambiguous wheel position";
  }
  return "unknown";
}

struct Result {
  State state{State::kWaiting};
  Reason reason{Reason::kNone};
  double distance{0.0};
  double heading{0.0};
};

// Both 32767 and 0 represent the same endpoint. Signed modulo also handles
// reverse wraps. No claim is made that the physical period was measured.
using motor_control_lib::ddt_protocol::shortestTurns;

inline bool wheelIncrement(const Sample& previous, const Sample& current, const Limits& limits,
                           double* turns) {
  const double dt = current.time_sec - previous.time_sec;
  if (!(dt > 0.0) || dt > kMaxAssistedGapSec) {
    return false;
  }
  const double shortest = shortestTurns(previous.position, current.position);
  const double prediction = (previous.native_rpm + current.native_rpm) * dt / 120.0;
  double candidate = shortest;
  if (limits.max_rpm * dt / 60.0 >= 0.5) {
    if (dt > assistedGapLimit(limits)) {
      return false;
    }
    candidate += std::round(prediction - shortest);
  }
  // Include a two-degree endpoint-error budget in the physical speed check.
  // These tolerances are not a license to repair an out-of-contract trajectory.
  if (std::fabs(candidate - prediction) >= kMaxPredictionErrorTurns ||
      std::fabs(candidate) > limits.max_rpm * dt / 60.0 + 2.0 / 360.0) {
    return false;
  }
  *turns = candidate;
  return true;
}

// Pose is deliberately not owned here: resets discard only the anchors. Both
// wheels must have NEW counts before a pair is integrated. A fast wheel's latest
// endpoint is held until the slow wheel arrives; neither count is consumed early.
class Integrator {
public:
  void reset() { anchored_ = false; }

  Result update(const Sample& left, const Sample& right, double now, const Limits& limits) {
    if (!valid(left, now) || !valid(right, now) || !std::isfinite(limits.radius) ||
        !std::isfinite(limits.separation) || !std::isfinite(limits.max_rpm) ||
        !(limits.radius > 0.0) || !(limits.separation > 0.0) || !(limits.max_rpm > 0.0)) {
      return discard(Reason::kInvalid);
    }
    if (left.fault != 0 || right.fault != 0) {
      return discard(Reason::kFault);
    }
    if (now - left.time_sec > odometry::kMaxFeedbackAgeSec ||
        now - right.time_sec > odometry::kMaxFeedbackAgeSec) {
      return discard(Reason::kStale);
    }
    const double assisted = assistedGapLimit(limits);
    const double cap = assisted > 0.0 ? assisted : kMaxAssistedGapSec;
    if (now - left.time_sec > cap || now - right.time_sec > cap) {
      return discard(Reason::kGap);
    }
    if (!anchored_) {
      anchor(left, right);
      return {State::kAnchored};
    }
    if (left.count < left_.count || right.count < right_.count) {
      return discard(Reason::kInvalid);  // library reinitialization/counter rollback
    }
    if (now - left_.time_sec > cap || now - right_.time_sec > cap) {
      anchor(left, right);
      return {State::kReset, Reason::kGap};
    }
    if (left.count == left_.count || right.count == right_.count) {
      return {State::kWaiting};
    }
    double dl = 0.0, dr = 0.0;
    const bool ok =
        wheelIncrement(left_, left, limits, &dl) && wheelIncrement(right_, right, limits, &dr);
    anchor(left, right);
    if (!ok) {
      return {State::kReset, Reason::kAmbiguous};
    }
    dr = -dr;  // mirrored right motor: convert native sign exactly once
    return {State::kIntegrated, Reason::kNone, limits.radius * kTwoPi * (dl + dr) / 2.0,
            limits.radius * kTwoPi * (dr - dl) / limits.separation};
  }

private:
  static bool valid(const Sample& sample, double now) {
    return sample.received && std::isfinite(now) && std::isfinite(sample.time_sec) &&
           std::isfinite(sample.native_rpm) && sample.time_sec <= now &&
           sample.position <= motor_control_lib::ddt_protocol::kPositionRawPerTurn;
  }
  void anchor(const Sample& left, const Sample& right) {
    left_ = left;
    right_ = right;
    anchored_ = true;
  }
  Result discard(Reason reason) {
    reset();
    return {State::kReset, reason};
  }
  Sample left_{};
  Sample right_{};
  bool anchored_{false};
};

inline odometry::Pose2D integrate(const odometry::Pose2D& pose, const Result& result) {
  return result.state == State::kIntegrated
             ? odometry::integrate(pose, result.distance, result.heading, 1.0)
             : pose;
}

}  // namespace motor_control_app::wheel_position

#endif  // MOTOR_CONTROL_APP__WHEEL_POSITION_ODOMETRY_HPP_
