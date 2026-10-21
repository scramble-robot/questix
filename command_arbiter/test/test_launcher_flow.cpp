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
  auto out = flow.onLab(cmd(0.5), true, 2.1);
  ASSERT_TRUE(out.publish);
  EXPECT_EQ(out.source, Source::kLab);
  EXPECT_DOUBLE_EQ(out.command.roller_power, 0.0);  // a run starts with a 0 (the ESC needs one)
  out = flow.onLab(cmd(0.5), true, 2.15);
  EXPECT_DOUBLE_EQ(out.command.roller_power, 0.5);
  EXPECT_STREQ(flow.labRefusal(), "");
}

TEST(LauncherFlow, TheLabsPowerAndTiltAreCapped) {
  auto flow = ready();
  auto out = flow.onLab(cmd(1.0, 0, 0, 200.0), true, 0.1);
  EXPECT_DOUBLE_EQ(out.command.roller_power, 0.0);  // the run's first command
  EXPECT_DOUBLE_EQ(out.command.tilt_deg, 120.0);    // a target goes out at once
  out = flow.onLab(cmd(1.0, 0, 0, 200.0), true, 0.12);
  EXPECT_DOUBLE_EQ(out.command.roller_power, 0.8);
  out = flow.onLab(cmd(1.0, 0, 0, -5.0), true, 0.15);
  EXPECT_DOUBLE_EQ(out.command.tilt_deg, 0.0);
  out = flow.onLab(cmd(1.0, 0, 0, -5.0), true, 0.2);  // the same target again: kept, not new
  EXPECT_DOUBLE_EQ(out.command.tilt_deg, 0.0);
}

TEST(LauncherFlow, ALabShotNeedsTheRollerSpunUp) {
  auto flow = ready();
  spin(flow, 0.5, 0.1, 0.5);  // the 0.5 goes out from 0.15 (the run's first command is 0)
  EXPECT_NEAR(flow.spinReadyInSec(0.5), 0.65, 1e-9);
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

TEST(LauncherFlow, Float32ThresholdCommandsSpinUpEvenAtTheCap) {
  for (const double minimum : {0.2, 0.21, 0.7, 0.8, 0.20001}) {
    LauncherFlow flow;
    LauncherFlow::Config config;
    config.min_fire_power = minimum;
    config.lab_max_power = minimum;
    flow.configure(config);
    flow.onJoy(cmd(0.0), 0.0);
    flow.onLab(cmd(0.0), true, 0.0);
    const double power = static_cast<double>(static_cast<float>(minimum));
    const auto out = spin(flow, power, 0.1, 1.5);
    EXPECT_LE(out.command.roller_power, minimum);
    EXPECT_DOUBLE_EQ(flow.spinReadyInSec(1.5), 0.0);
    EXPECT_EQ(flow.onLab(cmd(power, 1), true, 1.55).command.fire_seq, 1u);
  }
}

TEST(LauncherFlow, Float32ComparisonDoesNotRoundFractionalThresholdsToWholePercent) {
  for (const double power : {0.0, 0.19, 0.2}) {
    LauncherFlow flow;
    LauncherFlow::Config config;
    config.min_fire_power = 0.20001;
    flow.configure(config);
    flow.onJoy(cmd(0.0), 0.0);
    flow.onLab(cmd(0.0), true, 0.0);
    const double wire_power = static_cast<double>(static_cast<float>(power));
    spin(flow, wire_power, 0.1, 1.5);
    EXPECT_TRUE(std::isnan(flow.spinReadyInSec(1.5)));
    EXPECT_EQ(flow.onLab(cmd(wire_power, 1), true, 1.55).command.fire_seq, 0u);
  }
}

TEST(LauncherFlow, ACapBelowTheMinimumCannotQualifyThroughFloat32Rounding) {
  LauncherFlow flow;
  LauncherFlow::Config config;
  config.min_fire_power = 0.21;
  config.lab_max_power = 0.21 - 1e-10;  // both settings have the same float32 representation
  flow.configure(config);
  flow.onJoy(cmd(0.0), 0.0);
  flow.onLab(cmd(0.0), true, 0.0);
  spin(flow, 0.5, 0.1, 1.5);
  EXPECT_TRUE(std::isnan(flow.spinReadyInSec(1.5)));
  EXPECT_EQ(flow.onLab(cmd(0.5, 1), true, 1.55).command.fire_seq, 0u);
}

TEST(LauncherFlow, NonFiniteMinimumNeverStartsSpinUp) {
  for (const double minimum :
       {kNaN, std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity()}) {
    auto flow = ready();
    auto config = flow.config();
    config.min_fire_power = minimum;
    flow.configure(config);
    spin(flow, 0.5, 0.1, 1.5);
    EXPECT_TRUE(std::isnan(flow.spinReadyInSec(1.5)));
  }
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

TEST(LauncherFlow, ALabRunNeverCarriesAnEarlierRunsTiltTarget) {
  auto flow = ready();
  flow.onLab(cmd(0.5, 0, 0, 60.0), true, 0.1);
  auto out = flow.onLab(cmd(0.5, 0, 0, 60.0), true, 0.15);
  EXPECT_DOUBLE_EQ(out.command.tilt_deg, 60.0);  // the run's own target, sticky
  out = flow.onTick(true, 1.5);                  // the page went silent: the run's stop
  ASSERT_TRUE(out.publish);
  EXPECT_TRUE(std::isnan(out.command.tilt_deg));
  out = flow.onLab(cmd(0.5), true, 2.0);  // a new run that asks for no tilt
  EXPECT_TRUE(std::isnan(out.command.tilt_deg));
  out = flow.onLab(cmd(0.5), true, 2.05);
  EXPECT_TRUE(std::isnan(out.command.tilt_deg));
  EXPECT_DOUBLE_EQ(out.command.roller_power, 0.5);
}

TEST(LauncherFlow, EveryLabRunStartsWithAZero) {
  auto flow = ready();
  spin(flow, 0.5, 0.1, 0.3);
  flow.onLab(cmd(0.0), true, 0.35);            // the run ends
  auto out = flow.onLab(cmd(0.6), true, 0.4);  // the next run
  EXPECT_DOUBLE_EQ(out.command.roller_power, 0.0);
  EXPECT_TRUE(std::isnan(flow.spinReadyInSec(0.4)));  // no spin-up from a 0
  out = flow.onLab(cmd(0.6), true, 0.45);
  EXPECT_DOUBLE_EQ(out.command.roller_power, 0.6);
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
