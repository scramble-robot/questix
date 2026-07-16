// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include "esc_motor_control_cpp/full_speed_logic.hpp"

namespace {

esc_motor_control_cpp::FullSpeedLogic makeLogic(double timeout_sec = 1.0) {
  esc_motor_control_cpp::FullSpeedLogic logic;
  logic.configure(timeout_sec);
  return logic;
}

}  // namespace

TEST(FullSpeedLogicTest, InitiallyInactiveAndNoFalseFire) {
  auto logic = makeLogic();
  EXPECT_FALSE(logic.isActive());

  // No press has occurred; the timer must not report anything.
  const auto r = logic.onTimerCheck(1000.0);
  EXPECT_FALSE(r.start_full_speed);
  EXPECT_FALSE(r.stop);
  EXPECT_FALSE(r.timed_out);
  EXPECT_FALSE(r.ignored_press);
  EXPECT_FALSE(logic.isActive());
}

TEST(FullSpeedLogicTest, PressStartsReleaseStops) {
  auto logic = makeLogic();

  const auto r_press = logic.onButton(true, 0.0);
  EXPECT_TRUE(r_press.start_full_speed);
  EXPECT_FALSE(r_press.stop);
  EXPECT_TRUE(logic.isActive());

  const auto r_release = logic.onButton(false, 0.1);
  EXPECT_FALSE(r_release.start_full_speed);
  EXPECT_TRUE(r_release.stop);
  EXPECT_FALSE(logic.isActive());
}

TEST(FullSpeedLogicTest, HeldKeepAliveNeverTimesOut) {
  auto logic = makeLogic(1.0);
  logic.onButton(true, 0.0);

  // Held-button messages every 0.5s, checked every 0.1s, for 5 simulated seconds.
  double t = 0.0;
  double next_msg = 0.5;
  while (t <= 5.0) {
    if (t >= next_msg) {
      const auto r = logic.onButton(true, t);
      EXPECT_FALSE(r.stop);
      next_msg += 0.5;
    }
    const auto r = logic.onTimerCheck(t);
    EXPECT_FALSE(r.timed_out);
    t += 0.1;
  }
  EXPECT_TRUE(logic.isActive());
}

TEST(FullSpeedLogicTest, KeepAliveResetsTimeoutWindow) {
  auto logic = makeLogic(1.0);
  logic.onButton(true, 0.0);

  // Just before timeout, a keep-alive refreshes the window.
  const auto r_keep = logic.onButton(true, 0.9);
  EXPECT_FALSE(r_keep.stop);

  // 1.5s is > 1.0 since t=0, but only 0.6s since the keep-alive: no timeout.
  const auto r = logic.onTimerCheck(1.5);
  EXPECT_FALSE(r.timed_out);
  EXPECT_TRUE(logic.isActive());
}

TEST(FullSpeedLogicTest, BoundaryExactlyAtTimeoutDoesNotFire) {
  auto logic = makeLogic(1.0);
  logic.onButton(true, 0.0);

  const auto r = logic.onTimerCheck(1.0);  // elapsed == timeout_sec: no fire
  EXPECT_FALSE(r.stop);
  EXPECT_FALSE(r.timed_out);
  EXPECT_TRUE(logic.isActive());
}

TEST(FullSpeedLogicTest, JustPastTimeoutFires) {
  auto logic = makeLogic(1.0);
  logic.onButton(true, 0.0);

  const auto r = logic.onTimerCheck(1.0 + 1e-6);
  EXPECT_TRUE(r.stop);
  EXPECT_TRUE(r.timed_out);
  EXPECT_FALSE(logic.isActive());
}

TEST(FullSpeedLogicTest, TimeoutIsSingleShot) {
  auto logic = makeLogic(1.0);
  logic.onButton(true, 0.0);

  const auto r1 = logic.onTimerCheck(2.0);
  EXPECT_TRUE(r1.timed_out);
  EXPECT_TRUE(r1.stop);

  const auto r2 = logic.onTimerCheck(3.0);
  EXPECT_FALSE(r2.stop);
  EXPECT_FALSE(r2.timed_out);
}

TEST(FullSpeedLogicTest, HeldPressAfterTimeoutDoesNotRestart) {
  // Core of this fix: after a timeout, holding the button down must NOT resume.
  auto logic = makeLogic(1.0);
  logic.onButton(true, 0.0);
  logic.onTimerCheck(2.0);  // times out
  ASSERT_FALSE(logic.isActive());

  // joy recovers while the button is still held: press observed again.
  const auto r = logic.onButton(true, 2.5);
  EXPECT_FALSE(r.start_full_speed);
  EXPECT_TRUE(r.ignored_press);
  EXPECT_FALSE(logic.isActive());

  // Still held on the next message: still ignored, still stopped.
  const auto r2 = logic.onButton(true, 3.0);
  EXPECT_FALSE(r2.start_full_speed);
  EXPECT_TRUE(r2.ignored_press);
  EXPECT_FALSE(logic.isActive());
}

TEST(FullSpeedLogicTest, ReleaseThenPressAfterTimeoutRestarts) {
  auto logic = makeLogic(1.0);
  logic.onButton(true, 0.0);
  logic.onTimerCheck(2.0);  // times out
  ASSERT_FALSE(logic.isActive());

  // A fresh release re-arms the latch.
  const auto r_release = logic.onButton(false, 2.5);
  EXPECT_FALSE(r_release.stop);
  EXPECT_FALSE(r_release.ignored_press);

  // A fresh press now restarts full speed.
  const auto r_press = logic.onButton(true, 2.6);
  EXPECT_TRUE(r_press.start_full_speed);
  EXPECT_TRUE(logic.isActive());
}

TEST(FullSpeedLogicTest, TimerCheckWhileInactiveIsNoOp) {
  auto logic = makeLogic(1.0);
  ASSERT_FALSE(logic.isActive());

  const auto r = logic.onTimerCheck(1000.0);
  EXPECT_FALSE(r.stop);
  EXPECT_FALSE(r.timed_out);
  EXPECT_FALSE(logic.isActive());
}

TEST(FullSpeedLogicTest, ZeroTimeoutDisablesFeature) {
  auto logic = makeLogic(0.0);
  logic.onButton(true, 0.0);

  const auto r = logic.onTimerCheck(1000.0);
  EXPECT_FALSE(r.timed_out);
  EXPECT_TRUE(logic.isActive());
}

TEST(FullSpeedLogicTest, NegativeTimeoutDisablesFeature) {
  auto logic = makeLogic(-1.0);
  logic.onButton(true, 0.0);

  const auto r = logic.onTimerCheck(1000.0);
  EXPECT_FALSE(r.timed_out);
  EXPECT_TRUE(logic.isActive());
}

TEST(FullSpeedLogicTest, RepeatedNormalCyclesWork) {
  auto logic = makeLogic(1.0);

  double t = 0.0;
  for (int i = 0; i < 5; ++i) {
    const auto r_press = logic.onButton(true, t);
    EXPECT_TRUE(r_press.start_full_speed);
    EXPECT_FALSE(r_press.ignored_press);
    EXPECT_TRUE(logic.isActive());

    const auto r_release = logic.onButton(false, t + 0.1);
    EXPECT_TRUE(r_release.stop);
    EXPECT_FALSE(logic.isActive());

    t += 1.0;
  }
}

int main(int argc, char** argv) {
  testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
