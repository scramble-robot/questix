// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <limits>
#include <string>

#include "motor_control_app/launcher_events.hpp"

using motor_control_app::LauncherEvents;

namespace {

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

LauncherEvents::Command command(uint32_t fire, int32_t steps = 0, double tilt = kNaN) {
  LauncherEvents::Command out;
  out.fire_seq = fire;
  out.tilt_steps = steps;
  out.tilt_deg = tilt;
  return out;
}

}  // namespace

TEST(LauncherEvents, TheFirstMessageOnlySetsTheBaseline) {
  LauncherEvents events;
  events.configure(1.0);
  const auto first = events.onCommand(command(7, 3), 0.0);  // counters from before: not replayed
  EXPECT_TRUE(first.baseline);
  EXPECT_FALSE(first.fire);
  EXPECT_EQ(first.tilt_steps, 0);
  const auto next = events.onCommand(command(8, 4), 0.05);
  EXPECT_FALSE(next.baseline);
  EXPECT_TRUE(next.fire);
  EXPECT_EQ(next.tilt_steps, 1);
}

TEST(LauncherEvents, CountersFireOnceAndStepBothWays) {
  LauncherEvents events;
  events.onCommand(command(0), 0.0);
  EXPECT_TRUE(events.onCommand(command(1), 0.1).fire);
  EXPECT_FALSE(events.onCommand(command(1), 0.2).fire);  // repeated: no second shot
  EXPECT_TRUE(events.onCommand(command(3), 0.3).fire);   // one shot per message at most
  EXPECT_EQ(events.onCommand(command(3, -1), 0.4).tilt_steps, -1);
  EXPECT_EQ(events.onCommand(command(3, 1), 0.5).tilt_steps, 2);
}

TEST(LauncherEvents, SilenceOrARestartRebasesTheCounters) {
  LauncherEvents events;
  events.configure(1.0);
  events.onCommand(command(5, 2), 0.0);
  auto out = events.onCommand(command(6, 3), 1.5);  // after 1.5 s of silence
  EXPECT_TRUE(out.baseline);
  EXPECT_FALSE(out.fire);
  out = events.onCommand(command(0, 0), 1.6);  // fire_seq went back: the publisher restarted
  EXPECT_TRUE(out.baseline);
  EXPECT_TRUE(events.onCommand(command(1, 0), 1.7).fire);
  out = events.onCommand(command(1, 50), 1.8);  // an implausible jump of steps
  EXPECT_TRUE(out.baseline);
  EXPECT_EQ(out.tilt_steps, 0);
  events.reset();
  EXPECT_TRUE(events.onCommand(command(2, 50), 1.9).baseline);
}

TEST(LauncherEvents, ATiltTargetCountsWhenItChanges) {
  LauncherEvents events;
  auto out = events.onCommand(command(0, 0, 30.0), 0.0);  // the current wish: even on the baseline
  EXPECT_TRUE(out.baseline && out.tilt_target);
  EXPECT_DOUBLE_EQ(out.tilt_deg, 30.0);
  EXPECT_FALSE(events.onCommand(command(0, 0, 30.0), 0.1).tilt_target);  // repeated
  EXPECT_TRUE(events.onCommand(command(0, 0, 40.0), 0.2).tilt_target);
  EXPECT_FALSE(events.onCommand(command(0, 0, kNaN), 0.3).tilt_target);  // the controller's turn
  EXPECT_TRUE(events.onCommand(command(0, 0, 40.0), 0.4).tilt_target);   // NaN -> 40 again
}

TEST(LauncherEvents, InvalidTimeoutFallsBack) {
  LauncherEvents events;
  events.configure(0.0);
  EXPECT_DOUBLE_EQ(events.timeoutSec(), 1.0);
}

TEST(ShotStatus, JsonHasOnlyTheMechanismsStateAndLimits) {
  motor_control_app::ShotStatus status;
  status.tilt_deg = 30.0;
  status.fired_count = 2;
  status.last_fire_source = motor_control_app::fireSourceOf("lab");
  status.permission = true;
  status.active = true;
  status.tilt_max_deg = 120.0;
  EXPECT_EQ(motor_control_app::shotStatusJson(status),
            "{\"tilt_deg\": 30.0, \"shooting\": false, \"fired_count\": 2, "
            "\"last_fire_source\": \"lab\", \"estop\": false, \"permission\": true, "
            "\"active\": true, \"tilt_min_deg\": 0.0, \"tilt_max_deg\": 120.0, "
            "\"next_fire_in_sec\": 0.00}");
  EXPECT_STREQ(motor_control_app::fireSourceJson(motor_control_app::fireSourceOf("x\"")),
               "\"other\"");
  EXPECT_DOUBLE_EQ(motor_control_app::nextFireInSec(10.0, 9.5, 2.0), 1.5);
  EXPECT_DOUBLE_EQ(
      motor_control_app::nextFireInSec(10.0, -std::numeric_limits<double>::infinity(), 2.0), 0.0);
}
