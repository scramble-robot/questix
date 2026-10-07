// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// wheel_lag_assist（velocity モードの遅れ上乗せ・行き過ぎ差し引き）の単体テスト。
// 制御コアへの組み込みは motor_control_app/test/test_control_core.cpp の ControlCoreLagAssist*。
#include <gtest/gtest.h>

#include <limits>

#include "motor_control_lib/wheel_lag_assist.hpp"

namespace assist = motor_control_lib::wheel_lag_assist;

namespace {

constexpr double kDt = 0.02;
constexpr double kLoadedAmp = 2.0;
constexpr double kLiftedAmp = 0.2;

assist::Params params(double gain, double overshoot_gain) {
  assist::Params p;
  p.gain = gain;
  p.overshoot_gain = overshoot_gain;
  p.deadband_rpm = 3.0;
  p.model_tau_sec = 0.06;
  p.max_rpm = 15.0;
  return assist::sanitize(p);
}

// 本来の応答 m を目標に収束させてから 1 tick 進めた補正を返す
double settledStep(const assist::Params& p, double ref, double measured, double amp) {
  assist::State state;
  assist::step(state, p, ref, ref, amp, kDt);
  for (int k = 0; k < 100; ++k) {
    assist::step(state, p, ref, ref, amp, kDt);
  }
  return assist::step(state, p, ref, measured, amp, kDt);
}

}  // namespace

TEST(WheelLagAssist, DisabledAlwaysReturnsZero) {
  const auto p = params(0.0, 0.0);
  EXPECT_FALSE(assist::enabled(p));
  EXPECT_DOUBLE_EQ(settledStep(p, 15.0, 0.0, kLoadedAmp), 0.0);
  EXPECT_DOUBLE_EQ(settledStep(p, 15.0, 40.0, kLoadedAmp), 0.0);
}

TEST(WheelLagAssist, FirstStepAfterResetIsBumpless) {
  assist::State state;
  const auto p = params(1.0, 1.0);
  EXPECT_DOUBLE_EQ(assist::step(state, p, 40.0, 0.0, kLoadedAmp, kDt), 0.0);
  EXPECT_TRUE(state.initialized);
  EXPECT_DOUBLE_EQ(state.model_rpm, 0.0);
}

TEST(WheelLagAssist, AddsWhenLaggingAndSubtractsWhenAhead) {
  const auto p = params(1.0, 0.5);
  // 遅れ 15 → (15 - 3) * 1.0 = 12 を上乗せ
  EXPECT_NEAR(settledStep(p, 15.0, 0.0, kLoadedAmp), 12.0, 1e-6);
  // 行き過ぎ 13 → (13 - 3) * 0.5 = 5 を差し引き
  EXPECT_NEAR(settledStep(p, 15.0, 28.0, kLoadedAmp), -5.0, 1e-6);
  // 後退でも進行方向に見て同じ（符号が反転）
  EXPECT_NEAR(settledStep(p, -15.0, 0.0, kLoadedAmp), -12.0, 1e-6);
  EXPECT_NEAR(settledStep(p, -15.0, -28.0, kLoadedAmp), 5.0, 1e-6);
}

TEST(WheelLagAssist, DeadbandIgnoresSmallErrors) {
  const auto p = params(1.0, 1.0);
  EXPECT_DOUBLE_EQ(settledStep(p, 15.0, 13.0, kLoadedAmp), 0.0);
  EXPECT_DOUBLE_EQ(settledStep(p, 15.0, 17.0, kLoadedAmp), 0.0);
}

TEST(WheelLagAssist, EachSideIsClamped) {
  const auto p = params(3.0, 3.0);
  EXPECT_DOUBLE_EQ(settledStep(p, 40.0, 0.0, kLoadedAmp), 15.0);
  EXPECT_DOUBLE_EQ(settledStep(p, 40.0, 100.0, kLoadedAmp), -15.0);
}

TEST(WheelLagAssist, NormalTrackingLagIsNotBoosted) {
  // 実測が本来の応答（一次遅れ 60 ms）どおりに追いつくなら、目標の段差でも上乗せしない
  const auto p = params(1.0, 1.0);
  assist::State state;
  double plant = 0.0;
  assist::step(state, p, 0.0, plant, kLoadedAmp, kDt);
  for (int k = 0; k < 100; ++k) {
    const double ref = 40.0;
    plant += kDt / (0.06 + kDt) * (ref - plant);
    EXPECT_DOUBLE_EQ(assist::step(state, p, ref, plant, kLoadedAmp, kDt), 0.0) << k;
  }
}

TEST(WheelLagAssist, LoadGateCutsTheAssistWhenLifted) {
  const auto p = params(1.0, 1.0);
  EXPECT_DOUBLE_EQ(settledStep(p, 15.0, 0.0, kLiftedAmp), 0.0);
  EXPECT_NEAR(settledStep(p, 15.0, 0.0, kLoadedAmp), 12.0, 1e-6);
}

TEST(WheelLagAssist, SanitizeFallsBackToSafeValues) {
  assist::Params in;
  in.gain = std::numeric_limits<double>::quiet_NaN();
  in.overshoot_gain = -1.0;
  in.max_rpm = std::numeric_limits<double>::infinity();
  in.deadband_rpm = -2.0;
  const auto p = assist::sanitize(in);
  EXPECT_FALSE(assist::enabled(p));
  EXPECT_DOUBLE_EQ(p.max_rpm, 0.0);
  EXPECT_DOUBLE_EQ(p.deadband_rpm, 3.0);
}
