// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include "motor_control_app/shot_angle.hpp"

namespace {

using motor_control_app::shot_angle::angleToServoPosition;
using motor_control_app::shot_angle::clampAngle;
using motor_control_app::shot_angle::servoPositionToAngle;

// Default tilt range from the ShotComponent constructor's declare_parameter
// calls: tilt_min_angle = 0.0, tilt_max_angle = 70.0.
constexpr double kMinDeg = 0.0;
constexpr double kMaxDeg = 70.0;

TEST(ShotAngle, ClampAngleMidRangePassthrough) {
  EXPECT_DOUBLE_EQ(clampAngle(35.0, kMinDeg, kMaxDeg), 35.0);
}

TEST(ShotAngle, ClampAngleBelowMin) { EXPECT_DOUBLE_EQ(clampAngle(-10.0, kMinDeg, kMaxDeg), 0.0); }

TEST(ShotAngle, ClampAngleAboveMax) { EXPECT_DOUBLE_EQ(clampAngle(120.0, kMinDeg, kMaxDeg), 70.0); }

TEST(ShotAngle, ClampAngleBoundariesExact) {
  EXPECT_DOUBLE_EQ(clampAngle(0.0, kMinDeg, kMaxDeg), 0.0);
  EXPECT_DOUBLE_EQ(clampAngle(70.0, kMinDeg, kMaxDeg), 70.0);
}

TEST(ShotAngle, AngleToServoPositionKnownValues) {
  EXPECT_EQ(angleToServoPosition(0.0), 0);
  EXPECT_EQ(angleToServoPosition(90.0), 1024);
  EXPECT_EQ(angleToServoPosition(180.0), 2048);
}

TEST(ShotAngle, AngleToServoPositionWrapsPositive) {
  // 360 degrees normalizes back to 0.
  EXPECT_EQ(angleToServoPosition(360.0), 0);
}

TEST(ShotAngle, AngleToServoPositionWrapsNegative) {
  // -90 degrees wraps to 270 degrees -> 0.75 * 4096 = 3072.
  EXPECT_EQ(angleToServoPosition(-90.0), 3072);
}

TEST(ShotAngle, AngleToServoPositionUpperClamp) {
  // 359.99 degrees truncates to 4095 (never reaches 4096).
  EXPECT_EQ(angleToServoPosition(359.99), 4095);
}

TEST(ShotAngle, ServoPositionToAngleKnownValues) {
  EXPECT_DOUBLE_EQ(servoPositionToAngle(0), 0.0);
  EXPECT_DOUBLE_EQ(servoPositionToAngle(2048), 180.0);
}

TEST(ShotAngle, ServoPositionToAngleMaxPosition) {
  EXPECT_DOUBLE_EQ(servoPositionToAngle(4095), 4095.0 / 4096.0 * 360.0);
}

TEST(ShotAngle, ServoPositionToAngleClampsBelow) {
  // -5 clamps to 0.
  EXPECT_DOUBLE_EQ(servoPositionToAngle(-5), servoPositionToAngle(0));
}

TEST(ShotAngle, ServoPositionToAngleClampsAbove) {
  // 5000 clamps to 4095.
  EXPECT_DOUBLE_EQ(servoPositionToAngle(5000), servoPositionToAngle(4095));
}

TEST(ShotAngle, RoundTripPositionToAngleToPosition) {
  for (int position : {0, 1024, 2048, 4095}) {
    EXPECT_EQ(angleToServoPosition(servoPositionToAngle(position)), position);
  }
}

}  // namespace
