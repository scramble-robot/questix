// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <cmath>
#include <limits>

#include "command_arbiter/launcher_flow.hpp"

using command_arbiter::LauncherFlow;
using command_arbiter::SourceSelector;
using Source = SourceSelector::Source;

namespace {

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

LauncherFlow::Command cmd(double roller, uint32_t fire = 0, int32_t steps = 0, double tilt = kNaN) {
  LauncherFlow::Command out;
  out.roller_power = roller;
  out.fire_seq = fire;
  out.tilt_steps = steps;
  out.tilt_deg = tilt;
  return out;
}

// The packaged settings, both inputs heard once (their baselines set) at t = 0.
LauncherFlow ready() {
  LauncherFlow flow;
  flow.configure(LauncherFlow::Config{});
  flow.onJoy(cmd(0.0), 0.0);
  flow.onLab(cmd(0.0), true, 0.0);
  return flow;
}

// The lab spins the roller from t0 in 0.05 s heartbeats until t1; returns the last output.
LauncherFlow::Output spin(LauncherFlow& flow, double power, double t0, double t1,
                          uint32_t fire = 0) {
  LauncherFlow::Output last;
  for (double t = t0; t <= t1 + 1e-9; t += 0.05) {
    last = flow.onLab(cmd(power, fire), true, t);
  }
  return last;
}

}  // namespace

TEST(LauncherFlow, TheControllersCommandsPassWithItsOwnCounters) {
  auto flow = ready();
  auto out = flow.onJoy(cmd(1.0, 1, 1), 0.1);  // roller held, a shot, a step up
  ASSERT_TRUE(out.publish);
  EXPECT_EQ(out.source, Source::kJoy);
  EXPECT_DOUBLE_EQ(out.command.roller_power, 1.0);
  EXPECT_EQ(out.command.fire_seq, 1u);
  EXPECT_EQ(out.command.tilt_steps, 1);
  out = flow.onJoy(cmd(1.0, 1, 1), 0.15);  // repeated: nothing new
  EXPECT_EQ(out.command.fire_seq, 1u);
  EXPECT_EQ(out.command.tilt_steps, 1);
}

TEST(LauncherFlow, TheLabTakesOverOnlyWhenPermittedAndTheControllerIsQuiet) {
  auto flow = ready();
  EXPECT_FALSE(flow.onLab(cmd(0.5), false, 0.1).publish);
  EXPECT_STREQ(flow.labRefusal(), "not_permitted");
  flow.onLab(cmd(0.0), true,
             0.2);               // the page gave up (were it still asking, a press would lock it)
  flow.onJoy(cmd(0.0, 1), 1.0);  // the controller fires: busy for controller_quiet_sec (1 s)
  EXPECT_FALSE(flow.onLab(cmd(0.5), true, 1.5).publish);
  EXPECT_STREQ(flow.labRefusal(), "controller");
  const auto out = flow.onLab(cmd(0.5), true, 2.1);
  ASSERT_TRUE(out.publish);
  EXPECT_EQ(out.source, Source::kLab);
  EXPECT_DOUBLE_EQ(out.command.roller_power, 0.5);
  EXPECT_STREQ(flow.labRefusal(), "");
}

TEST(LauncherFlow, TheLabsPowerAndTiltAreCapped) {
  auto flow = ready();
  auto out = flow.onLab(cmd(1.0, 0, 0, 200.0), true, 0.1);
  EXPECT_DOUBLE_EQ(out.command.roller_power, 0.8);
  EXPECT_DOUBLE_EQ(out.command.tilt_deg, 120.0);
  out = flow.onLab(cmd(1.0, 0, 0, -5.0), true, 0.15);
  EXPECT_DOUBLE_EQ(out.command.tilt_deg, 0.0);
  out = flow.onLab(cmd(1.0, 0, 0, -5.0), true, 0.2);  // the same target again: kept, not new
  EXPECT_DOUBLE_EQ(out.command.tilt_deg, 0.0);
}

TEST(LauncherFlow, ALabShotNeedsTheRollerSpunUp) {
  auto flow = ready();
  spin(flow, 0.5, 0.1, 0.5);
  EXPECT_NEAR(flow.spinReadyInSec(0.5), 0.6, 1e-9);
  auto out = flow.onLab(cmd(0.5, 1), true, 0.55);  // too early
  EXPECT_EQ(out.command.fire_seq, 0u);
  EXPECT_STREQ(flow.labRefusal(), "not_spinning");
  out = spin(flow, 0.5, 0.6, 1.2, 1);  // the refused request is not queued
  EXPECT_EQ(out.command.fire_seq, 0u);
  out = flow.onLab(cmd(0.5, 2), true, 1.25);
  EXPECT_EQ(out.command.fire_seq, 1u);
  EXPECT_STREQ(flow.labRefusal(), "");
}

TEST(LauncherFlow, ASlowRollerNeverSpinsUp) {
  auto flow = ready();
  spin(flow, 0.1, 0.1, 2.0);  // below min_fire_power (0.2)
  EXPECT_TRUE(std::isnan(flow.spinReadyInSec(2.0)));
  EXPECT_EQ(flow.onLab(cmd(0.1, 1), true, 2.05).command.fire_seq, 0u);
  EXPECT_STREQ(flow.labRefusal(), "not_spinning");
}

TEST(LauncherFlow, LabShotsKeepTheIntervalFromAnyShot) {
  auto flow = ready();
  spin(flow, 0.5, 0.1, 1.2);
  EXPECT_EQ(flow.onLab(cmd(0.5, 1), true, 1.25).command.fire_seq, 1u);
  spin(flow, 0.5, 1.3, 2.0, 1);
  EXPECT_NEAR(flow.nextFireInSec(2.0), 1.25, 1e-9);
  EXPECT_EQ(flow.onLab(cmd(0.5, 2), true, 2.05).command.fire_seq, 1u);
  EXPECT_STREQ(flow.labRefusal(), "interval");
  spin(flow, 0.5, 2.1, 3.3, 2);
  EXPECT_EQ(flow.onLab(cmd(0.5, 3), true, 3.3).command.fire_seq, 2u);
}

TEST(LauncherFlow, TheControllerAlwaysWinsAndItsPressFires) {
  auto flow = ready();
  spin(flow, 0.5, 0.1, 0.5);
  const auto out = flow.onJoy(cmd(0.0, 1), 0.55);  // the controller fires during the lab's run
  ASSERT_TRUE(out.publish);
  EXPECT_EQ(out.source, Source::kJoy);
  EXPECT_DOUBLE_EQ(out.command.roller_power, 0.0);  // the lab's roller stops
  EXPECT_EQ(out.command.fire_seq, 1u);              // the press fires (a counter of its own)
  EXPECT_TRUE(flow.selector().labLocked());
  EXPECT_FALSE(flow.onLab(cmd(0.5), true, 2.0).publish);
  EXPECT_STREQ(flow.labRefusal(), "locked");
  flow.onLab(cmd(0.0), true, 2.05);  // the lab's run ends: unlocked
  EXPECT_FALSE(flow.selector().labLocked());
}

TEST(LauncherFlow, TheIdleControllerIsNotForwardedDuringALabRun) {
  auto flow = ready();
  spin(flow, 0.5, 0.1, 0.3);
  EXPECT_FALSE(flow.onJoy(cmd(0.0), 0.35).publish);
}

TEST(LauncherFlow, TheLabsNeutralCommandEndsItsRunAndIsForwarded) {
  auto flow = ready();
  spin(flow, 0.5, 0.1, 0.3);
  const auto out = flow.onLab(cmd(0.0), true, 0.35);
  ASSERT_TRUE(out.publish);
  EXPECT_DOUBLE_EQ(out.command.roller_power, 0.0);
  EXPECT_EQ(flow.selector().source(), Source::kJoy);
  EXPECT_TRUE(std::isnan(flow.spinReadyInSec(0.35)));
}

TEST(LauncherFlow, ATiltOnlyRequestTakesTheLauncherBriefly) {
  auto flow = ready();
  auto out = flow.onLab(cmd(0.0, 0, 0, 30.0), true, 0.1);  // roller 0 but a new target
  ASSERT_TRUE(out.publish);
  EXPECT_DOUBLE_EQ(out.command.tilt_deg, 30.0);
  out = flow.onLab(cmd(0.0, 0, 0, 30.0), true, 0.15);  // nothing new: the run's end
  EXPECT_TRUE(out.publish);
  EXPECT_EQ(flow.selector().source(), Source::kJoy);
  out = flow.onJoy(cmd(0.0), 0.2);  // the controller's stream again: no target
  EXPECT_TRUE(std::isnan(out.command.tilt_deg));
}

TEST(LauncherFlow, SilenceOrLosingThePermissionStopsTheRoller) {
  auto flow = ready();
  spin(flow, 0.5, 0.1, 0.3);
  EXPECT_FALSE(flow.onTick(true, 1.0).publish);
  auto out = flow.onTick(true, 1.4);  // silent for more than lab_timeout_sec (1 s)
  ASSERT_TRUE(out.publish);
  EXPECT_DOUBLE_EQ(out.command.roller_power, 0.0);
  spin(flow, 0.5, 2.0, 2.2);
  out = flow.onTick(false, 2.25);  // the teacher switched it off
  ASSERT_TRUE(out.publish);
  EXPECT_DOUBLE_EQ(out.command.roller_power, 0.0);
  EXPECT_EQ(flow.selector().reason(), SourceSelector::Reason::kNotPermitted);
}

TEST(LauncherFlow, ABrokenLabCommandEndsTheRunWithAStop) {
  auto flow = ready();
  spin(flow, 0.5, 0.1, 0.3);
  const auto out = flow.onLab(cmd(kNaN), true, 0.35);
  ASSERT_TRUE(out.publish);
  EXPECT_DOUBLE_EQ(out.command.roller_power, 0.0);
  EXPECT_STREQ(flow.labRefusal(), "invalid");
  EXPECT_EQ(flow.selector().source(), Source::kJoy);
  EXPECT_FALSE(
      flow.onLab(cmd(0.5, 0, 0, std::numeric_limits<double>::infinity()), true, 0.4).publish);
}

TEST(LauncherFlow, AnInputsOldCountersAreNotReplayed) {
  LauncherFlow flow;
  flow.configure(LauncherFlow::Config{});
  // joy_launcher was already running (fire_seq 7): the first message is only its baseline.
  auto out = flow.onJoy(cmd(0.0, 7, 3), 0.0);
  EXPECT_EQ(out.command.fire_seq, 0u);
  EXPECT_EQ(out.command.tilt_steps, 0);
  out = flow.onJoy(cmd(0.0, 8, 3), 0.05);
  EXPECT_EQ(out.command.fire_seq, 1u);
}
