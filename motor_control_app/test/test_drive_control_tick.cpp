// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <cmath>
#include <limits>

#include "motor_control_app/drive_control_tick.hpp"

namespace tick = motor_control_app::drive_control_tick;
using tick::TickAction;

// 未武装（目標未受信）は他の条件に関わらず kIdle。
TEST(DecideTickAction, IdleWhenNoTarget) {
  EXPECT_EQ(tick::decideTickAction(false, true, false, true, 0.0, 1.0), TickAction::kIdle);
  // 未武装なら経過時間が大きくてもタイムアウトは発火しない
  EXPECT_EQ(tick::decideTickAction(false, true, false, true, 100.0, 1.0), TickAction::kIdle);
  // 未武装ならフォールトでも停止指令は送らない（送るべき駆動指令が無い）
  EXPECT_EQ(tick::decideTickAction(false, true, false, false, 0.0, 1.0), TickAction::kIdle);
}

// モータ未準備・非常停止中は kIdle（twist 側で保存しないが多重の防御）。
TEST(DecideTickAction, IdleWhenNotReadyOrEstop) {
  EXPECT_EQ(tick::decideTickAction(true, false, false, true, 0.0, 1.0), TickAction::kIdle);
  EXPECT_EQ(tick::decideTickAction(true, true, true, true, 0.0, 1.0), TickAction::kIdle);
  EXPECT_EQ(tick::decideTickAction(true, false, true, false, 10.0, 1.0), TickAction::kIdle);
}

// タイムアウト判定は drive_watchdog::shouldTimeoutStop と同一の境界
// （elapsed == timeout は発火しない。timeout <= 0 で無効）。
TEST(DecideTickAction, TimeoutBoundary) {
  EXPECT_EQ(tick::decideTickAction(true, true, false, true, 1.0, 1.0), TickAction::kDrive);
  EXPECT_EQ(tick::decideTickAction(true, true, false, true, 1.001, 1.0), TickAction::kTimeoutStop);
  // 無効（timeout <= 0）ならどれだけ経過しても駆動を続ける
  EXPECT_EQ(tick::decideTickAction(true, true, false, true, 100.0, 0.0), TickAction::kDrive);
  EXPECT_EQ(tick::decideTickAction(true, true, false, true, 100.0, -1.0), TickAction::kDrive);
}

// タイムアウトはフォールトより優先される（どちらも停止 + 武装解除なので順序の実害は
// 無いが、判定の決定性を固定する）。
TEST(DecideTickAction, TimeoutTakesPrecedenceOverFault) {
  EXPECT_EQ(tick::decideTickAction(true, true, false, false, 2.0, 1.0), TickAction::kTimeoutStop);
}

// モータ異常（準備完了・タイムアウト前）は kFaultStop。
TEST(DecideTickAction, FaultStopWhenUnhealthy) {
  EXPECT_EQ(tick::decideTickAction(true, true, false, false, 0.5, 1.0), TickAction::kFaultStop);
}

// 正常系は kDrive。
TEST(DecideTickAction, DriveWhenArmedReadyHealthy) {
  EXPECT_EQ(tick::decideTickAction(true, true, false, true, 0.0, 1.0), TickAction::kDrive);
  EXPECT_EQ(tick::decideTickAction(true, true, false, true, 0.99, 1.0), TickAction::kDrive);
}

// tickDtSec: 正常なレートは逆数、不正値はフォールバック。
TEST(TickDtSec, ValidRates) {
  EXPECT_DOUBLE_EQ(tick::tickDtSec(50.0), 0.02);
  EXPECT_DOUBLE_EQ(tick::tickDtSec(20.0), 0.05);
  EXPECT_DOUBLE_EQ(tick::tickDtSec(100.0), 0.01);
}

TEST(TickDtSec, InvalidRatesFallBack) {
  EXPECT_DOUBLE_EQ(tick::tickDtSec(0.0), tick::kFallbackDtSec);
  EXPECT_DOUBLE_EQ(tick::tickDtSec(-50.0), tick::kFallbackDtSec);
  EXPECT_DOUBLE_EQ(tick::tickDtSec(std::numeric_limits<double>::quiet_NaN()), tick::kFallbackDtSec);
  EXPECT_DOUBLE_EQ(tick::tickDtSec(std::numeric_limits<double>::infinity()), tick::kFallbackDtSec);
}

int main(int argc, char** argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
