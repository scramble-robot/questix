// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <cmath>
#include <limits>

#include "fixtures/wheel_position_odometry_210.hpp"
#include "motor_control_app/wheel_position_odometry.hpp"

namespace {
namespace wp = motor_control_app::wheel_position;
namespace odom = motor_control_app::odometry;
constexpr double kPeriod = motor_control_lib::ddt_protocol::kPositionRawPerTurn;

wp::Sample sample(double turns, double rpm, double time, uint64_t count) {
  const double fraction = turns - std::floor(turns);
  return {static_cast<uint16_t>(std::round(fraction * kPeriod)), rpm, time, count, true, 0};
}

TEST(WheelPosition, PositiveAndNegativeWraps) {
  EXPECT_NEAR(wp::shortestTurns(32760, 5), 12.0 / kPeriod, 1e-12);
  EXPECT_NEAR(wp::shortestTurns(5, 32760), -12.0 / kPeriod, 1e-12);
}

TEST(WheelPosition, EndpointsAreEquivalentInBothDirections) {
  EXPECT_EQ(wp::shortestTurns(0, 32767), 0.0);
  EXPECT_EQ(wp::shortestTurns(32767, 0), 0.0);
  EXPECT_NEAR(wp::shortestTurns(32767, 1), 1.0 / kPeriod, 1e-12);
  EXPECT_NEAR(wp::shortestTurns(1, 32767), -1.0 / kPeriod, 1e-12);
}

TEST(WheelPosition, EndpointWrapIsIntegratedThroughThePairedTracker) {
  wp::Integrator tracker;
  auto left = sample(0, .1, 0, 1), right = sample(0, -.1, 0, 1);
  left.position = 32767;
  tracker.update(left, right, 0, {});
  left = sample(0, .1, .02, 2);
  right = sample(0, -.1, .02, 2);
  left.position = 1;
  right.position = 32766;
  const auto result = tracker.update(left, right, .02, {});
  EXPECT_EQ(result.state, wp::State::kIntegrated);
  EXPECT_NEAR(result.distance, .05 * wp::kTwoPi / kPeriod, 1e-12);
  EXPECT_EQ(result.heading, 0);
}

TEST(WheelPosition, StraightAndReverseDistance) {
  for (const double direction : {1.0, -1.0}) {
    wp::Integrator tracker;
    tracker.update(sample(0, 60 * direction, 0, 1), sample(0, -60 * direction, 0, 1), 0, {});
    const auto result = tracker.update(sample(.1 * direction, 60 * direction, .1, 2),
                                       sample(-.1 * direction, -60 * direction, .1, 2), .1, {});
    ASSERT_EQ(result.state, wp::State::kIntegrated);
    EXPECT_NEAR(result.distance, .05 * wp::kTwoPi * .1 * direction, 1e-5);
    EXPECT_NEAR(result.heading, 0, 2e-5);
  }
}

TEST(WheelPosition, InPlaceTurnAndExactArc) {
  wp::Integrator tracker;
  tracker.update(sample(0, -60, 0, 1), sample(0, -60, 0, 1), 0, {});
  auto result = tracker.update(sample(-.1, -60, .1, 2), sample(-.1, -60, .1, 2), .1, {});
  EXPECT_NEAR(result.distance, 0, 1e-5);
  EXPECT_NEAR(result.heading, .05 * wp::kTwoPi * .2 / .5, 2e-5);
  tracker.reset();
  tracker.update(sample(0, 60, 0, 1), sample(0, -120, 0, 1), 0, {});
  result = tracker.update(sample(.1, 60, .1, 2), sample(-.2, -120, .1, 2), .1, {});
  const auto pose = wp::integrate({}, result);
  const double theta = .05 * wp::kTwoPi * .1 / .5;
  const double radius = 1.5 * .5;
  EXPECT_NEAR(pose.x, radius * std::sin(theta), 1e-5);
  EXPECT_NEAR(pose.y, radius * (1 - std::cos(theta)), 1e-5);
}

TEST(WheelPosition, WaitsForBothCountsWithoutConsumingEither) {
  wp::Integrator tracker;
  tracker.update(sample(0, 60, 0, 1), sample(0, -60, 0, 1), 0, {});
  EXPECT_EQ(tracker.update(sample(.02, 60, .02, 2), sample(0, -60, 0, 1), .02, {}).state,
            wp::State::kWaiting);
  const auto result = tracker.update(sample(.04, 60, .04, 3), sample(-.04, -60, .04, 2), .04, {});
  EXPECT_EQ(result.state, wp::State::kIntegrated);
  EXPECT_NEAR(result.distance, .05 * wp::kTwoPi * .04, 1e-5);
  EXPECT_EQ(tracker.update(sample(.04, 60, .04, 3), sample(-.04, -60, .04, 2), .05, {}).state,
            wp::State::kWaiting);
}

TEST(WheelPosition, OneMissingWheelResetsAndPreservesPose) {
  wp::Integrator tracker;
  const odom::Pose2D pose{2, 3, .4};
  tracker.update(sample(0, 60, 0, 1), sample(0, -60, 0, 1), 0, {});
  const auto result = tracker.update(sample(.201, 60, .201, 4), sample(0, -60, 0, 1), .201, {});
  EXPECT_EQ(result.reason, wp::Reason::kGap);
  const auto unchanged = wp::integrate(pose, result);
  EXPECT_EQ(unchanged.x, pose.x);
  EXPECT_EQ(unchanged.y, pose.y);
  EXPECT_EQ(unchanged.theta, pose.theta);
  EXPECT_EQ(tracker.update(sample(.22, 60, .22, 5), sample(-.22, -60, .22, 2), .22, {}).state,
            wp::State::kAnchored);
}

TEST(WheelPosition, AssistedGapJustBelowLimitRecoversForwardAndReverseTurns) {
  for (const double direction : {1.0, -1.0}) {
    const double dt = wp::kMaxAssistedGapSec - 1e-6;
    const double turns = direction * 475 * dt / 60;
    double recovered = 0;
    ASSERT_TRUE(wp::wheelIncrement(sample(0, direction * 475 - .5, 0, 1),
                                   sample(turns, direction * 475 - .5, dt, 2), {}, &recovered));
    EXPECT_NEAR(recovered, turns, 1.0 / kPeriod);
    EXPECT_GT(std::fabs(recovered), 1.5);
  }
}

TEST(WheelPosition, GapBeyondLimitResetsBeforeIntegrating) {
  wp::Integrator tracker;
  tracker.update(sample(0, 475, 0, 1), sample(0, -475, 0, 1), 0, {});
  const double dt = wp::kMaxAssistedGapSec + 1e-6;
  const auto result = tracker.update(sample(475 * dt / 60, 475, dt, 2),
                                     sample(-475 * dt / 60, -475, dt, 2), dt, {});
  EXPECT_EQ(result.state, wp::State::kReset);
  EXPECT_EQ(result.reason, wp::Reason::kGap);
  EXPECT_EQ(result.distance, 0);
}

TEST(WheelPosition, HiddenWholeTurnCounterexampleIsOutsideTheAccelerationContract) {
  for (const double dt : {.2, .201}) {
    wp::Integrator tracker;
    tracker.update(sample(0, 0, 0, 1), sample(0, 0, 0, 1), 0, {});
    const auto result = tracker.update(sample(0, 0, dt, 2), sample(0, 0, dt, 2), dt, {});
    EXPECT_EQ(result.state, dt <= .2 ? wp::State::kIntegrated : wp::State::kReset);
    EXPECT_EQ(result.distance, 0);
    EXPECT_EQ(result.heading, 0);
  }
}

TEST(WheelPosition, LargePredictionResidualResets) {
  wp::Integrator tracker;
  tracker.update(sample(0, 0, 0, 1), sample(0, 0, 0, 1), 0, {});
  const auto result = tracker.update(sample(.4, 0, .1, 2), sample(0, 0, .1, 2), .1, {});
  EXPECT_EQ(result.state, wp::State::kReset);
  EXPECT_EQ(result.reason, wp::Reason::kAmbiguous);
}

TEST(WheelPosition, ResidualThresholdIsStrictAndNamed) {
  double turns = 0;
  EXPECT_FALSE(wp::wheelIncrement(sample(0, 75, 0, 1), sample(0, 75, .2, 2), {}, &turns));
  EXPECT_TRUE(wp::wheelIncrement(sample(0, 74.999, 0, 1), sample(0, 74.999, .2, 2), {}, &turns));
  EXPECT_EQ(wp::kMaxPredictionErrorTurns, .25);
}

TEST(WheelPosition, ImpossibleSpeedAndNonpositiveFeedbackIntervalAreRejected) {
  double turns = 0;
  EXPECT_FALSE(wp::wheelIncrement(sample(0, 480, 0, 1), sample(1.6, 480, .2, 2), {}, &turns));
  EXPECT_FALSE(wp::wheelIncrement(sample(0, 0, .1, 1), sample(0, 0, .1, 2), {}, &turns));
  EXPECT_FALSE(wp::wheelIncrement(sample(0, 0, .1, 1), sample(0, 0, .09, 2), {}, &turns));
}

TEST(WheelPosition, HighAccelerationSettingsShortenTimeLimit) {
  wp::Limits limits;
  EXPECT_DOUBLE_EQ(wp::assistedGapLimit(limits), .2);
  limits.linear_accel = 100;
  EXPECT_LT(wp::assistedGapLimit(limits), .04);
  wp::Integrator tracker;
  tracker.update(sample(0, 475, 0, 1), sample(0, -475, 0, 1), 0, limits);
  EXPECT_EQ(
      tracker.update(sample(.475, 475, .06, 2), sample(-.475, -475, .06, 2), .06, limits).state,
      wp::State::kReset);
}

TEST(WheelPosition, DisabledAccelerationAllowsOnlyUnambiguousShortWrap) {
  wp::Limits limits;
  limits.linear_accel = 0;
  double turns = 0;
  EXPECT_TRUE(wp::wheelIncrement(sample(0, 475, 0, 1), sample(475 * .02 / 60, 475, .02, 2), limits,
                                 &turns));
  EXPECT_FALSE(
      wp::wheelIncrement(sample(0, 475, 0, 1), sample(475 * .1 / 60, 475, .1, 2), limits, &turns));
}

TEST(WheelPosition, StaleFaultAndCounterRollbackDiscardAnchors) {
  for (const wp::Reason reason : {wp::Reason::kStale, wp::Reason::kFault, wp::Reason::kInvalid}) {
    wp::Integrator tracker;
    auto left = sample(0, 0, 0, 10), right = left;
    tracker.update(left, right, 0, {});
    double now = .02;
    if (reason == wp::Reason::kStale) now = .51;
    if (reason == wp::Reason::kFault) left.fault = 1;
    if (reason == wp::Reason::kInvalid) left.count = 1;
    EXPECT_EQ(tracker.update(left, right, now, {}).reason, reason);
    EXPECT_EQ(tracker.update(sample(.1, 0, .6, 11), sample(-.1, 0, .6, 11), .6, {}).state,
              wp::State::kAnchored);
  }
}

TEST(WheelPosition, InvalidFeedbackAndGeometryNeverIntegrate) {
  wp::Integrator tracker;
  auto invalid = sample(0, 0, 0, 1);
  invalid.position = 32768;
  EXPECT_EQ(tracker.update(invalid, sample(0, 0, 0, 1), 0, {}).reason, wp::Reason::kInvalid);
  invalid = sample(0, 0, 0, 1);
  invalid.native_rpm = std::numeric_limits<double>::quiet_NaN();
  EXPECT_EQ(tracker.update(invalid, sample(0, 0, 0, 1), 0, {}).reason, wp::Reason::kInvalid);
  wp::Limits limits;
  limits.radius = 0;
  EXPECT_EQ(tracker.update(sample(0, 0, 0, 1), sample(0, 0, 0, 1), 0, limits).reason,
            wp::Reason::kInvalid);
}

TEST(WheelPosition, ExplicitLifecycleResetPreservesPoseAndSkipsFirstPair) {
  wp::Integrator tracker;
  tracker.update(sample(0, 60, 0, 1), sample(0, -60, 0, 1), 0, {});
  auto pose =
      wp::integrate({}, tracker.update(sample(.1, 60, .1, 2), sample(-.1, -60, .1, 2), .1, {}));
  tracker.reset();
  const auto result = tracker.update(sample(.4, 60, .4, 5), sample(-.4, -60, .4, 5), .4, {});
  EXPECT_EQ(result.state, wp::State::kAnchored);
  EXPECT_EQ(wp::integrate(pose, result).x, pose.x);
}

TEST(WheelPosition, PeriodicPositionNoiseIsBoundedWithoutCumulativeDrift) {
  wp::Integrator tracker;
  odom::Pose2D pose;
  tracker.update(sample(0, 10, 0, 1), sample(0, -10, 0, 1), 0, {});
  for (int n = 1; n <= 2000; ++n) {
    const double t = n * .02;
    const double turns = t / 6.0;
    const double noise = std::sin(20 * turns * wp::kTwoPi) / 360.0;
    const auto result = tracker.update(sample(turns + noise, 10, t, n + 1),
                                       sample(-turns + noise, -10, t, n + 1), t, {});
    ASSERT_EQ(result.state, wp::State::kIntegrated);
    pose = wp::integrate(pose, result);
    EXPECT_LT(std::fabs(pose.theta), .0071);  // <= 0.4 deg from two +/-1 deg endpoints
  }
}

TEST(WheelPosition, NegativeIntegerRpmBiasDoesNotDrivePositionHeadingLeft) {
  wp::Integrator tracker;
  odom::Pose2D pose, old_pose;
  tracker.update(sample(0, 9.5, 0, 1), sample(0, -10.5, 0, 1), 0, {});
  for (int n = 1; n <= 1000; ++n) {
    const double t = n * .02;
    const auto result =
        tracker.update(sample(t / 6, 9.5, t, n + 1), sample(-t / 6, -10.5, t, n + 1), t, {});
    ASSERT_EQ(result.state, wp::State::kIntegrated);
    pose = wp::integrate(pose, result);
    old_pose =
        odom::integrate(old_pose, .05 * wp::kTwoPi * 10 / 60, .05 * wp::kTwoPi / 60 / .5, .02);
  }
  EXPECT_NEAR(pose.theta, 0, 2e-5);
  EXPECT_NEAR(old_pose.theta, wp::kTwoPi / 30, 1e-10);  // 12 deg in 20 seconds
}

// Warm up a full reference/raw history at zero position. New reply stamps are
// exact dyadic values, so .5 s boundary tests do not depend on decimal rounding.
void prime(wp::Integrator& tracker, double rpm = 30.0,
           wp::StopGapOptions options = {true, 1.25, 8}) {
  tracker.configure(options);
  for (unsigned i = 0; i <= 32; ++i) {
    tracker.update(sample(0, rpm, i / 64.0, i + 1), sample(0, -rpm, i / 64.0, i + 1), i / 64.0, {});
  }
}

TEST(StopGap, InclusiveBoundAndExclusiveSecondCandidateWithoutEpsilon) {
  for (double d : {0.0, .125, -.125, .5, -.5}) {
    const double lower = std::fabs(d), upper = 1 - lower;
    EXPECT_EQ(wp::uniqueStopIncrement(d, lower).decision,
              lower < upper ? wp::StopDecision::kAccepted : wp::StopDecision::kAmbiguous);
    EXPECT_EQ(wp::uniqueStopIncrement(d, std::nextafter(lower, -1.0)).decision,
              lower == 0 ? wp::StopDecision::kHardGate : wp::StopDecision::kOutside);
    EXPECT_EQ(wp::uniqueStopIncrement(d, std::nextafter(lower, 2.0)).decision,
              lower < upper ? wp::StopDecision::kAccepted : wp::StopDecision::kAmbiguous);
    EXPECT_EQ(wp::uniqueStopIncrement(d, upper).decision, wp::StopDecision::kAmbiguous);
    EXPECT_EQ(wp::uniqueStopIncrement(d, std::nextafter(upper, 2.0)).decision,
              wp::StopDecision::kAmbiguous);
    EXPECT_EQ(wp::uniqueStopIncrement(d, std::nextafter(upper, 0.0)).decision,
              lower < upper ? wp::StopDecision::kAccepted : wp::StopDecision::kOutside);
  }
}

TEST(StopGap, NonshortestCandidateAlwaysImpliesMultipleCandidatesIncludingLargeBounds) {
  for (int i = -50; i <= 50; ++i) {
    const double d = i / 100.0;
    for (int j = 0; j <= 400; ++j) {
      const double upper = j / 100.0;
      int candidates = 0;
      for (int n = -5; n <= 5; ++n) {
        if (std::fabs(d + n) <= upper) {
          ++candidates;
          if (n != 0) {
            EXPECT_LE(std::fabs(d), upper);
          }
        }
      }
      const auto decision = wp::uniqueStopIncrement(d, upper).decision;
      EXPECT_EQ(decision, candidates == 0   ? wp::StopDecision::kOutside
                          : candidates == 1 ? wp::StopDecision::kAccepted
                                            : wp::StopDecision::kAmbiguous);
    }
  }
  EXPECT_EQ(wp::uniqueStopIncrement(.01, 1.01).decision, wp::StopDecision::kAmbiguous);
}

TEST(StopGap, LimitationUnderestimatedBoundAcceptsAliasedReverseRotation) {
  // True -0.6 turn aliases to +0.4; an underestimated U=.5 accepts it.
  EXPECT_EQ(wp::uniqueStopIncrement(.4, .5).decision, wp::StopDecision::kAccepted);
  EXPECT_EQ(wp::uniqueStopIncrement(.4, .63).decision, wp::StopDecision::kAmbiguous);
}

TEST(StopGap, LimitationHiddenWholeTurnIsAccepted) {
  EXPECT_EQ(wp::uniqueStopIncrement(.01, .1).decision, wp::StopDecision::kAccepted);
  EXPECT_EQ(wp::uniqueStopIncrement(.01, 1.01).decision, wp::StopDecision::kAmbiguous);
}

TEST(StopGap, GapBoundariesAndRealTimeExpiry) {
  for (double dt : {.2, .200001, .5, .500001}) {
    wp::Integrator tracker;
    prime(tracker);
    const auto result =
        tracker.update(sample(.01, 0, .5 + dt, 34), sample(-.01, 0, .5 + dt, 34), .5 + dt, {});
    EXPECT_EQ(result.state, dt <= .5 ? wp::State::kIntegrated : wp::State::kReset) << dt;
    if (dt > .5) {
      EXPECT_EQ(result.reason, wp::Reason::kStale);
      const auto next =
          tracker.update(sample(.02, 0, 1.02, 35), sample(-.02, 0, 1.02, 35), 1.02, {});
      EXPECT_NEAR(next.distance, .05 * wp::kTwoPi * .01, 1e-5);  // no old .01 recovered
    }
  }
}

TEST(StopGap, HoldsThroughCurrentAgeGateButExpiresWithoutNewPair) {
  wp::Integrator tracker;
  prime(tracker);
  const auto old = sample(0, 30, .5, 33);
  EXPECT_EQ(tracker.update(old, old, .75, {}).state, wp::State::kWaiting);
  EXPECT_EQ(tracker.update(old, old, 1.0, {}).state, wp::State::kWaiting);
  EXPECT_EQ(tracker.update(sample(.1, 0, 1.001, 34), old, 1.001, {}).reason, wp::Reason::kStale);
  EXPECT_EQ(tracker.update(sample(.2, 0, 1.01, 35), sample(-.2, 0, 1.01, 34), 1.01, {}).state,
            wp::State::kAnchored);
}

TEST(StopGap, HistoryMustCoverHalfSecondBeforeAnchorAndResetClearsIt) {
  wp::Integrator tracker;
  for (bool reset : {false, true}) {
    prime(tracker);
    if (reset) tracker.reset();
    auto l = sample(0, 0, .5, 33);
    if (reset) tracker.update(l, l, .5, {});
    const auto result =
        tracker.update(sample(.01, 0, .8125, 34), sample(-.01, 0, .8125, 34), .8125, {});
    EXPECT_EQ(result.state, reset ? wp::State::kReset : wp::State::kIntegrated);
    if (reset) {
      EXPECT_EQ(result.reason, wp::Reason::kHistory);
    }
  }
  tracker.configure({true, 1.25, 8});
  tracker.update(sample(0, 0, 0, 1), sample(0, 0, 0, 1), 0, {});
  EXPECT_EQ(tracker.update(sample(.01, 0, .3125, 2), sample(-.01, 0, .3125, 2), .3125, {}).reason,
            wp::Reason::kHistory);
  // Insufficient-history rejection preserves observations, allowing recovery to warm up.
  for (int i = 3; i < 10; ++i) {
    const double t = i * .3125;
    tracker.update(sample(.01, 0, t, i), sample(-.01, 0, t, i), t, {});
  }
  EXPECT_EQ(tracker.update(sample(.01, 0, 3.125, 10), sample(-.01, 0, 3.125, 10), 3.125, {}).state,
            wp::State::kIntegrated);
}

TEST(StopGap, AsyncLatestEndpointsDuplicatesAndReceivedCounterRollback) {
  wp::Integrator tracker;
  prime(tracker);
  auto r = sample(0, -30, .5, 33);
  EXPECT_EQ(tracker.update(sample(.02, 0, .75, 34), r, .75, {}).state, wp::State::kWaiting);
  EXPECT_EQ(tracker.update(sample(.03, 0, .78125, 35), r, .78125, {}).state, wp::State::kWaiting);
  auto l = sample(.04, 0, .8125, 36);
  r = sample(-.04, 0, .8125, 34);
  const auto result = tracker.update(l, r, .8125, {});
  ASSERT_EQ(result.state, wp::State::kIntegrated);
  EXPECT_NEAR(result.distance, .05 * wp::kTwoPi * .04, 1e-5);
  EXPECT_EQ(tracker.update(l, r, .84, {}).state, wp::State::kWaiting);
  l = sample(.05, 0, .875, 40);
  EXPECT_EQ(tracker.update(l, r, .875, {}).state, wp::State::kWaiting);
  l.count = 39;  // still above CONSUMED 36, but below RECEIVED 40
  EXPECT_EQ(tracker.update(l, r, .89, {}).reason, wp::Reason::kInvalid);
}

TEST(StopGap, PartialAcceptanceConsumesBothAndPreservesHeading) {
  wp::Integrator tracker;
  prime(tracker, 30);
  // U=.19556: left .1 is unique; right .4 is outside.
  const auto result = tracker.update(sample(.1, 0, .8125, 34), sample(.4, 0, .8125, 34), .8125, {});
  EXPECT_EQ(result.left.decision, wp::StopDecision::kAccepted);
  EXPECT_EQ(result.right.decision, wp::StopDecision::kOutside);
  EXPECT_NEAR(result.distance, .05 * wp::kTwoPi * .1 / 2, 1e-5);
  EXPECT_NEAR(result.heading, -.05 * wp::kTwoPi * .1 / .5, 1e-5);
  const auto next = tracker.update(sample(.1, 0, 1.125, 35), sample(.4, 0, 1.125, 35), 1.125, {});
  EXPECT_EQ(next.state, wp::State::kIntegrated);
  EXPECT_EQ(next.distance, 0);
  EXPECT_EQ(next.heading, 0);
}

TEST(StopGap, SpeedHistoryUsesBeforeStartIncludingReferenceAndExcludesEndpointRpm) {
  wp::Integrator tracker;
  prime(tracker, 0);
  // Endpoint reports a huge rpm, but must NOT inflate this interval's bound.
  auto result = tracker.update(sample(.2, 400, .8125, 34), sample(-.2, -400, .8125, 34), .8125, {});
  EXPECT_EQ(result.left.decision, wp::StopDecision::kOutside);
  tracker.configure({true, 1.25, 8});
  for (unsigned i = 0; i <= 32; ++i) {
    auto l = sample(0, 0, i / 64.0, i + 1), r = l;
    l.ref_rpm = r.ref_rpm = 30;
    tracker.update(l, r, i / 64.0, {});
  }
  result = tracker.update(sample(.1, 0, .8125, 34), sample(-.1, 0, .8125, 34), .8125, {});
  EXPECT_EQ(result.state, wp::State::kIntegrated);
  EXPECT_EQ(result.left.decision, wp::StopDecision::kAccepted);
}

TEST(StopGap, NoiseAndZeroThresholdsAreIndependentAndRepeatedRepliesDoNotCount) {
  for (int noise : {8, 16}) {
    wp::Integrator tracker;
    prime(tracker, 0, {true, 1.25, noise});
    auto l = sample(0, 0, .8125, 34), r = l;
    l.position = 12;
    auto result = tracker.update(l, r, .8125, {});
    EXPECT_EQ(result.left.decision,
              noise == 8 ? wp::StopDecision::kOutside : wp::StopDecision::kAccepted);
    EXPECT_FALSE(result.both_zero);  // T_zero remains 8 even with T_noise=16
    for (int i = 0; i < 3; ++i) tracker.update(l, r, .82 + i * .01, {});
    l.count = r.count = 35;
    l.time_sec = r.time_sec = 1.125;
    l.position = 16;
    result = tracker.update(l, r, 1.125, {});
    EXPECT_FALSE(result.both_zero);  // only ONE new quiet reply after the 12-count jump
    l.count = r.count = 36;
    l.time_sec = r.time_sec = 1.4375;
    l.position = 20;
    result = tracker.update(l, r, 1.4375, {});
    EXPECT_TRUE(result.both_zero);
    EXPECT_EQ(result.left.decision, wp::StopDecision::kAccepted);
  }
}

TEST(StopGap, ExternalForceWithZeroRpmHistoryIsOutsideBound) {
  for (double d : {.2, -.2, .49, -.49}) {
    wp::Integrator tracker;
    prime(tracker, 0);
    const auto result =
        tracker.update(sample(d, 0, .8125, 34), sample(-d, 0, .8125, 34), .8125, {});
    EXPECT_EQ(result.left.decision, wp::StopDecision::kOutside);
    EXPECT_EQ(result.right.decision, wp::StopDecision::kOutside);
  }
}

TEST(StopGap, HardGatePriorityAndRestartClearsHistory) {
  for (int gate = 0; gate < 7; ++gate) {
    wp::Integrator tracker;
    prime(tracker);
    auto l = sample(.1, 0, .8125, 34), r = sample(-.1, 0, .8125, 34);
    wp::Reason expected = wp::Reason::kInvalid;
    switch (gate) {
      case 0:
        l.position = 40000;
        l.fault = 1;
        break;
      case 1:
        l.count = 20;
        l.fault = 1;
        break;
      case 2:
        l.time_sec = .5;
        break;  // new counter, nonincreasing stamp
      case 3:
        l.fault = 1;
        l.mode_matches = false;
        expected = wp::Reason::kFault;
        break;
      case 4:
        l.mode_matches = false;
        expected = wp::Reason::kMode;
        break;
      case 5:
        l.time_sec = 1;
        break;  // future time
      case 6:
        l.ref_rpm = 10;
        expected = wp::Reason::kRef;
        break;
    }
    EXPECT_EQ(tracker.update(l, r, .8125, {}).reason, expected);
    l = sample(0, 0, .9, 40);
    r = l;
    EXPECT_EQ(tracker.update(l, r, .9, {}).state, wp::State::kAnchored);
    EXPECT_EQ(tracker.update(sample(.01, 0, 1.2, 41), sample(-.01, 0, 1.2, 41), 1.2, {}).reason,
              wp::Reason::kHistory);
  }
}

TEST(StopGap, DefaultOffMatchesFrozen210AcrossMovingStoppingAndInvalidStreams) {
  motor_control_app::frozen210::Integrator legacy;
  wp::Integrator tracker;
  // Both implicit default and explicitly configured OFF must match the fixed
  // predecessor exactly, even when recovery-only metadata would reject ON.
  for (bool explicit_off : {false, true}) {
    legacy.reset();
    tracker.reset();
    if (explicit_off) tracker.configure({false, 9.0, 999});
    uint64_t lc = 0, rc = 0;
    double lt = 0, rt = 0;
    for (int i = 0; i < 5000; ++i) {
      const double now = i * .02;
      if ((i < 2500 && i % 17 != 0) || (i >= 2500 && i % 16 == 0)) {
        ++lc;
        lt = now;
      }
      if ((i < 2500 && i % 37 != 0) || (i >= 2500 && i % 16 == 1)) {
        ++rc;
        rt = now;
      }
      auto l = sample(i * .002, i % 110 < 60 ? 0 : 60, lt, lc);
      auto r = sample(-i * .002, i % 110 < 60 ? 0 : -60, rt, rc);
      if (i % 223 == 0) {
        lc = 0;
        l.count = 0;
      }
      if (i % 41 == 0) l.received = false;
      if (i % 101 == 0) l.fault = 1;
      if (i % 71 == 0) l.position = 40000;
      if (i % 89 == 0) r.time_sec = now - .6;
      if (i % 157 == 0) {
        legacy.reset();
        tracker.reset();
      }
      l.mode_matches = false;
      l.ref_rpm = std::numeric_limits<double>::quiet_NaN();
      const motor_control_app::frozen210::Sample ol{l.position, l.native_rpm, l.time_sec,
                                                    l.count,    l.received,   l.fault};
      const motor_control_app::frozen210::Sample oright{r.position, r.native_rpm, r.time_sec,
                                                        r.count,    r.received,   r.fault};
      const auto expected = legacy.update(ol, oright, now, {});
      const auto actual = tracker.update(l, r, now, {});
      ASSERT_EQ(static_cast<int>(actual.state), static_cast<int>(expected.state)) << i;
      ASSERT_EQ(static_cast<int>(actual.reason), static_cast<int>(expected.reason)) << i;
      ASSERT_EQ(actual.distance, expected.distance) << i;
      ASSERT_EQ(actual.heading, expected.heading) << i;
    }
  }
}

TEST(StopGap, HistoryWindowIncludesExactStartAndExcludesEarlierPeak) {
  for (unsigned peak : {0u, 1u}) {
    wp::Integrator tracker;
    tracker.configure({true, 1.25, 8});
    for (unsigned i = 0; i <= 33; ++i) {
      const double rpm = i == peak ? 60 : 0;
      tracker.update(sample(0, rpm, i / 64.0, i + 1), sample(0, -rpm, i / 64.0, i + 1), i / 64.0,
                     {});
    }
    const auto result =
        tracker.update(sample(.1, 0, .828125, 35), sample(-.1, 0, .828125, 35), .828125, {});
    EXPECT_EQ(result.left.decision,
              peak == 1 ? wp::StopDecision::kAccepted : wp::StopDecision::kOutside);
  }
}

TEST(StopGap, WrapEndpointsAndEightCountZeroBoundary) {
  for (uint16_t endpoint : {0, 32767, 8, 32759}) {
    wp::Integrator tracker;
    prime(tracker, 0);
    auto l = sample(0, 0, .8125, 34), r = l;
    l.position = endpoint;
    const auto result = tracker.update(l, r, .8125, {});
    EXPECT_EQ(result.left.decision, wp::StopDecision::kAccepted);
    EXPECT_TRUE(result.both_zero);
    EXPECT_EQ(result.left.turns, wp::shortestTurns(0, endpoint));
  }
}

TEST(StopGap, NonfiniteAndBackwardClockInvalidatesHistory) {
  for (double now :
       {std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::infinity(), .49}) {
    wp::Integrator tracker;
    prime(tracker);
    EXPECT_EQ(tracker.update(sample(0, 0, .5, 33), sample(0, 0, .5, 33), now, {}).reason,
              wp::Reason::kInvalid);
  }
}

TEST(StopGap, PerWheelRefGateWhileOtherWheelRemainsAtZero) {
  wp::Integrator tracker;
  tracker.configure({true, 1.25, 8});
  for (unsigned i = 0; i <= 32; ++i) {
    auto l = sample(0, 30, i / 64.0, i + 1), r = l;
    r.ref_rpm = 30;  // already running, not a stop-to-motion transition
    tracker.update(l, r, i / 64.0, {});
  }
  auto l = sample(.1, 0, .8125, 34), r = sample(-.1, 0, .8125, 34);
  r.ref_rpm = 30;
  const auto result = tracker.update(l, r, .8125, {});
  EXPECT_EQ(result.left.decision, wp::StopDecision::kAccepted);
  EXPECT_EQ(result.right.decision, wp::StopDecision::kHardGate);
  EXPECT_EQ(result.right.reason, wp::Reason::kRef);
  EXPECT_NEAR(result.heading, -.05 * wp::kTwoPi * .1 / .5, 1e-5);
}

TEST(StopGap, ReferenceUsesTickStartBeforeFeedbackRatherThanTickEnd) {
  wp::Integrator tracker;
  tracker.configure({true, 1.25, 8});
  for (unsigned i = 0; i <= 32; ++i) {
    auto l = sample(0, 0, i / 64.0, i + 1), r = l;
    r.ref_rpm = 30;
    tracker.update(l, r, i / 64.0, {});
  }
  auto l = sample(0, 0, .515625, 34), r = l;
  l.ref_rpm = 60;
  r.ref_rpm = 30;
  tracker.update(l, r, .5234375, {}, .5078125);
  const auto result =
      tracker.update(sample(.1, 0, .828125, 35), sample(-.1, 0, .828125, 35), .828125, {});
  EXPECT_EQ(result.left.decision, wp::StopDecision::kAccepted);
  EXPECT_NEAR(result.left.upper, 60.0 / 60 * .3125 * 1.25 + 8.0 / kPeriod, 1e-15);
}

}  // namespace
