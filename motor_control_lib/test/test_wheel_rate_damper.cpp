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
constexpr double kLoadedAmp = 2.0;  // 床の上の電流（実測 0.48〜2.1 A）
constexpr double kLiftedAmp = 0.2;  // 車輪を浮かせた電流（実測 0.13〜0.25 A）

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
    EXPECT_DOUBLE_EQ(damper::step(state, p, 60.0, 60.0 + 20.0 * std::sin(k * 0.5), kLoadedAmp, kDt),
                     0.0);
  }
}

TEST(WheelRateDamper, FirstStepAfterResetIsBumpless) {
  damper::State state;
  const auto p = params(0.08);
  // 大きな追従誤差があっても、最初の tick は状態を初期化するだけで補正 0
  EXPECT_DOUBLE_EQ(damper::step(state, p, 100.0, 40.0, kLoadedAmp, kDt), 0.0);
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
    c = damper::step(state, p, 60.0, 55.0, kLoadedAmp, kDt);
  }
  EXPECT_NEAR(c, 0.0, 1e-9);
}

TEST(WheelRateDamper, OpposesTheMeasuredSwing) {
  damper::State state;
  const auto p = params(0.08);
  damper::step(state, p, 60.0, 60.0, kLoadedAmp, kDt);
  double c = 0.0;
  for (int k = 1; k <= 5; ++k) {
    c = damper::step(state, p, 60.0, 60.0 + 4.0 * k, kLoadedAmp,
                     kDt);  // 実測が目標より速くなっていく
  }
  EXPECT_LT(c, 0.0);
  for (int k = 1; k <= 10; ++k) {
    c = damper::step(state, p, 60.0, 80.0 - 4.0 * k, kLoadedAmp, kDt);  // 速すぎた分が戻っていく
  }
  EXPECT_GT(c, 0.0);
}

TEST(WheelRateDamper, CorrectionIsClamped) {
  damper::State state;
  auto p = params(0.3);
  p.max_correction_rpm = 5.0;
  damper::step(state, p, 60.0, 60.0, kLoadedAmp, kDt);
  for (int k = 0; k < 5; ++k) {
    const double c = damper::step(state, p, 60.0, 200.0, kLoadedAmp, kDt);
    EXPECT_LE(std::abs(c), 5.0);
  }
}

TEST(WheelRateDamper, NyquistAlternationIsAveragedOut) {
  // tick ごとに交互に振れる成分（ナイキスト 25 Hz）は 2 サンプル平均で消え、補正に乗らない。
  // これに反応すると、ファームのループが速いとき（車輪を浮かせた等）に発振する。
  damper::State state;
  const auto p = params(0.14);
  damper::step(state, p, 60.0, 60.0, kLoadedAmp, kDt);
  double worst = 0.0;
  for (int k = 0; k < 100; ++k) {
    const double measured = 60.0 + ((k % 2 == 0) ? 3.0 : -3.0);
    const double c = damper::step(state, p, 60.0, measured, kLoadedAmp, kDt);
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

TEST(WheelRateDamper, LoadGateCutsTheCorrectionWhenLifted) {
  // 車輪を浮かせた電流（0.2 A）では、同じ揺れでも補正 0（浮かせると補正自体が振動を作るため）
  const auto p = params(0.12);
  damper::State lifted;
  damper::State loaded;
  damper::step(lifted, p, 60.0, 60.0, kLiftedAmp, kDt);
  damper::step(loaded, p, 60.0, 60.0, kLoadedAmp, kDt);
  double c_lifted = 0.0;
  double c_loaded = 0.0;
  for (int k = 1; k <= 5; ++k) {
    c_lifted = damper::step(lifted, p, 60.0, 60.0 + 4.0 * k, kLiftedAmp, kDt);
    c_loaded = damper::step(loaded, p, 60.0, 60.0 + 4.0 * k, kLoadedAmp, kDt);
  }
  EXPECT_DOUBLE_EQ(c_lifted, 0.0);
  EXPECT_DOUBLE_EQ(lifted.load_scale, 0.0);
  EXPECT_LT(c_loaded, 0.0);
  EXPECT_DOUBLE_EQ(loaded.load_scale, 1.0);
}

TEST(WheelRateDamper, LoadGateFadesOutAfterLifting) {
  // 床（2 A）から浮かせる（0.2 A）と、平滑化（0.3 s）を経て 1 s 以内に補正が抜ける
  const auto p = params(0.12);
  damper::State state;
  damper::step(state, p, 60.0, 60.0, kLoadedAmp, kDt);
  for (int k = 0; k < 100; ++k) {
    damper::step(state, p, 60.0, 60.0, kLoadedAmp, kDt);
  }
  EXPECT_DOUBLE_EQ(state.load_scale, 1.0);
  int ticks_to_zero = -1;
  for (int k = 0; k < 200; ++k) {
    damper::step(state, p, 60.0, 60.0, kLiftedAmp, kDt);
    if (state.load_scale == 0.0) {
      ticks_to_zero = k + 1;
      break;
    }
  }
  ASSERT_GT(ticks_to_zero, 0);
  EXPECT_LT(ticks_to_zero * kDt, 1.0);
}

TEST(WheelRateDamper, LoadScaleIsLinearBetweenTheThresholds) {
  auto p = params(0.12);
  EXPECT_DOUBLE_EQ(damper::loadScale(p, 0.3), 0.0);
  EXPECT_DOUBLE_EQ(damper::loadScale(p, 0.45), 0.5);
  EXPECT_DOUBLE_EQ(damper::loadScale(p, 0.6), 1.0);
  p.load_on_amp = 0.0;  // ゲート無効: 電流によらず全量
  p = damper::sanitize(p);
  EXPECT_FALSE(damper::loadGateEnabled(p));
  EXPECT_DOUBLE_EQ(damper::loadScale(p, 0.0), 1.0);
}
