// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include "motor_control_app/drive_watchdog.hpp"

namespace {

using motor_control_app::drive_watchdog::decideTwistAction;
using motor_control_app::drive_watchdog::isEnabled;
using motor_control_app::drive_watchdog::shouldTimeoutStop;
using motor_control_app::drive_watchdog::TwistAction;

// Default command timeout from the DriveComponent constructor / YAML: 0.5 s.
constexpr double kTimeout = 0.5;

TEST(DriveWatchdog, IsEnabled) {
  EXPECT_TRUE(isEnabled(0.5));
  EXPECT_FALSE(isEnabled(0.0));
  EXPECT_FALSE(isEnabled(-1.0));
}

TEST(DriveWatchdog, ShouldTimeoutStopBelowTimeout) {
  EXPECT_FALSE(shouldTimeoutStop(0.4, kTimeout, true));
}

TEST(DriveWatchdog, ShouldTimeoutStopExactBoundaryDoesNotFire) {
  // elapsed == timeout must NOT fire (strict inequality, matching ESC safety_check).
  EXPECT_FALSE(shouldTimeoutStop(kTimeout, kTimeout, true));
}

TEST(DriveWatchdog, ShouldTimeoutStopJustAboveFires) {
  EXPECT_TRUE(shouldTimeoutStop(0.5001, kTimeout, true));
}

TEST(DriveWatchdog, ShouldTimeoutStopNoCommandNeverFires) {
  // No command received yet -> never fire, even far past the timeout.
  EXPECT_FALSE(shouldTimeoutStop(10.0, kTimeout, false));
}

TEST(DriveWatchdog, ShouldTimeoutStopDisabledNeverFires) {
  // timeout <= 0 disables the watchdog regardless of elapsed / has_cmd.
  EXPECT_FALSE(shouldTimeoutStop(10.0, 0.0, true));
  EXPECT_FALSE(shouldTimeoutStop(10.0, -1.0, true));
}

TEST(DriveWatchdog, ContinuousInputNeverFires) {
  // Simulate 20 Hz commands: the watchdog runs every 100 ms and sees an elapsed
  // time that never exceeds ~0.05 s, so it must never fire against a 0.5 s limit.
  const double command_period = 1.0 / 20.0;  // 0.05 s
  for (int tick = 0; tick < 200; ++tick) {
    // Worst-case elapsed since the last command is one command period.
    EXPECT_FALSE(shouldTimeoutStop(command_period, kTimeout, true));
  }
}

TEST(DriveWatchdog, FireThenReArmCycle) {
  // First dropout: command received, elapsed exceeds timeout -> fires.
  EXPECT_TRUE(shouldTimeoutStop(0.6, kTimeout, true));

  // After firing, the node clears has_cmd; a further check must not re-fire.
  bool has_cmd = false;
  EXPECT_FALSE(shouldTimeoutStop(0.7, kTimeout, has_cmd));

  // A new /target_twist re-arms the watchdog (has_cmd = true, small elapsed).
  has_cmd = true;
  EXPECT_FALSE(shouldTimeoutStop(0.05, kTimeout, has_cmd));

  // A second dropout fires again.
  EXPECT_TRUE(shouldTimeoutStop(0.6, kTimeout, has_cmd));
}

TEST(DriveWatchdog, DecideTwistActionNotReadyIsIgnore) {
  EXPECT_EQ(decideTwistAction(false, false, true), TwistAction::kIgnore);
  EXPECT_EQ(decideTwistAction(false, false, false), TwistAction::kIgnore);
}

TEST(DriveWatchdog, DecideTwistActionEmergencyStopTakesPrecedence) {
  // Emergency stop -> kIgnore even when unhealthy.
  EXPECT_EQ(decideTwistAction(true, true, false), TwistAction::kIgnore);
  EXPECT_EQ(decideTwistAction(true, true, true), TwistAction::kIgnore);
}

TEST(DriveWatchdog, DecideTwistActionReadyUnhealthyIsFaultStop) {
  EXPECT_EQ(decideTwistAction(true, false, false), TwistAction::kFaultStop);
}

TEST(DriveWatchdog, DecideTwistActionReadyHealthyIsDrive) {
  EXPECT_EQ(decideTwistAction(true, false, true), TwistAction::kDrive);
}

}  // namespace

int main(int argc, char** argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
