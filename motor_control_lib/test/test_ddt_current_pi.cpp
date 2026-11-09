// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <cmath>
#include <cstdint>
#include <limits>

#include "motor_control_lib/ddt_current_pi.hpp"

namespace pi = motor_control_lib::ddt_current_pi;

namespace {

// 参照パラメータ: kp=0.005, ki=0.02, max_current_amp=2.0, integral_limit_amp=1.5,
// invert_measured=false、摩擦補償なし（明記がない限り）。
pi::Params refParams(double ki = 0.02, bool invert = false) {
  return pi::Params{/*kp=*/0.005, /*ki=*/ki, /*max_current_amp=*/2.0,
                    /*integral_limit_amp=*/1.5, /*invert_measured=*/invert};
}

int16_t rawOf(double amp) { return static_cast<int16_t>(std::lround(amp / 8.0 * 32767.0)); }

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

TEST(StepToRaw, IntegralIsKeptInAmps) {
  pi::State state;
  pi::Params params = refParams();
  int16_t raw1 = pi::stepToRaw(state, params, /*rpm_ref=*/100, /*measured_rpm=*/0, /*dt=*/0.01);
  int16_t raw2 = pi::stepToRaw(state, params, /*rpm_ref=*/100, /*measured_rpm=*/0, /*dt=*/0.01);
  EXPECT_GT(raw2, raw1);
  // 積分項は Ki を掛けた電流: 0.02 * 100 * 0.01 * 2 == 0.04 A
  EXPECT_NEAR(state.integral_amp, 0.04, 1e-12);
}

TEST(StepToRaw, KiChangeIsBumpless) {
  // 積分項を電流で持つので、Ki を変えても次の出力は飛ばない（誤差 0 なら積分項だけが出る）。
  pi::State state;
  pi::Params params = refParams();
  for (int i = 0; i < 5; ++i) {
    pi::stepToRaw(state, params, 100, 0, 0.01);
  }
  const double integral = state.integral_amp;
  ASSERT_NEAR(integral, 0.1, 1e-12);
  params.ki = 0.08;
  double i_cmd = 0.0;
  pi::stepToRaw(state, params, /*rpm_ref=*/100, /*measured_rpm=*/100, 0.01, &i_cmd);
  EXPECT_NEAR(i_cmd, integral, 1e-12);
}

TEST(StepToRaw, IntegralIsClampedAtItsLimit) {
  pi::State state;
  pi::Params params = refParams();
  params.kp = 0.0;  // 出力を飽和させず、積分の上限だけを見る
  int16_t raw = 0;
  for (int i = 0; i < 100; ++i) {
    raw = pi::stepToRaw(state, params, /*rpm_ref=*/1000, /*measured_rpm=*/0, /*dt=*/0.01);
  }
  EXPECT_DOUBLE_EQ(state.integral_amp, 1.5);
  EXPECT_EQ(raw, rawOf(1.5));
}

TEST(StepToRaw, NoIntegrationWhilePushingIntoTheLimit) {
  // P 項だけで上限（2 A）を超え、誤差がさらに押す向き: 積分は溜めない（条件付き積分）。
  pi::State state;
  pi::Params params = refParams();
  int16_t raw = 0;
  bool saturated = false;
  double i_cmd = 0.0;
  for (int i = 0; i < 100; ++i) {
    raw = pi::stepToRaw(state, params, /*rpm_ref=*/1000, /*measured_rpm=*/0, /*dt=*/0.01, &i_cmd,
                        &saturated);
  }
  EXPECT_DOUBLE_EQ(state.integral_amp, 0.0);
  EXPECT_EQ(raw, 8192);  // lround(2.0/8*32767)
  EXPECT_DOUBLE_EQ(i_cmd, 2.0);
  EXPECT_TRUE(saturated);
}

TEST(StepToRaw, OutputClampNegative) {
  pi::State state;
  pi::Params params = refParams();
  int16_t raw = 0;
  for (int i = 0; i < 100; ++i) {
    raw = pi::stepToRaw(state, params, /*rpm_ref=*/-1000, /*measured_rpm=*/0, /*dt=*/0.01);
  }
  EXPECT_DOUBLE_EQ(state.integral_amp, 0.0);
  EXPECT_EQ(raw, -8192);
}

TEST(StepToRaw, IntegrationResumesWhenTheErrorTurns) {
  // 飽和中でも、誤差が逆向き（飽和から抜ける向き）なら積分する。
  pi::State state;
  pi::Params params = refParams();
  params.kp = 0.0;
  for (int i = 0; i < 100; ++i) {
    pi::stepToRaw(state, params, 1000, 0, 0.01);
  }
  ASSERT_DOUBLE_EQ(state.integral_amp, 1.5);
  params.max_current_amp = 1.0;  // 積分項 1.5 A で上限 1 A に張り付いた状態
  bool saturated = false;
  double i_cmd = 0.0;
  pi::stepToRaw(state, params, /*rpm_ref=*/0, /*measured_rpm=*/100, 0.01, &i_cmd, &saturated);
  EXPECT_TRUE(saturated);
  EXPECT_DOUBLE_EQ(i_cmd, 1.0);
  EXPECT_NEAR(state.integral_amp, 1.5 - 0.02 * 100 * 0.01, 1e-12);
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
  params.kp = 0.0;
  for (int i = 0; i < 100; ++i) {
    pi::stepToRaw(state, params, /*rpm_ref=*/1000, /*measured_rpm=*/0, /*dt=*/0.01);
  }
  ASSERT_DOUBLE_EQ(state.integral_amp, 1.5);

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

TEST(StepToRaw, SaturatedIsFalseInsideTheLimit) {
  pi::State state;
  bool saturated = true;
  double i_cmd = 0.0;
  pi::stepToRaw(state, refParams(), 100, 0, 0.01, &i_cmd, &saturated);
  EXPECT_FALSE(saturated);
  EXPECT_NEAR(i_cmd, 0.005 * 100 + 0.02 * 100 * 0.01, 1e-12);
}

// ---- 摩擦補償 ------------------------------------------------------------------------

TEST(FrictionFeedforward, FollowsTheReferenceOnly) {
  pi::Params params = refParams();
  params.ff_static_amp = 0.1;
  params.ff_viscous_amp_per_rpm = 0.001;
  EXPECT_DOUBLE_EQ(pi::frictionFeedforwardAmp(0, params), 0.0);
  // |目標| < kFrictionFfFullRpm (10) では静止摩擦分を比例で立ち上げる
  EXPECT_NEAR(pi::frictionFeedforwardAmp(5, params), 0.05 + 0.005, 1e-12);
  EXPECT_NEAR(pi::frictionFeedforwardAmp(-5, params), -(0.05 + 0.005), 1e-12);
  EXPECT_NEAR(pi::frictionFeedforwardAmp(10, params), 0.1 + 0.01, 1e-12);
  EXPECT_NEAR(pi::frictionFeedforwardAmp(200, params), 0.1 + 0.2, 1e-12);
  EXPECT_NEAR(pi::frictionFeedforwardAmp(-200, params), -(0.1 + 0.2), 1e-12);
}

TEST(FrictionFeedforward, IsAddedToTheOutputAndDoesNotDependOnTheMeasurement) {
  pi::Params params = refParams(/*ki=*/0.0);
  params.kp = 0.0;
  params.ff_static_amp = 0.1;
  params.ff_viscous_amp_per_rpm = 0.001;
  for (int measured : {0, 100, -300}) {
    pi::State state;
    double i_cmd = 0.0;
    const int16_t raw = pi::stepToRaw(state, params, 100, measured, 0.01, &i_cmd);
    EXPECT_NEAR(i_cmd, 0.2, 1e-12);
    EXPECT_EQ(raw, rawOf(0.2));
  }
}

TEST(FrictionFeedforward, IsClampedWithTheRestOfTheOutput) {
  pi::Params params = refParams(/*ki=*/0.0);
  params.kp = 0.0;
  params.max_current_amp = 0.15;
  params.ff_static_amp = 0.1;
  params.ff_viscous_amp_per_rpm = 0.001;
  pi::State state;
  double i_cmd = 0.0;
  bool saturated = false;
  pi::stepToRaw(state, params, 100, 0, 0.01, &i_cmd, &saturated);
  EXPECT_DOUBLE_EQ(i_cmd, 0.15);
  EXPECT_TRUE(saturated);
}

TEST(AmpRaw, ConvertsAndClamps) {
  EXPECT_EQ(pi::ampToRaw(0.0), 0);
  EXPECT_EQ(pi::ampToRaw(8.0), 32767);
  EXPECT_EQ(pi::ampToRaw(-8.0), -32767);
  EXPECT_EQ(pi::ampToRaw(100.0), 32767);
  EXPECT_EQ(pi::ampToRaw(std::numeric_limits<double>::quiet_NaN()), 0);
  EXPECT_NEAR(pi::rawToAmp(pi::ampToRaw(0.5)), 0.5, 1e-3);
}

// ---- 暴走ガード ----------------------------------------------------------------------

namespace {

constexpr double kTick = 0.02;

pi::GuardSample sample(double t, int ref, double prev, double now, double applied, double commanded,
                       double max_amp = 1.0) {
  return pi::GuardSample{t, ref, prev, now, applied, commanded, max_amp};
}

}  // namespace

TEST(Guard, AcceleratingAgainstABrakingCurrentTrips) {
  // 正帰還の典型: PI の向きで実測が負に増え続けるのに、PI は正の電流（= 止める向き）を流す。
  pi::GuardState state;
  const pi::GuardParams params;
  int speed = -10;
  pi::GuardTrip trip = pi::GuardTrip::kNone;
  int steps = 0;
  while (trip == pi::GuardTrip::kNone && steps < 50) {
    const int next = speed - 8;
    trip = pi::updateGuard(state, params, sample(steps * kTick, 100, speed, next, 0.2, 0.25));
    speed = next;
    ++steps;
  }
  EXPECT_EQ(trip, pi::GuardTrip::kAccelAgainstCurrent);
  EXPECT_EQ(steps, 4);  // 8 rpm ずつ: 8, 16, 24, 32 >= 30
}

TEST(Guard, NoiseUnderABrakingCurrentDoesNotAccumulate) {
  pi::GuardState state;
  const pi::GuardParams params;
  for (int i = 0; i < 500; ++i) {
    const int prev = (i % 2 == 0) ? 40 : 43;
    const int now = (i % 2 == 0) ? 43 : 40;
    ASSERT_EQ(pi::updateGuard(state, params, sample(i * kTick, 30, prev, now, -0.2, -0.2)),
              pi::GuardTrip::kNone)
        << "at sample " << i;
  }
}

TEST(Guard, SlowingUnderABrakingCurrentIsNormal) {
  pi::GuardState state;
  const pi::GuardParams params;
  for (int i = 0; i < 40; ++i) {
    EXPECT_EQ(pi::updateGuard(state, params,
                              sample(i * kTick, 0, 300 - 5 * i, 300 - 5 * (i + 1), -1.0, -1.0)),
              pi::GuardTrip::kNone);
  }
}

TEST(Guard, AgainstCountResetsWhenTheCurrentFollowsTheMotion) {
  pi::GuardState state;
  const pi::GuardParams params;
  EXPECT_EQ(pi::updateGuard(state, params, sample(0.00, 0, 50, 75, -0.2, -0.2)),
            pi::GuardTrip::kNone);
  // 電流が回転と同じ向きになった（止める向きではない）: 数え直し
  EXPECT_EQ(pi::updateGuard(state, params, sample(0.02, 200, 75, 80, 0.2, 0.2)),
            pi::GuardTrip::kNone);
  EXPECT_EQ(pi::updateGuard(state, params, sample(0.04, 0, 80, 105, -0.2, -0.2)),
            pi::GuardTrip::kNone);
  EXPECT_EQ(pi::updateGuard(state, params, sample(0.06, 0, 105, 110, -0.2, -0.2)),
            pi::GuardTrip::kAccelAgainstCurrent);
}

TEST(Guard, TinyCurrentsAreNotJudged) {
  pi::GuardState state;
  const pi::GuardParams params;
  for (int i = 0; i < 20; ++i) {
    // 目標は十分大きく（目標超過の判定に掛からないように）
    EXPECT_EQ(pi::updateGuard(state, params,
                              sample(i * kTick, 1000, 20 + 10 * i, 30 + 10 * i, -0.01, -0.01)),
              pi::GuardTrip::kNone);
  }
}

TEST(Guard, AgainstThresholdFollowsASmallCurrentLimit) {
  // max_current_amp が小さい試験（0.06 A）でも判定できる（しきい値は上限の半分まで下がる）。
  pi::GuardState state;
  const pi::GuardParams params;
  pi::GuardTrip trip = pi::GuardTrip::kNone;
  for (int i = 0; i < 4 && trip == pi::GuardTrip::kNone; ++i) {
    trip = pi::updateGuard(state, params,
                           sample(i * kTick, 0, 20 + 10 * i, 30 + 10 * i, -0.04, -0.04, 0.06));
  }
  EXPECT_EQ(trip, pi::GuardTrip::kAccelAgainstCurrent);
}

TEST(Guard, OverspeedTripsAfterTheConfiguredTime) {
  pi::GuardState state;
  const pi::GuardParams params{/*margin=*/50.0, /*time=*/0.3};
  // 目標 100 に対して 160 のまま（電流は止める向きでも減速しない = 外力・過補償）
  pi::GuardTrip trip = pi::GuardTrip::kNone;
  int i = 0;
  for (; i < 30 && trip == pi::GuardTrip::kNone; ++i) {
    trip = pi::updateGuard(state, params, sample(i * kTick, 100, 160, 160, 0.0, 0.0));
  }
  EXPECT_EQ(trip, pi::GuardTrip::kOverspeed);
  EXPECT_EQ(i - 1, 15);  // 0.3 s / 0.02 s
}

TEST(Guard, OverspeedWhileSlowingDoesNotTrip) {
  // 急な減速指令で目標に追いつく途中（減速している）は作動しない。
  pi::GuardState state;
  const pi::GuardParams params{50.0, 0.3};
  for (int i = 0; i < 60; ++i) {
    const int speed = 400 - 4 * i;
    EXPECT_EQ(pi::updateGuard(state, params, sample(i * kTick, 0, speed + 4, speed, -1.0, -1.0)),
              pi::GuardTrip::kNone)
        << "at sample " << i;
  }
}

TEST(Guard, OverspeedWindowRestartsWhenBackWithinTheMargin) {
  pi::GuardState state;
  const pi::GuardParams params{50.0, 0.3};
  for (int i = 0; i < 10; ++i) {
    EXPECT_EQ(pi::updateGuard(state, params, sample(i * kTick, 100, 160, 160, 0.0, 0.0)),
              pi::GuardTrip::kNone);
  }
  EXPECT_EQ(pi::updateGuard(state, params, sample(0.2, 100, 160, 120, 0.0, 0.0)),
            pi::GuardTrip::kNone);
  for (int i = 0; i < 10; ++i) {
    EXPECT_EQ(pi::updateGuard(state, params, sample(0.22 + i * kTick, 100, 160, 160, 0.0, 0.0)),
              pi::GuardTrip::kNone);
  }
}

TEST(Guard, CurrentFlippingBetweenTheLimitsTrips) {
  pi::GuardState state;
  const pi::GuardParams params;
  const double cmds[] = {1.0, 1.0, -1.0, -0.97, 1.0, -1.0};
  pi::GuardTrip trip = pi::GuardTrip::kNone;
  int i = 0;
  for (; i < 6 && trip == pi::GuardTrip::kNone; ++i) {
    trip = pi::updateGuard(state, params, sample(i * kTick, 100, 100, 100, 0.0, cmds[i]));
  }
  EXPECT_EQ(trip, pi::GuardTrip::kOscillation);
  EXPECT_EQ(i, 6);  // +, -, +, - の 4 つ目
}

TEST(Guard, SlowReversalsAtTheLimitAreNotOscillation) {
  // 張り付いたままの加速や、0.5 s より間の空いた反転は発振ではない。
  pi::GuardState state;
  const pi::GuardParams params;
  double t = 0.0;
  for (int k = 0; k < 8; ++k) {
    const double cmd = (k % 2 == 0) ? 1.0 : -1.0;
    for (int i = 0; i < 20; ++i) {  // 0.4 s ずつ張り付く
      EXPECT_EQ(pi::updateGuard(state, params, sample(t, 100, 100, 100, 0.0, cmd)),
                pi::GuardTrip::kNone);
      t += kTick;
    }
  }
}

TEST(Guard, TripNames) {
  EXPECT_STREQ(pi::guardTripName(pi::GuardTrip::kNone), "none");
  EXPECT_STREQ(pi::guardTripName(pi::GuardTrip::kAccelAgainstCurrent), "against");
  EXPECT_STREQ(pi::guardTripName(pi::GuardTrip::kOverspeed), "overspeed");
  EXPECT_STREQ(pi::guardTripName(pi::GuardTrip::kOscillation), "oscillation");
}
