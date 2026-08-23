// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <cmath>

#include "motor_control_lib/wheel_observer.hpp"
#include "motor_control_lib/wheel_velocity_lqr.hpp"

namespace lqr = motor_control_lib::wheel_velocity_lqr;
namespace obs = motor_control_lib::wheel_observer;

namespace {
constexpr double kDt = 0.02;
lqr::Params params(double tau, double q, double r) {
  lqr::Params p;
  p.a = std::exp(-kDt / tau);
  p.b = 0.0;  // 1 - a
  p.q = q;
  p.r = r;
  p.max_correction_rpm = 50.0;
  return lqr::sanitize(p);
}
}  // namespace

TEST(WheelVelocityLqr, ZeroQGivesZeroGain) {
  const auto g = lqr::computeGains(params(0.1, 0.0, 1.0));
  ASSERT_TRUE(g.has_value());
  EXPECT_DOUBLE_EQ(g->k, 0.0);
}

TEST(WheelVelocityLqr, GainSatisfiesRiccatiAndIsStabilizing) {
  const auto p = params(0.1, 1.0, 0.5);
  const auto g = lqr::computeGains(p);
  ASSERT_TRUE(g.has_value());
  // リカッチ方程式の残差
  const double P = g->p;
  const double rhs = p.q + p.a * p.a * P - std::pow(p.a * p.b * P, 2) / (p.r + p.b * p.b * P);
  EXPECT_NEAR(P, rhs, 1e-8);
  // K = a b P / (r + b^2 P)
  EXPECT_NEAR(g->k, p.a * p.b * P / (p.r + p.b * p.b * P), 1e-12);
  // 閉ループ極 |a - bK| < 1
  EXPECT_LT(std::abs(p.a - p.b * g->k), 1.0);
  EXPECT_GT(g->k, 0.0);
}

TEST(WheelVelocityLqr, GainMatchesPythonReference) {
  // mpc_study/controllers.py と同じ反復式でオフライン計算した値（a=exp(-0.02/0.1), b=1-a,
  // q=1, r=1）。式の単一ソースは本ヘッダだが、回帰検出のために数値を固定する。
  const auto p = params(0.1, 1.0, 1.0);
  const auto g = lqr::computeGains(p);
  ASSERT_TRUE(g.has_value());
  // 手計算: P は P = 1 + a^2 P - (abP)^2/(1+b^2 P) の正根
  double P = 1.0;
  for (int i = 0; i < 100000; ++i) {
    P = 1.0 + p.a * p.a * P - std::pow(p.a * p.b * P, 2) / (1.0 + p.b * p.b * P);
  }
  EXPECT_NEAR(g->p, P, 1e-6);
}

TEST(WheelVelocityLqr, DefaultsReproduceReferenceExactly) {
  // q=0, lead=0, disturbance=0 -> u = ref（従来の「目標 RPM をそのまま送る」と一致）
  lqr::Params p;
  p.a = 0.8;
  p.max_correction_rpm = 30.0;
  p = lqr::sanitize(p);
  const auto g = lqr::computeGains(p);
  ASSERT_TRUE(g.has_value());
  lqr::State st;
  for (double ref : {0.0, 50.0, 120.0, -80.0}) {
    EXPECT_DOUBLE_EQ(lqr::step(st, p, *g, ref, ref + 25.0, 7.0), ref);
  }
}

TEST(WheelVelocityLqr, CorrectionIsClamped) {
  auto p = params(0.1, 10.0, 0.01);
  p.max_correction_rpm = 10.0;
  const auto g = lqr::computeGains(p);
  ASSERT_TRUE(g.has_value());
  lqr::State st;
  // 大きな誤差でも補正は ±10 RPM まで
  EXPECT_DOUBLE_EQ(lqr::step(st, p, *g, 100.0, 300.0, 0.0), 90.0);
  EXPECT_DOUBLE_EQ(lqr::step(st, p, *g, 100.0, -300.0, 0.0), 110.0);
}

TEST(WheelVelocityLqr, LeadTermAnticipatesReferenceChange) {
  auto p = params(0.1, 0.0, 1.0);
  p.lead_gain = 1.0;
  const auto g = lqr::computeGains(p);
  ASSERT_TRUE(g.has_value());
  lqr::State st;
  EXPECT_DOUBLE_EQ(lqr::step(st, p, *g, 100.0, 100.0, 0.0), 100.0);  // 初回は差分なし
  // 参照が +10 変化 -> 先回り分 10/b を上乗せ（クランプ 50 以内）
  const double u = lqr::step(st, p, *g, 110.0, 100.0, 0.0);
  EXPECT_NEAR(u, 110.0 + std::min(10.0 / p.b, 50.0), 1e-9);
  // 参照が一定に戻れば先回りは消える
  EXPECT_DOUBLE_EQ(lqr::step(st, p, *g, 110.0, 110.0, 0.0), 110.0);
}

TEST(WheelVelocityLqr, DisturbanceTermCancelsSteadyStateOffsetInClosedLoop) {
  // 一次遅れプラント + 一定外乱。オブザーバの d̂ を使った補償で定常偏差が消えることを
  // 閉ループで確認する。
  const double tau = 0.1;
  const double a = std::exp(-kDt / tau);
  const double b = 1.0 - a;
  const double d_true = -8.0;  // 目標より 8 RPM 低く出る（負荷）

  auto p = params(tau, 0.5, 1.0);
  p.disturbance_gain = 1.0;
  const auto g = lqr::computeGains(p);
  ASSERT_TRUE(g.has_value());
  obs::Params op = obs::sanitize({a, b, 0.4, 0.05, 0});

  auto run = [&](bool compensate) {
    lqr::State ls;
    obs::State os;
    double x = 0.0;
    double u = 0.0;
    for (int k = 0; k < 500; ++k) {
      const int y = static_cast<int>(std::lround(x));
      const double x_hat = obs::step(os, op, y, u);
      const double d_hat = compensate ? os.d_hat : 0.0;
      lqr::Params pp = p;
      if (!compensate) pp.disturbance_gain = 0.0;
      u = lqr::step(ls, pp, *g, 200.0, x_hat, d_hat);
      x = a * x + b * u + d_true;
    }
    return x;
  };
  const double x_without = run(false);
  const double x_with = run(true);
  // FB だけでは定常偏差 d/(b(1+K)) が残る（d は 1 tick あたりの外乱なので b で割った大きさ）
  EXPECT_NEAR(x_without - 200.0, d_true / (b * (1.0 + g->k)), 0.5);
  EXPECT_GT(std::abs(x_without - 200.0), 1.0);
  EXPECT_NEAR(x_with, 200.0, 0.5);  // 外乱補償で消える
}
