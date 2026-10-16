// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <cmath>
#include <limits>

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

}  // namespace
