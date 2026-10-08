// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <algorithm>
#include <cmath>
#include <limits>

#include "motor_control_lib/wheel_velocity_damping.hpp"

namespace damp = motor_control_lib::wheel_velocity_damping;

namespace {
constexpr double kDt = 0.02;  // control_rate 50 Hz

damp::Params params(double gain_sec, double tau_sec = 0.03, double max_rpm = 10.0) {
  damp::Params p;
  p.gain_sec = gain_sec;
  p.filter_tau_sec = tau_sec;
  p.max_correction_rpm = max_rpm;
  return damp::sanitize(p);
}
}  // namespace

TEST(WheelVelocityDamping, SanitizeTurnsInvalidValuesOff) {
  damp::Params p;
  p.gain_sec = std::numeric_limits<double>::quiet_NaN();
  p.filter_tau_sec = -1.0;
  p.max_correction_rpm = -5.0;
  const auto s = damp::sanitize(p);
  EXPECT_DOUBLE_EQ(s.gain_sec, 0.0);
  EXPECT_DOUBLE_EQ(s.filter_tau_sec, 0.0);
  EXPECT_DOUBLE_EQ(s.max_correction_rpm, 0.0);
  EXPECT_FALSE(damp::enabled(s));
}

TEST(WheelVelocityDamping, DefaultParamsAreDisabled) {
  EXPECT_FALSE(damp::enabled(damp::Params{}));
  damp::State st;
  for (int i = 0; i < 20; ++i) {
    EXPECT_DOUBLE_EQ(damp::step(st, damp::Params{}, 10.0, (i % 2) ? 0.0 : 20.0, kDt), 0.0);
  }
  EXPECT_FALSE(st.initialized);
}

TEST(WheelVelocityDamping, FirstStepOnlyInitializes) {
  damp::State st;
  EXPECT_DOUBLE_EQ(damp::step(st, params(0.05), 10.0, 0.0, kDt), 0.0);
  EXPECT_TRUE(st.initialized);
  EXPECT_DOUBLE_EQ(st.prev_error, 10.0);
}

// 一定の誤差（加速ランプ中の追従遅れ・定常偏差）には補正を出さない。
TEST(WheelVelocityDamping, ConstantErrorGivesNoCorrection) {
  const auto p = params(0.05);
  damp::State st;
  double c = 0.0;
  for (int i = 0; i < 50; ++i) {
    const double ref = 100.0 + 5.7 * i;  // 286 RPM/s のランプ
    c = damp::step(st, p, ref, ref - 6.0, kDt);
  }
  EXPECT_NEAR(c, 0.0, 1e-9);
}

// 実測が上へ振れる（誤差が減る）と指令を下げ、下へ振れると上げる = ダンピングの向き。
TEST(WheelVelocityDamping, OpposesMeasuredSwing) {
  const auto p = params(0.05);
  damp::State st;
  damp::step(st, p, 10.0, 10.0, kDt);
  double up = 0.0;
  for (int i = 1; i <= 3; ++i) {
    up = damp::step(st, p, 10.0, 10.0 + 2.0 * i, kDt);  // 実測が加速中
  }
  EXPECT_LT(up, 0.0);

  damp::State st2;
  damp::step(st2, p, 10.0, 10.0, kDt);
  double down = 0.0;
  for (int i = 1; i <= 3; ++i) {
    down = damp::step(st2, p, 10.0, 10.0 - 2.0 * i, kDt);  // 実測が減速中
  }
  EXPECT_GT(down, 0.0);
  EXPECT_NEAR(up, -down, 1e-9);
}

// 一定勾配の誤差変化には gain · 勾配 に収束する（2 段ローパスの定常ゲイン 1）。
TEST(WheelVelocityDamping, SteadySlopeConvergesToGainTimesSlope) {
  const auto p = params(0.05, 0.03, 100.0);
  damp::State st;
  double c = 0.0;
  for (int i = 0; i < 200; ++i) {
    c = damp::step(st, p, 0.0, 0.1 * i, kDt);  // 誤差の勾配 = -5 RPM/s
  }
  EXPECT_NEAR(c, 0.05 * -5.0, 1e-6);
}

TEST(WheelVelocityDamping, CorrectionIsClamped) {
  const auto p = params(1.0, 0.0, 3.0);
  damp::State st;
  damp::step(st, p, 0.0, 0.0, kDt);
  EXPECT_DOUBLE_EQ(damp::step(st, p, 0.0, 100.0, kDt), -3.0);
  damp::State st2;
  damp::step(st2, p, 0.0, 0.0, kDt);
  EXPECT_DOUBLE_EQ(damp::step(st2, p, 0.0, -100.0, kDt), 3.0);
}

// 量子化 1 RPM の段差 1 回は、2 段ローパスで小さな補正にしかならない。
TEST(WheelVelocityDamping, SingleQuantizationStepStaysSmall) {
  const auto p = params(0.05);
  damp::State st;
  damp::step(st, p, 10.0, 10.0, kDt);
  double peak = 0.0;
  for (int i = 0; i < 20; ++i) {
    peak = std::max(peak, std::abs(damp::step(st, p, 10.0, 11.0, kDt)));
  }
  EXPECT_LT(peak, 0.5);
}

TEST(WheelVelocityDamping, ResetClearsState) {
  const auto p = params(0.05);
  damp::State st;
  damp::step(st, p, 10.0, 0.0, kDt);
  damp::step(st, p, 10.0, 5.0, kDt);
  EXPECT_NE(st.stage2, 0.0);
  damp::reset(st);
  EXPECT_FALSE(st.initialized);
  EXPECT_DOUBLE_EQ(st.stage1, 0.0);
  EXPECT_DOUBLE_EQ(st.stage2, 0.0);
  EXPECT_DOUBLE_EQ(damp::step(st, p, 10.0, 7.0, kDt), 0.0);
}

TEST(WheelVelocityDamping, InvalidDtResetsAndReturnsZero) {
  const auto p = params(0.05);
  damp::State st;
  damp::step(st, p, 10.0, 0.0, kDt);
  EXPECT_DOUBLE_EQ(damp::step(st, p, 10.0, 5.0, 0.0), 0.0);
  EXPECT_FALSE(st.initialized);
}
