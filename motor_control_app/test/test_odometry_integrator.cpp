// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <cmath>

#include "motor_control_app/odometry_integrator.hpp"

namespace {

using motor_control_app::odometry::integrate;
using motor_control_app::odometry::isFeedbackFresh;
using motor_control_app::odometry::isValidDt;
using motor_control_app::odometry::kMaxFeedbackAgeSec;
using motor_control_app::odometry::kMaxOdomDtSec;
using motor_control_app::odometry::normalizeAngle;
using motor_control_app::odometry::Pose2D;
using motor_control_app::odometry::YawQuaternion;
using motor_control_app::odometry::yawToQuaternion;

constexpr double kPi = 3.14159265358979323846;

TEST(OdometryIntegrator, StraightLineAdvancesAlongX) {
  Pose2D p = integrate(Pose2D{}, 1.0, 0.0, 0.1);
  EXPECT_NEAR(p.x, 0.1, 1e-12);
  EXPECT_NEAR(p.y, 0.0, 1e-12);
  EXPECT_NEAR(p.theta, 0.0, 1e-12);
}

TEST(OdometryIntegrator, StraightLineAtHeadingHalfPiMovesAlongY) {
  Pose2D start{0.0, 0.0, kPi / 2.0};
  Pose2D p = integrate(start, 1.0, 0.0, 0.2);
  EXPECT_NEAR(p.x, 0.0, 1e-12);
  EXPECT_NEAR(p.y, 0.2, 1e-12);
  EXPECT_NEAR(p.theta, kPi / 2.0, 1e-12);
}

TEST(OdometryIntegrator, PureRotationChangesOnlyTheta) {
  // v=0, w=pi, dt=0.5 -> theta=pi/2, position unchanged.
  Pose2D p = integrate(Pose2D{1.0, 2.0, 0.0}, 0.0, kPi, 0.5);
  EXPECT_NEAR(p.x, 1.0, 1e-12);
  EXPECT_NEAR(p.y, 2.0, 1e-12);
  EXPECT_NEAR(p.theta, kPi / 2.0, 1e-12);
}

TEST(OdometryIntegrator, QuarterCircleExactArc) {
  // A quarter circle of radius R traced in one step: v = R*w, integrate to
  // theta = pi/2. The exact arc solution must land at (R, R).
  const double R = 2.0;
  const double w = kPi;    // rad/s
  const double dt = 0.5;   // s -> dtheta = pi/2
  const double v = R * w;  // m/s
  Pose2D p = integrate(Pose2D{}, v, w, dt);
  EXPECT_NEAR(p.x, R, 1e-9);
  EXPECT_NEAR(p.y, R, 1e-9);
  EXPECT_NEAR(p.theta, kPi / 2.0, 1e-9);
}

TEST(OdometryIntegrator, IsValidDtBounds) {
  EXPECT_TRUE(isValidDt(0.1, kMaxOdomDtSec));
  EXPECT_TRUE(isValidDt(kMaxOdomDtSec, kMaxOdomDtSec));  // boundary is inclusive
  EXPECT_FALSE(isValidDt(0.0, kMaxOdomDtSec));
  EXPECT_FALSE(isValidDt(-0.1, kMaxOdomDtSec));
  EXPECT_FALSE(isValidDt(kMaxOdomDtSec + 0.001, kMaxOdomDtSec));
}

TEST(OdometryIntegrator, NormalizeAngleWraps) {
  EXPECT_NEAR(normalizeAngle(0.0), 0.0, 1e-12);
  EXPECT_NEAR(normalizeAngle(kPi), kPi, 1e-12);
  // -pi and +pi are the same heading; the boundary may resolve to either sign.
  EXPECT_NEAR(std::fabs(normalizeAngle(-kPi)), kPi, 1e-12);
  EXPECT_NEAR(normalizeAngle(kPi + 0.5), -kPi + 0.5, 1e-9);
  EXPECT_NEAR(normalizeAngle(3.0 * kPi), kPi, 1e-9);
  // Accumulated rotation past pi must stay within (-pi, pi].
  double theta = 0.0;
  for (int i = 0; i < 100; ++i) {
    theta = normalizeAngle(theta + 0.5);
    EXPECT_LE(theta, kPi + 1e-9);
    EXPECT_GT(theta, -kPi - 1e-9);
  }
}

TEST(OdometryIntegrator, YawToQuaternion) {
  YawQuaternion q0 = yawToQuaternion(0.0);
  EXPECT_NEAR(q0.z, 0.0, 1e-12);
  EXPECT_NEAR(q0.w, 1.0, 1e-12);

  YawQuaternion q1 = yawToQuaternion(kPi / 2.0);
  EXPECT_NEAR(q1.z, std::sin(kPi / 4.0), 1e-12);
  EXPECT_NEAR(q1.w, std::cos(kPi / 4.0), 1e-12);

  YawQuaternion qn = yawToQuaternion(-kPi / 2.0);
  EXPECT_NEAR(qn.z, -std::sin(kPi / 4.0), 1e-12);
  EXPECT_NEAR(qn.w, std::cos(kPi / 4.0), 1e-12);
}

TEST(OdometryIntegrator, IsFeedbackFresh) {
  EXPECT_TRUE(isFeedbackFresh(true, 0.1, kMaxFeedbackAgeSec));
  EXPECT_TRUE(isFeedbackFresh(true, kMaxFeedbackAgeSec, kMaxFeedbackAgeSec));  // inclusive
  EXPECT_FALSE(isFeedbackFresh(true, kMaxFeedbackAgeSec + 0.001, kMaxFeedbackAgeSec));
  EXPECT_FALSE(isFeedbackFresh(false, 0.0, kMaxFeedbackAgeSec));  // never received
}

}  // namespace

int main(int argc, char** argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}

// 実測の受信時刻で台形積分する: 2 点の平均の twist で、2 つの受信時刻の差だけ進む。
TEST(OdometryIntegrator, IntegrateBetweenUsesTheMeanTwistOverTheReceiptInterval) {
  using motor_control_app::odometry::integrateBetween;
  using motor_control_app::odometry::Pose2D;
  using motor_control_app::odometry::TwistSample;
  bool integrated = false;
  // 0.0 → 0.4 m/s に 20 ms で加速: 平均 0.2 m/s × 0.02 s = 4 mm
  const Pose2D p = integrateBetween(Pose2D{}, TwistSample{10.00, 0.0, 0.0},
                                    TwistSample{10.02, 0.4, 0.0}, 0.5, &integrated);
  EXPECT_TRUE(integrated);
  EXPECT_NEAR(p.x, 0.004, 1e-12);
  EXPECT_NEAR(p.y, 0.0, 1e-12);
}

TEST(OdometryIntegrator, IntegrateBetweenSkipsGapsAndNonIncreasingTimes) {
  using motor_control_app::odometry::integrateBetween;
  using motor_control_app::odometry::Pose2D;
  using motor_control_app::odometry::TwistSample;
  const Pose2D start{1.0, 2.0, 0.5};
  bool integrated = true;
  // 間隔が上限（例: kMaxFeedbackAgeSec 0.5 s）を超える = 途絶・未通電: 積分しない
  Pose2D p = integrateBetween(start, TwistSample{0.0, 0.5, 0.0}, TwistSample{0.6, 0.5, 0.0}, 0.5,
                              &integrated);
  EXPECT_FALSE(integrated);
  EXPECT_DOUBLE_EQ(p.x, start.x);
  // 同じ時刻・時刻の逆転も積分しない
  p = integrateBetween(start, TwistSample{1.0, 0.5, 0.0}, TwistSample{1.0, 0.5, 0.0}, 0.5,
                       &integrated);
  EXPECT_FALSE(integrated);
  EXPECT_DOUBLE_EQ(p.y, start.y);
}

TEST(OdometryIntegrator, IntegrateBetweenFollowsAnArcWithTheMeanTurnRate) {
  using motor_control_app::odometry::integrateBetween;
  using motor_control_app::odometry::Pose2D;
  using motor_control_app::odometry::TwistSample;
  // 角速度 0 → 2 rad/s に 0.1 s: 平均 1 rad/s × 0.1 s = 0.1 rad
  const Pose2D p =
      integrateBetween(Pose2D{}, TwistSample{0.0, 0.0, 0.0}, TwistSample{0.1, 0.0, 2.0}, 0.5);
  EXPECT_NEAR(p.theta, 0.1, 1e-12);
}

// 配信時刻まで最後の twist で延ばす（上限 kMaxExtrapolationSec）。過去の時刻には延ばさない。
TEST(OdometryIntegrator, ExtrapolateToThePublishTimeIsBounded) {
  using motor_control_app::odometry::extrapolate;
  using motor_control_app::odometry::kMaxExtrapolationSec;
  using motor_control_app::odometry::Pose2D;
  using motor_control_app::odometry::TwistSample;
  const TwistSample last{5.0, 0.5, 0.0};
  EXPECT_NEAR(extrapolate(Pose2D{}, last, 5.02).x, 0.01, 1e-12);
  EXPECT_NEAR(extrapolate(Pose2D{}, last, 9.0).x, 0.5 * kMaxExtrapolationSec, 1e-12);
  EXPECT_DOUBLE_EQ(extrapolate(Pose2D{}, last, 4.9).x, 0.0);
}

// A recovered left-only increment must preserve the existing exact arc and
// retained-pose contract; the rejected right endpoint contributes zero.
TEST(OdometryIntegrator, StopGapPartialWheelArcAndRetainedPose) {
  const double dl = .03;
  const double distance = dl / 2;
  const double heading = -dl / .5;
  const Pose2D start{1, 2, .4};
  const auto result = integrate(start, distance, heading, 1.0);
  EXPECT_NEAR(result.theta, .4 + heading, 1e-12);
  EXPECT_NEAR(result.x, 1 + distance / heading * (std::sin(.4 + heading) - std::sin(.4)), 1e-12);
  EXPECT_NEAR(result.y, 2 - distance / heading * (std::cos(.4 + heading) - std::cos(.4)), 1e-12);
  const auto unchanged = integrate(result, 0, 0, 1.0);
  EXPECT_EQ(unchanged.x, result.x);
  EXPECT_EQ(unchanged.y, result.y);
  EXPECT_EQ(unchanged.theta, result.theta);
}
