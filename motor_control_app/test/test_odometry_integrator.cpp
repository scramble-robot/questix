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
