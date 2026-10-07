// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// wheel_rate_damper（velocity モードの共振ダンピング補正）の単体テスト。
// 閉ループでの効果と安定性は motor_control_app/test/test_control_core.cpp の
// ControlCoreRateDamper* で確認する。
#include <gtest/gtest.h>

#include <cmath>
#include <limits>

#include "motor_control_lib/wheel_rate_damper.hpp"

namespace damper = motor_control_lib::wheel_rate_damper;

namespace {

constexpr double kDt = 0.02;

damper::Params params(double gain) {
  damper::Params p;
  p.gain_sec = gain;
  p.filter_tau_sec = 0.08;
  p.max_correction_rpm = 30.0;
  return damper::sanitize(p);
}

}  // namespace

TEST(WheelRateDamper, DisabledAlwaysReturnsZero) {
  damper::State state;
  const auto p = params(0.0);
  EXPECT_FALSE(damper::enabled(p));
  for (int k = 0; k < 50; ++k) {
    EXPECT_DOUBLE_EQ(damper::step(state, p, 60.0, 60.0 + 20.0 * std::sin(k * 0.5), kDt), 0.0);
  }
}

TEST(WheelRateDamper, FirstStepAfterResetIsBumpless) {
  damper::State state;
  const auto p = params(0.08);
  // 大きな追従誤差があっても、最初の tick は状態を初期化するだけで補正 0
  EXPECT_DOUBLE_EQ(damper::step(state, p, 100.0, 40.0, kDt), 0.0);
  EXPECT_TRUE(state.initialized);
  damper::reset(state);
  EXPECT_FALSE(state.initialized);
}

TEST(WheelRateDamper, ConstantErrorLeavesNoSteadyCorrection) {
  // 定常の追従誤差（負荷で目標より遅い等）には反応しない: 速度の値ではなく変化率に掛かる
  damper::State state;
  const auto p = params(0.08);
  double c = 0.0;
  for (int k = 0; k < 200; ++k) {
    c = damper::step(state, p, 60.0, 55.0, kDt);
  }
  EXPECT_NEAR(c, 0.0, 1e-9);
}

TEST(WheelRateDamper, OpposesTheMeasuredSwing) {
  damper::State state;
  const auto p = params(0.08);
  damper::step(state, p, 60.0, 60.0, kDt);
  double c = 0.0;
  for (int k = 1; k <= 5; ++k) {
    c = damper::step(state, p, 60.0, 60.0 + 4.0 * k, kDt);  // 実測が目標より速くなっていく
  }
  EXPECT_LT(c, 0.0);
  for (int k = 1; k <= 10; ++k) {
    c = damper::step(state, p, 60.0, 80.0 - 4.0 * k, kDt);  // 速すぎた分が戻っていく
  }
  EXPECT_GT(c, 0.0);
}

TEST(WheelRateDamper, CorrectionIsClamped) {
  damper::State state;
  auto p = params(0.3);
  p.max_correction_rpm = 5.0;
  damper::step(state, p, 60.0, 60.0, kDt);
  for (int k = 0; k < 5; ++k) {
    const double c = damper::step(state, p, 60.0, 200.0, kDt);
    EXPECT_LE(std::abs(c), 5.0);
  }
}

TEST(WheelRateDamper, NyquistAlternationIsAveragedOut) {
  // tick ごとに交互に振れる成分（ナイキスト 25 Hz）は 2 サンプル平均で消え、補正に乗らない。
  // これに反応すると、ファームのループが速いとき（車輪を浮かせた等）に発振する。
  damper::State state;
  const auto p = params(0.14);
  damper::step(state, p, 60.0, 60.0, kDt);
  double worst = 0.0;
  for (int k = 0; k < 100; ++k) {
    const double measured = 60.0 + ((k % 2 == 0) ? 3.0 : -3.0);
    const double c = damper::step(state, p, 60.0, measured, kDt);
    if (k > 10) {
      worst = std::max(worst, std::abs(c));
    }
  }
  EXPECT_LT(worst, 0.5);
}

TEST(WheelRateDamper, SanitizeFallsBackToSafeValues) {
  damper::Params in;
  in.gain_sec = std::numeric_limits<double>::quiet_NaN();
  in.filter_tau_sec = -1.0;
  in.max_correction_rpm = std::numeric_limits<double>::infinity();
  const auto p = damper::sanitize(in);
  EXPECT_FALSE(damper::enabled(p));
  EXPECT_DOUBLE_EQ(p.filter_tau_sec, 0.08);
  EXPECT_DOUBLE_EQ(p.max_correction_rpm, 0.0);

  in.gain_sec = -0.1;
  EXPECT_FALSE(damper::enabled(damper::sanitize(in)));
}
