// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <cmath>
#include <random>
#include <vector>

#include "motor_control_lib/wheel_observer.hpp"

namespace obs = motor_control_lib::wheel_observer;

namespace {
// 一次遅れ + むだ時間のプラント（整数量子化付き）。テスト用。
class Plant {
public:
  Plant(double a, double b, int delay, double disturbance)
      : a_(a), b_(b), delay_(delay), d_(disturbance) {}
  int step(double u) {
    const double u_delayed = hist_[delay_];
    for (int i = obs::kMaxDelayTicks; i > 0; --i) hist_[i] = hist_[i - 1];
    hist_[0] = u;
    x_ = a_ * x_ + b_ * u_delayed + d_;
    return static_cast<int>(std::lround(x_));
  }
  double truth() const { return x_; }

private:
  double a_, b_;
  int delay_;
  double d_;
  double x_{0.0};
  std::array<double, obs::kMaxDelayTicks + 1> hist_{};
};
}  // namespace

TEST(WheelObserver, SanitizeClampsInvalidValues) {
  obs::Params p;
  p.a = 1.5;
  p.b = 0.0;
  p.l_x = 2.0;
  p.l_d = -1.0;
  p.delay_ticks = 99;
  const auto s = obs::sanitize(p);
  EXPECT_DOUBLE_EQ(s.a, 0.999);
  EXPECT_NEAR(s.b, 1.0 - 0.999, 1e-12);
  EXPECT_DOUBLE_EQ(s.l_x, 1.0);
  EXPECT_DOUBLE_EQ(s.l_d, 0.0);
  EXPECT_EQ(s.delay_ticks, obs::kMaxDelayTicks);
}

TEST(WheelObserver, ResetTakesMeasurement) {
  obs::State st;
  obs::reset(st, 123.0);
  EXPECT_TRUE(st.initialized);
  EXPECT_DOUBLE_EQ(st.x_hat, 123.0);
  EXPECT_DOUBLE_EQ(st.x_prior, 123.0);
  EXPECT_DOUBLE_EQ(st.d_hat, 0.0);
}

TEST(WheelObserver, LxOneReproducesMeasurement) {
  // l_x = 1 なら補正後推定値は実測そのもの
  obs::Params p = obs::sanitize({0.8, 0.2, 1.0, 0.0, 0});
  obs::State st;
  for (int k = 0; k < 20; ++k) {
    const double y = 10.0 * k;
    EXPECT_DOUBLE_EQ(obs::step(st, p, y, 100.0), y);
  }
}

TEST(WheelObserver, TracksPlantWithDelayAndQuantization) {
  // プラントと同じモデル + 正しいむだ時間なら、ステップ応答を量子化より良い精度で追従する
  const double a = std::exp(-0.02 / 0.1);
  Plant plant(a, 1.0 - a, 1, 0.0);
  obs::Params p = obs::sanitize({a, 1.0 - a, 0.3, 0.0, 1});
  obs::State st;
  double max_err = 0.0;
  for (int k = 0; k < 200; ++k) {
    const double u = (k < 100) ? 200.0 : 50.0;
    const int y = plant.step(u);
    const double x_hat = obs::step(st, p, static_cast<double>(y), u);
    if (k > 5) max_err = std::max(max_err, std::abs(x_hat - plant.truth()));
  }
  EXPECT_LT(max_err, 0.6);  // 量子化 1 RPM より小さい
}

TEST(WheelObserver, DisturbanceEstimateConvergesToConstantOffset) {
  // プラントに一定外乱 d を入れ、l_d > 0 なら d̂ が d に収束し、推定値の定常誤差が消える
  const double a = 0.8;
  const double d_true = -12.0;
  Plant plant(a, 1.0 - a, 0, d_true);
  obs::Params p = obs::sanitize({a, 1.0 - a, 0.4, 0.05, 0});
  obs::State st;
  double x_hat = 0.0;
  for (int k = 0; k < 600; ++k) {
    const int y = plant.step(150.0);
    x_hat = obs::step(st, p, static_cast<double>(y), 150.0);
  }
  EXPECT_NEAR(st.d_hat, d_true, 1.0);
  EXPECT_NEAR(x_hat, plant.truth(), 1.0);
}

TEST(WheelObserver, NoiseIsAttenuatedComparedToRawMeasurement) {
  // 定常状態で白色ノイズを載せた実測に対し、推定値のばらつきが生値より小さい
  const double a = 0.8;
  obs::Params p = obs::sanitize({a, 1.0 - a, 0.3, 0.0, 0});
  obs::State st;
  std::mt19937 rng(42);
  std::normal_distribution<double> noise(0.0, 10.0);
  double sum_raw = 0.0, sum_hat = 0.0;
  int n = 0;
  for (int k = 0; k < 2000; ++k) {
    const double y = 100.0 + std::round(noise(rng));
    const double x_hat = obs::step(st, p, y, 100.0);
    if (k > 100) {
      sum_raw += (y - 100.0) * (y - 100.0);
      sum_hat += (x_hat - 100.0) * (x_hat - 100.0);
      ++n;
    }
  }
  EXPECT_LT(std::sqrt(sum_hat / n), 0.6 * std::sqrt(sum_raw / n));
}
