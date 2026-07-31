// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <cmath>

#include "motor_control_lib/differential_kinematics.hpp"

namespace kinematics = motor_control_lib::differential_kinematics;

namespace {

constexpr double kWheelRadius = 0.1;      // [m]
constexpr double kWheelSeparation = 0.5;  // [m]

}  // namespace

// 前進のみ: 左右輪が同じ大きさで逆符号になる（右輪は取り付け向きが逆）。
TEST(TwistToWheelRpm, ForwardOnlyGivesOppositeSigns) {
  const auto [left, right] = kinematics::twistToWheelRpm(1.0, 0.0, kWheelRadius, kWheelSeparation);
  // 1 m/s / (2π*0.1 m) * 60 = 95.49 RPM
  EXPECT_NEAR(left, 95.49, 0.01);
  EXPECT_NEAR(right, -95.49, 0.01);
}

// 旋回のみ: 左右輪が同符号（同じ向きに回して車体を回す）。
TEST(TwistToWheelRpm, TurnOnlyGivesSameSign) {
  const auto [left, right] = kinematics::twistToWheelRpm(0.0, 1.0, kWheelRadius, kWheelSeparation);
  // 1 rad/s * (0.5/2) / (2π*0.1) * 60 = 23.87 RPM
  EXPECT_NEAR(left, -23.87, 0.01);
  EXPECT_NEAR(right, -23.87, 0.01);
  EXPECT_GT(left * right, 0.0) << "旋回では左右輪が同符号になるはず";
}

// フルスティック旋回（angular_input_ratio 6.0）の車輪 RPM。
// design/drive_control_refactor.md §3.2 の動作点。
TEST(TwistToWheelRpm, FullStickTurnOperatingPoint) {
  const auto [left, right] = kinematics::twistToWheelRpm(0.0, 6.0, kWheelRadius, kWheelSeparation);
  EXPECT_NEAR(std::abs(left), 143.2, 0.1);
  EXPECT_NEAR(std::abs(right), 143.2, 0.1);
}

// 静止は 0。
TEST(TwistToWheelRpm, ZeroTwistGivesZeroRpm) {
  const auto [left, right] = kinematics::twistToWheelRpm(0.0, 0.0, kWheelRadius, kWheelSeparation);
  EXPECT_DOUBLE_EQ(left, 0.0);
  EXPECT_DOUBLE_EQ(right, 0.0);
}

// 不正な車輪半径では inf/NaN を返さず 0 を返す（暴走指令の防止）。
TEST(TwistToWheelRpm, InvalidWheelRadiusReturnsZero) {
  for (const double radius : {0.0, -0.1}) {
    const auto [left, right] = kinematics::twistToWheelRpm(1.0, 1.0, radius, kWheelSeparation);
    EXPECT_DOUBLE_EQ(left, 0.0) << "radius " << radius;
    EXPECT_DOUBLE_EQ(right, 0.0) << "radius " << radius;
  }
}

// 逆変換: 前進のみ。
TEST(WheelRpmToTwist, OppositeSignsGiveForward) {
  const auto [linear, angular] =
      kinematics::wheelRpmToTwist(95, -95, kWheelRadius, kWheelSeparation);
  EXPECT_NEAR(linear, 0.995, 0.01);
  EXPECT_NEAR(angular, 0.0, 1e-9);
}

// 逆変換: 旋回のみ。
TEST(WheelRpmToTwist, SameSignsGiveTurn) {
  const auto [linear, angular] =
      kinematics::wheelRpmToTwist(-24, -24, kWheelRadius, kWheelSeparation);
  EXPECT_NEAR(linear, 0.0, 1e-9);
  EXPECT_NEAR(angular, 1.005, 0.01);
}

// 不正な車輪間隔では角速度を 0 として返す（ゼロ除算の回避）。
TEST(WheelRpmToTwist, InvalidWheelSeparationGivesZeroAngular) {
  const auto [linear, angular] = kinematics::wheelRpmToTwist(100, 100, kWheelRadius, 0.0);
  EXPECT_DOUBLE_EQ(angular, 0.0);
  EXPECT_DOUBLE_EQ(linear, 0.0) << "旋回のみの車輪速度なので前進成分は 0";
}

// 往復変換で元の twist に戻る（符号反転が対称に入っていること）。
TEST(Roundtrip, TwistSurvivesConversionWithinQuantization) {
  constexpr double kLinear = 1.5;
  constexpr double kAngular = 2.0;
  const auto [left, right] =
      kinematics::twistToWheelRpm(kLinear, kAngular, kWheelRadius, kWheelSeparation);
  const auto [back_linear, back_angular] = kinematics::wheelRpmToTwist(
      static_cast<int>(std::lround(left)), static_cast<int>(std::lround(right)), kWheelRadius,
      kWheelSeparation);
  // 整数 RPM への丸めぶんの誤差だけ残る（1 RPM ≒ 0.0105 m/s / 0.042 rad/s）
  EXPECT_NEAR(back_linear, kLinear, 0.011);
  EXPECT_NEAR(back_angular, kAngular, 0.042);
}

int main(int argc, char** argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
