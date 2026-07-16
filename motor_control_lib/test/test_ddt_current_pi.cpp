// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <cstdint>
#include <limits>

#include "motor_control_lib/ddt_current_pi.hpp"

namespace pi = motor_control_lib::ddt_current_pi;

namespace {

// 参照パラメータ: kp=0.005, ki=0.02, max_current_amp=2.0, integral_limit_amp=1.5,
// invert_measured=false（明記がない限り）。
pi::Params refParams(double ki = 0.02, bool invert = false) {
  return pi::Params{/*kp=*/0.005, /*ki=*/ki, /*max_current_amp=*/2.0,
                    /*integral_limit_amp=*/1.5, /*invert_measured=*/invert};
}

}  // namespace

TEST(StepToRaw, ProportionalTerm) {
  // ki=0.0 → 積分項は 0 に強制される (ki<=1e-9 分岐)。
  pi::State state;
  pi::Params params = refParams(/*ki=*/0.0);
  int16_t raw = pi::stepToRaw(state, params, /*rpm_ref=*/100, /*measured_rpm=*/0, /*dt=*/0.01);
  EXPECT_EQ(state.integral_amp, 0.0);
  // lround(0.005*100/8.0*32767) == lround(0.5/8*32767) == 2048
  EXPECT_EQ(raw, 2048);
}

TEST(StepToRaw, IntegralAccumulates) {
  pi::State state;
  pi::Params params = refParams();
  int16_t raw1 = pi::stepToRaw(state, params, /*rpm_ref=*/100, /*measured_rpm=*/0, /*dt=*/0.01);
  int16_t raw2 = pi::stepToRaw(state, params, /*rpm_ref=*/100, /*measured_rpm=*/0, /*dt=*/0.01);
  EXPECT_GT(raw2, raw1);
  // クランプ未達なので integral == error*dt*2 == 100*0.01*2 == 2.0
  EXPECT_NEAR(state.integral_amp, 2.0, 1e-9);
}

TEST(StepToRaw, AntiWindup) {
  pi::State state;
  pi::Params params = refParams();
  int16_t raw = 0;
  for (int i = 0; i < 100; ++i) {
    raw = pi::stepToRaw(state, params, /*rpm_ref=*/1000, /*measured_rpm=*/0, /*dt=*/0.01);
  }
  // integral は integral_limit_amp/ki == 1.5/0.02 == 75.0 でクランプ。
  EXPECT_DOUBLE_EQ(state.integral_amp, 75.0);
  // 出力は max_current_amp=2.0 でクランプ: lround(2.0/8*32767) == 8192
  EXPECT_EQ(raw, 8192);
}

TEST(StepToRaw, OutputClampNegative) {
  pi::State state;
  pi::Params params = refParams();
  int16_t raw = 0;
  for (int i = 0; i < 100; ++i) {
    raw = pi::stepToRaw(state, params, /*rpm_ref=*/-1000, /*measured_rpm=*/0, /*dt=*/0.01);
  }
  EXPECT_DOUBLE_EQ(state.integral_amp, -75.0);
  EXPECT_EQ(raw, -8192);
}

TEST(StepToRaw, InvertMeasured) {
  // invert=false: ref=0, measured=100 → error<0 → raw 負。
  pi::State state_no;
  int16_t raw_no = pi::stepToRaw(state_no, refParams(/*ki=*/0.02, /*invert=*/false), 0, 100, 0.01);
  EXPECT_LT(raw_no, 0);

  // invert=true: measured を反転して error>0 → raw 正、大きさは同じ。
  pi::State state_inv;
  int16_t raw_inv = pi::stepToRaw(state_inv, refParams(/*ki=*/0.02, /*invert=*/true), 0, 100, 0.01);
  EXPECT_GT(raw_inv, 0);
  EXPECT_EQ(raw_inv, -raw_no);
}

TEST(SanitizeDt, ClipsAbnormalValues) {
  EXPECT_DOUBLE_EQ(pi::sanitizeDt(0.0), 0.01);
  EXPECT_DOUBLE_EQ(pi::sanitizeDt(-1.0), 0.01);
  EXPECT_DOUBLE_EQ(pi::sanitizeDt(0.25), 0.01);
  EXPECT_DOUBLE_EQ(pi::sanitizeDt(0.05), 0.05);
  EXPECT_DOUBLE_EQ(pi::sanitizeDt(0.2), 0.2);  // 境界は保持
  EXPECT_DOUBLE_EQ(pi::sanitizeDt(std::numeric_limits<double>::quiet_NaN()), 0.01);
  EXPECT_DOUBLE_EQ(pi::sanitizeDt(std::numeric_limits<double>::infinity()), 0.01);
  EXPECT_DOUBLE_EQ(pi::sanitizeDt(-std::numeric_limits<double>::infinity()), 0.01);
}

TEST(InZeroDeadband, Boundaries) {
  EXPECT_TRUE(pi::inZeroDeadband(0, 3, 5));
  EXPECT_TRUE(pi::inZeroDeadband(0, 5, 5));
  EXPECT_FALSE(pi::inZeroDeadband(0, 6, 5));
  EXPECT_FALSE(pi::inZeroDeadband(1, 0, 5));
  EXPECT_TRUE(pi::inZeroDeadband(0, -5, 5));
  EXPECT_TRUE(pi::inZeroDeadband(0, 0, 0));
}

TEST(StepToRaw, ResetClearsWindup) {
  pi::State state;
  pi::Params params = refParams();
  for (int i = 0; i < 100; ++i) {
    pi::stepToRaw(state, params, /*rpm_ref=*/1000, /*measured_rpm=*/0, /*dt=*/0.01);
  }
  ASSERT_DOUBLE_EQ(state.integral_amp, 75.0);

  // リセット。
  state = {};

  int16_t raw_after =
      pi::stepToRaw(state, params, /*rpm_ref=*/100, /*measured_rpm=*/0, /*dt=*/0.01);

  pi::State fresh;
  int16_t raw_fresh =
      pi::stepToRaw(fresh, params, /*rpm_ref=*/100, /*measured_rpm=*/0, /*dt=*/0.01);

  EXPECT_EQ(raw_after, raw_fresh);
  EXPECT_DOUBLE_EQ(state.integral_amp, fresh.integral_amp);
}

TEST(StepToRaw, ICmdAmpOut) {
  pi::State state;
  pi::Params params = refParams();
  double i_cmd_amp = 0.0;
  for (int i = 0; i < 100; ++i) {
    pi::stepToRaw(state, params, /*rpm_ref=*/1000, /*measured_rpm=*/0, /*dt=*/0.01, &i_cmd_amp);
  }
  // アンチワインドアップ飽和状態ではクランプ後の電流指令は max_current_amp=2.0。
  EXPECT_DOUBLE_EQ(i_cmd_amp, 2.0);
}
