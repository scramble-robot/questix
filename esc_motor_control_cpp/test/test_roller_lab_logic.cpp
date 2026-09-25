// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <limits>
#include <string>

#include "esc_motor_control_cpp/roller_lab_logic.hpp"

namespace {

using esc_motor_control_cpp::RollerLabLogic;
using esc_motor_control_cpp::RollerStatus;
using esc_motor_control_cpp::rollerStatusJson;
using Refusal = RollerLabLogic::Refusal;

// Defaults from esc_motor_control_cpp.yaml: lab_max_speed 0.8, lab_joy_quiet_sec 1.0,
// safety_timeout 1.0.
RollerLabLogic makeLogic(bool accept = true) {
  RollerLabLogic logic;
  RollerLabLogic::Config config;
  config.accept = accept;
  config.max_speed = 0.8;
  config.joy_quiet_sec = 1.0;
  config.timeout_sec = 1.0;
  logic.configure(config);
  return logic;
}

TEST(RollerLabLogic, AppliesLabValueWhenEverythingIsQuiet) {
  auto logic = makeLogic();
  const auto d = logic.onLab(0.5, 10.0, false, false);
  EXPECT_TRUE(d.apply);
  EXPECT_DOUBLE_EQ(d.command, 0.5);
  EXPECT_EQ(d.refusal, Refusal::kNone);
  EXPECT_TRUE(logic.labActive());
  EXPECT_STREQ(logic.sourceName(false), "lab");
}

TEST(RollerLabLogic, ClampsToMaxSpeedAndZero) {
  auto logic = makeLogic();
  EXPECT_DOUBLE_EQ(logic.onLab(1.0, 10.0, false, false).command, 0.8);
  EXPECT_DOUBLE_EQ(logic.onLab(5.0, 10.1, false, false).command, 0.8);
  // Negative values mean stop (no reverse from the lab).
  const auto stop = logic.onLab(-0.5, 10.2, false, false);
  EXPECT_TRUE(stop.apply);
  EXPECT_DOUBLE_EQ(stop.command, 0.0);
  EXPECT_FALSE(logic.labActive());
}

TEST(RollerLabLogic, NonFiniteValueIsZero) {
  auto logic = makeLogic();
  logic.onLab(0.5, 10.0, false, false);
  const auto d = logic.onLab(std::numeric_limits<double>::quiet_NaN(), 10.1, false, false);
  EXPECT_TRUE(d.apply);
  EXPECT_DOUBLE_EQ(d.command, 0.0);
  EXPECT_FALSE(logic.labActive());
}

TEST(RollerLabLogic, ConfigureSanitizesLimits) {
  RollerLabLogic logic;
  RollerLabLogic::Config config;
  config.accept = true;
  config.max_speed = 3.0;
  config.timeout_sec = 0.0;
  logic.configure(config);
  EXPECT_DOUBLE_EQ(logic.config().max_speed, 1.0);
  EXPECT_DOUBLE_EQ(logic.config().timeout_sec, 1.0);
  config.max_speed = std::numeric_limits<double>::quiet_NaN();
  logic.configure(config);
  EXPECT_DOUBLE_EQ(logic.config().max_speed, 0.0);
}

TEST(RollerLabLogic, ZeroWhileIdleDoesNothing) {
  auto logic = makeLogic();
  const auto d = logic.onLab(0.0, 10.0, false, false);
  EXPECT_FALSE(d.apply);
  EXPECT_EQ(d.refusal, Refusal::kNone);
}

TEST(RollerLabLogic, ZeroNeverStopsTheControllersRoller) {
  auto logic = makeLogic();
  logic.onJoyButton(true, 10.0);
  const auto d = logic.onLab(0.0, 10.1, true, false);
  EXPECT_FALSE(d.apply);
}

TEST(RollerLabLogic, RefusedWhenNotAccepted) {
  auto logic = makeLogic(false);
  const auto d = logic.onLab(0.5, 10.0, false, false);
  EXPECT_FALSE(d.apply);
  EXPECT_EQ(d.refusal, Refusal::kNotAccepted);
  EXPECT_FALSE(logic.labActive());
}

TEST(RollerLabLogic, RefusedWhileControllerLatchIsOn) {
  auto logic = makeLogic();
  const auto d = logic.onLab(0.5, 10.0, /*joy_active=*/true, false);
  EXPECT_FALSE(d.apply);
  EXPECT_EQ(d.refusal, Refusal::kController);
  EXPECT_STREQ(logic.sourceName(true), "joy");
}

TEST(RollerLabLogic, RefusedWithinJoyQuietWindow) {
  auto logic = makeLogic();
  logic.onJoyButton(true, 10.0);
  logic.onJoyButton(false, 10.1);  // released
  EXPECT_EQ(logic.onLab(0.5, 10.9, false, false).refusal, Refusal::kController);
  EXPECT_EQ(logic.onLab(0.5, 11.0, false, false).refusal, Refusal::kController);
  const auto d = logic.onLab(0.5, 11.01, false, false);
  EXPECT_TRUE(d.apply);
  EXPECT_DOUBLE_EQ(d.command, 0.5);
}

TEST(RollerLabLogic, ReleasedButtonDoesNotCountAsActivity) {
  auto logic = makeLogic();
  logic.onJoyButton(false, 10.0);
  EXPECT_TRUE(logic.onLab(0.5, 10.1, false, false).apply);
}

TEST(RollerLabLogic, ControllerPressTakesOverAndLocksUntilZero) {
  auto logic = makeLogic();
  ASSERT_TRUE(logic.onLab(0.6, 10.0, false, false).apply);
  EXPECT_TRUE(logic.onJoyButton(true, 10.05));  // lab was driving: node stops it
  EXPECT_FALSE(logic.labActive());
  EXPECT_TRUE(logic.labLocked());

  // Still locked long after the controller is quiet, as long as the lab keeps asking.
  for (double t = 10.1; t < 13.0; t += 0.1) {
    logic.onTick(t);
    EXPECT_EQ(logic.onLab(0.6, t, false, false).refusal, Refusal::kLocked);
  }
  // 0 re-arms (and applies nothing: the lab is not driving).
  EXPECT_FALSE(logic.onLab(0.0, 13.0, false, false).apply);
  EXPECT_FALSE(logic.labLocked());
  EXPECT_TRUE(logic.onLab(0.6, 13.1, false, false).apply);
}

TEST(RollerLabLogic, PressWhileLabAsksLocksEvenIfRefused) {
  auto logic = makeLogic();
  logic.onJoyButton(true, 10.0);
  EXPECT_EQ(logic.onLab(0.5, 10.2, false, false).refusal, Refusal::kController);
  logic.onJoyButton(true, 10.3);  // lab asked recently: lock it
  EXPECT_TRUE(logic.labLocked());
  EXPECT_EQ(logic.onLab(0.5, 12.0, false, false).refusal, Refusal::kLocked);
}

TEST(RollerLabLogic, PressWhileLabIdleDoesNotLock) {
  auto logic = makeLogic();
  EXPECT_FALSE(logic.onJoyButton(true, 10.0));
  EXPECT_FALSE(logic.labLocked());
  EXPECT_TRUE(logic.onLab(0.5, 11.5, false, false).apply);
}

TEST(RollerLabLogic, LockClearsWhenLabGoesQuiet) {
  auto logic = makeLogic();
  logic.onLab(0.6, 10.0, false, false);
  logic.onJoyButton(true, 10.1);
  ASSERT_TRUE(logic.labLocked());
  logic.onTick(10.9);
  EXPECT_TRUE(logic.labLocked());
  logic.onTick(11.1);  // no lab message for > timeout: that run is over
  EXPECT_FALSE(logic.labLocked());
}

TEST(RollerLabLogic, TimeoutStopsLabRoller) {
  auto logic = makeLogic();
  logic.onLab(0.5, 10.0, false, false);
  EXPECT_FALSE(logic.onTick(10.5));
  EXPECT_FALSE(logic.onTick(11.0));  // strict '>'
  EXPECT_TRUE(logic.onTick(11.05));
  EXPECT_FALSE(logic.labActive());
  EXPECT_FALSE(logic.onTick(11.2));  // fires once
  // A fresh heartbeat after a timeout may start again (bridge dead-man sends 0 anyway).
  EXPECT_TRUE(logic.onLab(0.5, 11.3, false, false).apply);
}

TEST(RollerLabLogic, HeartbeatKeepsLabRollerRunning) {
  auto logic = makeLogic();
  for (double t = 10.0; t < 15.0; t += 0.1) {
    logic.onLab(0.5, t, false, false);
    EXPECT_FALSE(logic.onTick(t + 0.05));
  }
  EXPECT_TRUE(logic.labActive());
}

TEST(RollerLabLogic, RefusedDuringEmergencyStopAndLockedAfterRelease) {
  auto logic = makeLogic();
  const auto d = logic.onLab(0.5, 10.0, false, /*estop=*/true);
  EXPECT_FALSE(d.apply);
  EXPECT_EQ(d.refusal, Refusal::kEmergencyStop);
  // Released, but the same heartbeat must not restart the roller.
  EXPECT_EQ(logic.onLab(0.5, 10.1, false, false).refusal, Refusal::kLocked);
  logic.onLab(0.0, 10.2, false, false);
  EXPECT_TRUE(logic.onLab(0.5, 10.3, false, false).apply);
}

TEST(RollerLabLogic, EmergencyStopEdgeStopsAndLocksLabRoller) {
  auto logic = makeLogic();
  logic.onLab(0.5, 10.0, false, false);
  EXPECT_TRUE(logic.onEmergencyStop(true, 10.05));
  EXPECT_FALSE(logic.labActive());
  EXPECT_TRUE(logic.labLocked());
  EXPECT_FALSE(logic.onEmergencyStop(false, 10.5));
  EXPECT_EQ(logic.onLab(0.5, 10.6, false, false).refusal, Refusal::kLocked);
}

TEST(RollerLabLogic, EmergencyStopWhileLabIdleDoesNotLock) {
  auto logic = makeLogic();
  EXPECT_FALSE(logic.onEmergencyStop(true, 10.0));
  EXPECT_FALSE(logic.labLocked());
}

TEST(RollerLabLogic, RefusalNames) {
  EXPECT_STREQ(RollerLabLogic::refusalName(Refusal::kNotAccepted), "not_accepted");
  EXPECT_STREQ(RollerLabLogic::refusalName(Refusal::kLocked), "controller_lock");
  EXPECT_STREQ(RollerLabLogic::refusalName(Refusal::kEmergencyStop), "emergency_stop");
  EXPECT_STREQ(RollerLabLogic::refusalName(Refusal::kController), "controller");
}

TEST(RollerStatusJson, FormatsAllFields) {
  RollerStatus status;
  status.command = 0.5;
  status.source = "lab";
  status.lab_accepted = true;
  status.lab_locked = false;
  status.estop = false;
  status.lab_max_speed = 0.8;
  EXPECT_EQ(rollerStatusJson(status),
            "{\"command\": 0.500, \"source\": \"lab\", \"lab_accepted\": true, "
            "\"lab_locked\": false, \"estop\": false, \"lab_max_speed\": 0.800}");
}

TEST(RollerStatusJson, NonFiniteBecomesZero) {
  RollerStatus status;
  status.command = std::numeric_limits<double>::infinity();
  const std::string json = rollerStatusJson(status);
  EXPECT_NE(json.find("\"command\": 0.000"), std::string::npos);
  EXPECT_NE(json.find("\"source\": \"idle\""), std::string::npos);
}

}  // namespace
