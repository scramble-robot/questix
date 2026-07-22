// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include "esc_motor_control_cpp/estop_logic.hpp"

namespace {

using esc_motor_control_cpp::decideEstopTransition;

TEST(EstopLogic, RisingEdgeSendsStop) {
  const auto t = decideEstopTransition(/*was_active=*/false, /*now_active=*/true);
  EXPECT_TRUE(t.send_stop);
  EXPECT_FALSE(t.log_release);
}

TEST(EstopLogic, FallingEdgeLogsReleaseOnly) {
  const auto t = decideEstopTransition(/*was_active=*/true, /*now_active=*/false);
  EXPECT_FALSE(t.send_stop);
  EXPECT_TRUE(t.log_release);
}

TEST(EstopLogic, NoChangeActiveIsNoOp) {
  // The topic is published every evaluation; repeated active=true must not re-stop.
  const auto t = decideEstopTransition(/*was_active=*/true, /*now_active=*/true);
  EXPECT_FALSE(t.send_stop);
  EXPECT_FALSE(t.log_release);
}

TEST(EstopLogic, NoChangeInactiveIsNoOp) {
  const auto t = decideEstopTransition(/*was_active=*/false, /*now_active=*/false);
  EXPECT_FALSE(t.send_stop);
  EXPECT_FALSE(t.log_release);
}

TEST(EstopLogic, EngageReleaseCycle) {
  // Engage -> stop, hold -> nothing, release -> log only, hold -> nothing.
  EXPECT_TRUE(decideEstopTransition(false, true).send_stop);
  EXPECT_FALSE(decideEstopTransition(true, true).send_stop);
  EXPECT_TRUE(decideEstopTransition(true, false).log_release);
  EXPECT_FALSE(decideEstopTransition(false, false).log_release);
}

}  // namespace

int main(int argc, char** argv) {
  testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
