// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include "motor_control_app/drive_slew.hpp"

namespace slew = motor_control_app::drive_slew;

TEST(NormalizeDt, NoLastCommandUsesMaxDt) {
  // リセット直後は last_cmd_* = 0 から kMaxDtSec 分のランプを許す
  EXPECT_DOUBLE_EQ(slew::normalizeDt(false, 0.0), slew::kMaxDtSec);
  EXPECT_DOUBLE_EQ(slew::normalizeDt(false, 5.0), slew::kMaxDtSec);
}

TEST(NormalizeDt, ClampsIntoValidRange) {
  EXPECT_DOUBLE_EQ(slew::normalizeDt(true, 0.05), 0.05);
  // 時計逆行・同時刻は下限にクランプ
  EXPECT_DOUBLE_EQ(slew::normalizeDt(true, 0.0), slew::kMinDtSec);
  EXPECT_DOUBLE_EQ(slew::normalizeDt(true, -1.0), slew::kMinDtSec);
  // 長い空白後も上限にクランプ（以前は dt >= 1.0 で制限自体が無効化されていた）
  EXPECT_DOUBLE_EQ(slew::normalizeDt(true, 2.0), slew::kMaxDtSec);
}

TEST(ClampRate, PassesThroughWhenDisabled) {
  EXPECT_DOUBLE_EQ(slew::clampRate(1.0, 0.0, 0.0, 0.05), 1.0);
  EXPECT_DOUBLE_EQ(slew::clampRate(1.0, 0.0, -1.0, 0.05), 1.0);
}

TEST(ClampRate, LimitsAccelAndDecelSymmetrically) {
  // max_accel=1.0, dt=0.05 -> 1 ステップ最大 0.05
  EXPECT_DOUBLE_EQ(slew::clampRate(1.0, 0.0, 1.0, 0.05), 0.05);
  EXPECT_DOUBLE_EQ(slew::clampRate(-1.0, 0.0, 1.0, 0.05), -0.05);
  EXPECT_DOUBLE_EQ(slew::clampRate(0.0, 1.0, 1.0, 0.05), 0.95);
}

TEST(ClampRate, SmallChangePassesThrough) {
  EXPECT_DOUBLE_EQ(slew::clampRate(0.03, 0.0, 1.0, 0.05), 0.03);
}

TEST(ClampRate, StepAfterResetIsBounded) {
  // ウォッチドッグ停止後の初回フル指令: 0 から max_accel * kMaxDtSec までに制限される
  double dt = slew::normalizeDt(false, 0.0);
  EXPECT_DOUBLE_EQ(slew::clampRate(1.0, 0.0, 1.0, dt), 1.0 * slew::kMaxDtSec);
}

TEST(ClampRateTapered, ZeroBandMatchesPlainClampRate) {
  // taper_band <= 0 は従来挙動と完全一致（後方互換）
  for (double band : {0.0, -1.0}) {
    EXPECT_DOUBLE_EQ(slew::clampRateTapered(1.0, 0.0, 1.0, 0.05, band),
                     slew::clampRate(1.0, 0.0, 1.0, 0.05));
    EXPECT_DOUBLE_EQ(slew::clampRateTapered(0.0, 1.0, 1.0, 0.05, band),
                     slew::clampRate(0.0, 1.0, 1.0, 0.05));
    EXPECT_DOUBLE_EQ(slew::clampRateTapered(0.03, 0.0, 1.0, 0.05, band),
                     slew::clampRate(0.03, 0.0, 1.0, 0.05));
  }
}

TEST(ClampRateTapered, PassesThroughWhenDisabled) {
  EXPECT_DOUBLE_EQ(slew::clampRateTapered(1.0, 0.0, 0.0, 0.05, 0.15), 1.0);
  EXPECT_DOUBLE_EQ(slew::clampRateTapered(1.0, 0.0, -1.0, 0.05, 0.15), 1.0);
}

TEST(ClampRateTapered, OutsideBandMatchesPlainClampRate) {
  // 残差 1.0 > band 0.15 -> 通常のレート制限がそのまま効く
  EXPECT_DOUBLE_EQ(slew::clampRateTapered(1.0, 0.0, 1.0, 0.02, 0.15), 0.02);
  EXPECT_DOUBLE_EQ(slew::clampRateTapered(-1.0, 0.0, 1.0, 0.02, 0.15), -0.02);
}

TEST(ClampRateTapered, InsideBandShrinksStep) {
  // 残差 0.075 = band の半分 -> ステップ上限も半分（0.02 -> 0.01）
  EXPECT_DOUBLE_EQ(slew::clampRateTapered(1.0, 0.925, 1.0, 0.02, 0.15), 0.935);
  // 減速側も対称に絞る
  EXPECT_DOUBLE_EQ(slew::clampRateTapered(0.0, 0.075, 1.0, 0.02, 0.15), 0.065);
}

TEST(ClampRateTapered, ApproachDecelerates) {
  // 飽和点に向かってステップ幅が単調に縮む（加速度がステップで 0 に落ちない）
  const double target = 1.0;
  const double band = 0.15;
  double last = 0.9;
  double prev_step = band;  // 初回比較用の上限
  for (int i = 0; i < 20; ++i) {
    const double next = slew::clampRateTapered(target, last, 1.0, 0.02, band);
    const double step = next - last;
    EXPECT_GT(step, 0.0) << "step " << i << " は前進し続ける";
    EXPECT_LT(step, prev_step) << "step " << i << " は前ステップより小さい";
    EXPECT_LE(next, target);
    prev_step = step;
    last = next;
  }
}

TEST(ClampRateTapered, ConvergesExactlyToTarget) {
  // 比例絞りは幾何級数なのでスナップしきい値で有限ステップ収束させる
  const double target = 1.0;
  double last = 0.9;
  for (int i = 0; i < 200; ++i) {
    last = slew::clampRateTapered(target, last, 1.0, 0.02, 0.15);
  }
  EXPECT_DOUBLE_EQ(last, target);
}

TEST(ClampRateTapered, NarrowBandNeverBites) {
  // band が 1 ステップ幅（max_accel * dt = 0.02）以下だと残差がその帯に入る前に到達する
  EXPECT_DOUBLE_EQ(slew::clampRateTapered(1.0, 0.99, 1.0, 0.02, 0.01), 1.0);
}

TEST(HostRampMsPerRpm, MatchesConfiguredDefaults) {
  // 既定値: max_linear_accel 1.0 m/s^2, wheel_radius 0.1 m -> 95.5 rpm/s ≒ 10.5 ms/rpm
  EXPECT_NEAR(slew::hostRampMsPerRpm(1.0, 0.1), 10.47, 0.01);
  // 加速度を倍にすれば傾きは倍＝ms/rpm は半分
  EXPECT_NEAR(slew::hostRampMsPerRpm(2.0, 0.1), 5.24, 0.01);
}

TEST(HostRampMsPerRpm, ReturnsZeroWhenNotConvertible) {
  // ホスト側スルーレート無効 / 不正な車輪半径では換算不能
  EXPECT_DOUBLE_EQ(slew::hostRampMsPerRpm(0.0, 0.1), 0.0);
  EXPECT_DOUBLE_EQ(slew::hostRampMsPerRpm(-1.0, 0.1), 0.0);
  EXPECT_DOUBLE_EQ(slew::hostRampMsPerRpm(1.0, 0.0), 0.0);
  EXPECT_DOUBLE_EQ(slew::hostRampMsPerRpm(1.0, -0.1), 0.0);
}
