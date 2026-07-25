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
