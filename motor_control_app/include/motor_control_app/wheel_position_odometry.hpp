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
#include <deque>

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

// Issue #229 B′ offline evaluation (2026-10-20): two fresh zero-speed
// replies and <=8 counts identify quiet wheels; this never bypasses a gate.
inline constexpr unsigned kZeroReplies = 2;
inline constexpr int kZeroCounts = 8;
inline constexpr double kStopHistorySec = 0.5;
inline constexpr double kStopHoldSec = 0.5;

struct StopGapOptions {
  bool enabled{false};
  double speed_margin{1.25};
  int64_t noise_counts{8};

  bool valid() const {
    return std::isfinite(speed_margin) && speed_margin > 0.0 && noise_counts >= 0;
  }
};

enum class State { kAnchored, kWaiting, kIntegrated, kReset };
enum class Reason { kNone, kInvalid, kStale, kFault, kGap, kAmbiguous, kMode, kRef, kHistory };

enum class StopDecision { kAccepted, kOutside, kAmbiguous, kHardGate };

struct StopIncrement {
  double turns{0.0};
  double upper{0.0};
  StopDecision decision{StopDecision::kHardGate};
  Reason reason{Reason::kNone};
};

// The bound is symmetric: a non-shortest candidate can never be the ONLY
// candidate. Equality belongs inside the bound, without an epsilon. A small U
// is an estimate from history, NOT a physical bound against external forces or
// hidden whole turns (see the explicitly named limitation tests).
inline StopIncrement uniqueStopIncrement(double d, double upper) {
  if (!std::isfinite(d) || !std::isfinite(upper) || std::fabs(d) > 0.5 || upper < 0.0) {
    return {d, upper, StopDecision::kHardGate};
  }
  return {d, upper,
          std::fabs(d) > upper          ? StopDecision::kOutside
          : upper >= 1.0 - std::fabs(d) ? StopDecision::kAmbiguous
                                        : StopDecision::kAccepted};
}

struct Sample {
  uint16_t position{0};
  double native_rpm{0.0};
  double time_sec{0.0};  // monotonic feedback receive time, not publishing time
  uint64_t count{0};     // valid feedback_count, not a diagnostic topic
  bool received{false};
  uint8_t fault{0};
  double ref_rpm{0.0};  // this tick, before velocity correction; never a topic input
  bool mode_matches{true};
};

inline const char* reasonName(Reason reason) {
  switch (reason) {
    case Reason::kMode:
      return "hard gate: mode mismatch";
    case Reason::kRef:
      return "hard gate: nonzero ref";
    case Reason::kHistory:
      return "hard gate: insufficient 0.5 s history";
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
  bool stop_gap{false};
  StopIncrement left{};
  StopIncrement right{};
  bool both_zero{false};
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
  void configure(const StopGapOptions& options) {
    options_ = options;
    reset();
  }
  void reset() {
    anchored_ = false;
    clearHistory();
  }

  Result update(const Sample& left, const Sample& right, double now, const Limits& limits) {
    return update(left, right, now, limits, now);
  }
  Result update(const Sample& left, const Sample& right, double now, const Limits& limits,
                double ref_time) {
    return options_.enabled ? updateStopGap(left, right, now, limits, ref_time)
                            : updateLegacy(left, right, now, limits);
  }

private:
  // Keep the default-OFF algorithm unchanged, including its gate order and
  // floating-point arithmetic. ON changes only intervals rejected for a gap.
  Result updateLegacy(const Sample& left, const Sample& right, double now, const Limits& limits) {
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
  struct HistoryPoint {
    double time{0.0};
    double rpm{0.0};
  };
  struct WheelHistory {
    std::deque<HistoryPoint> raw{};
    std::deque<HistoryPoint> ref{};
    Sample received{};  // distinct from the pair's CONSUMED endpoint
    bool seen{false};
    unsigned zeros{0};
    double anchor_max{0.0};
    bool anchor_history{false};

    void observe(const Sample& s, double now, double ref_time) {
      ref.push_back({ref_time, std::fabs(s.ref_rpm)});
      if (!seen || s.count != received.count) {
        const int counts = std::abs(static_cast<int>(received.position) - s.position);
        const int wrapped =
            std::min(counts, motor_control_lib::ddt_protocol::kPositionRawPerTurn - counts);
        const bool close = !seen || wrapped <= kZeroCounts;
        zeros = s.native_rpm == 0.0 && close ? std::min(zeros + 1, kZeroReplies) : 0;
        raw.push_back({s.time_sec, std::fabs(s.native_rpm)});
        received = s;
        seen = true;
      }
      // A pending endpoint can be .5 s old and needs the preceding .5 s.
      for (auto* series : {&raw, &ref}) {
        while (!series->empty() && series->front().time < now - kStopHoldSec - kStopHistorySec) {
          series->pop_front();
        }
      }
    }
    bool regressed(const Sample& s) const {
      return seen && (s.count < received.count ||
                      (s.count > received.count && s.time_sec <= received.time_sec));
    }
    void snapshot(double stamp, double since) {
      anchor_history = since <= stamp - kStopHistorySec;
      anchor_max = 0.0;
      for (const auto* series : {&raw, &ref}) {
        for (const auto& point : *series) {
          if (point.time >= stamp - kStopHistorySec && point.time <= stamp) {
            anchor_max = std::max(anchor_max, point.rpm);
          }
        }
      }
    }
  };

  void clearHistory() {
    lh_ = WheelHistory{};
    rh_ = WheelHistory{};
    history_started_ = false;
    history_since_ = 0.0;
    last_now_ = 0.0;
    was_stopped_ = false;
  }
  void stopAnchor(const Sample& l, const Sample& r) {
    anchor(l, r);
    lh_.snapshot(l.time_sec, history_since_);
    rh_.snapshot(r.time_sec, history_since_);
  }
  Result gapDiscard(Reason reason) {
    anchored_ = false;
    Result result{State::kReset, reason};
    result.stop_gap = true;
    result.left.reason = result.right.reason = reason;
    return result;
  }
  Result hardGate(Reason reason) {
    auto result = discard(reason);
    result.stop_gap = true;
    result.left.reason = result.right.reason = reason;
    return result;
  }
  StopIncrement recover(const Sample& old, const Sample& s, const WheelHistory& history) const {
    const double dt = s.time_sec - old.time_sec;
    if (s.ref_rpm != 0.0) return {0, 0, StopDecision::kHardGate, Reason::kRef};
    if (!history.anchor_history) return {0, 0, StopDecision::kHardGate, Reason::kHistory};
    if (!(dt > 0.0) || dt > kStopHoldSec) return {0, 0, StopDecision::kHardGate, Reason::kStale};
    return uniqueStopIncrement(shortestTurns(old.position, s.position),
                               history.anchor_max / 60.0 * dt * options_.speed_margin +
                                   static_cast<double>(options_.noise_counts) /
                                       motor_control_lib::ddt_protocol::kPositionRawPerTurn);
  }
  Result updateStopGap(const Sample& left, const Sample& right, double now, const Limits& limits,
                       double ref_time) {
    if (!std::isfinite(ref_time) || ref_time > now || !options_.valid() || !valid(left, now) ||
        !valid(right, now) || !std::isfinite(left.ref_rpm) || !std::isfinite(right.ref_rpm) ||
        !std::isfinite(limits.radius) || !(limits.radius > 0.0) ||
        !std::isfinite(limits.separation) || !(limits.separation > 0.0) ||
        !std::isfinite(limits.max_rpm) || !(limits.max_rpm > 0.0) ||
        (history_started_ && now < last_now_) || lh_.regressed(left) || rh_.regressed(right)) {
      return hardGate(Reason::kInvalid);
    }
    if (left.fault != 0 || right.fault != 0) return hardGate(Reason::kFault);
    if (!left.mode_matches || !right.mode_matches) return hardGate(Reason::kMode);
    if (now - left.time_sec > kStopHoldSec || now - right.time_sec > kStopHoldSec) {
      return hardGate(Reason::kStale);
    }
    const double assisted = assistedGapLimit(limits);
    const double cap = assisted > 0.0 ? assisted : kMaxAssistedGapSec;
    const bool stopped = left.ref_rpm == 0.0 && right.ref_rpm == 0.0;
    const bool gap = now - left.time_sec > cap || now - right.time_sec > cap ||
                     (anchored_ && (now - left_.time_sec > cap || now - right_.time_sec > cap));
    const bool expired =
        anchored_ && (now - left_.time_sec > kStopHoldSec || now - right_.time_sec > kStopHoldSec);
    // A restart invalidates the pending stop interval and its speed history.
    // Ordinary short running intervals still follow the legacy integrator.
    if (history_started_ && was_stopped_ && !stopped) {
      clearHistory();
      if (gap && !expired) return hardGate(Reason::kRef);
    }
    if (!history_started_ || now - last_now_ > kStopHistorySec) {
      history_since_ = now;
      history_started_ = true;
    }
    last_now_ = now;
    was_stopped_ = stopped;
    lh_.observe(left, now, ref_time);
    rh_.observe(right, now, ref_time);
    if (!anchored_) {
      stopAnchor(left, right);
      return {State::kAnchored};
    }
    // Real time, not the arriving sample's timestamp, bounds retention. Once
    // expired, these endpoints are consumed without integrating; never resurrect.
    if (expired) {
      stopAnchor(left, right);
      Result result{State::kReset, Reason::kStale};
      result.stop_gap = true;
      result.left.reason = result.right.reason = Reason::kStale;
      return result;
    }
    // A wheel may hold only with a zero closing-tick reference and complete
    // pre-anchor history. The other wheel can still be rejected independently.
    const bool left_can_hold = left.ref_rpm == 0.0 && lh_.anchor_history;
    const bool right_can_hold = right.ref_rpm == 0.0 && rh_.anchor_history;
    if (gap && !left_can_hold && !right_can_hold) {
      return gapDiscard(!stopped ? Reason::kRef : Reason::kHistory);
    }
    if (left.count == left_.count || right.count == right_.count) return {State::kWaiting};
    // Multiple replies from the fast wheel use its latest endpoint. No partial
    // endpoint is consumed, and no raw sample is counted twice in the history.
    auto l = lh_.received, r = rh_.received;
    // ref=0 is judged at the closing tick, as in the offline definition.
    l.ref_rpm = left.ref_rpm;
    r.ref_rpm = right.ref_rpm;
    if (!gap) {
      double dl = 0.0, dr = 0.0;
      const bool ok =
          wheelIncrement(left_, l, limits, &dl) && wheelIncrement(right_, r, limits, &dr);
      stopAnchor(l, r);
      if (!ok) return {State::kReset, Reason::kAmbiguous};
      return {State::kIntegrated, Reason::kNone, limits.radius * kTwoPi * (dl - dr) / 2.0,
              limits.radius * kTwoPi * (-dr - dl) / limits.separation};
    }
    Result result;
    result.stop_gap = true;
    result.left = recover(left_, l, lh_);
    result.right = recover(right_, r, rh_);
    result.both_zero = lh_.zeros >= kZeroReplies && rh_.zeros >= kZeroReplies;
    const bool lok = result.left.decision == StopDecision::kAccepted;
    const bool rok = result.right.decision == StopDecision::kAccepted;
    const double dl = lok ? result.left.turns : 0.0;
    const double dr = rok ? -result.right.turns : 0.0;
    result.state = lok || rok ? State::kIntegrated : State::kReset;
    result.reason = lok && rok ? Reason::kNone : Reason::kGap;
    result.distance = limits.radius * kTwoPi * (dl + dr) / 2.0;
    result.heading = limits.radius * kTwoPi * (dr - dl) / limits.separation;
    stopAnchor(l, r);  // rejected wheel also consumed: no later double recovery
    return result;
  }

  StopGapOptions options_{};
  WheelHistory lh_{}, rh_{};
  bool history_started_{false};
  double history_since_{0.0};
  double last_now_{0.0};
  bool was_stopped_{false};
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
