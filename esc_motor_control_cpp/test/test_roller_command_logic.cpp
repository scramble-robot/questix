// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <limits>
#include <string>

#include "esc_motor_control_cpp/roller_command_logic.hpp"

using esc_motor_control_cpp::RollerCommandLogic;

namespace {

RollerCommandLogic ready(double timeout_sec = 1.0, double max_power = 1.0) {
  RollerCommandLogic logic;
  logic.configure(timeout_sec, max_power);
  logic.onCommand(0.0, 0.0, false);  // the stream starts at rest
  return logic;
}

}  // namespace

TEST(RollerCommandLogic, FollowsTheLevel) {
  auto logic = ready();
  auto result = logic.onCommand(0.6, 0.1, false);
  EXPECT_TRUE(result.set);
  EXPECT_DOUBLE_EQ(result.speed, 0.6);
  EXPECT_FALSE(logic.onCommand(0.6, 0.2, false).set);  // unchanged: nothing to send
  result = logic.onCommand(0.0, 0.3, false);
  EXPECT_TRUE(result.set);
  EXPECT_DOUBLE_EQ(logic.speed(), 0.0);
}

TEST(RollerCommandLogic, ANonZeroCommandAtStartNeedsAZeroFirst) {
  RollerCommandLogic logic;
  logic.configure(1.0, 1.0);
  auto result = logic.onCommand(1.0, 0.0, false);  // a button held while the node started
  EXPECT_FALSE(result.set);
  EXPECT_TRUE(result.needs_zero);
  logic.onCommand(0.0, 0.1, false);
  EXPECT_TRUE(logic.onCommand(1.0, 0.2, false).set);
}

TEST(RollerCommandLogic, SilenceStopsAndNeedsAZero) {
  auto logic = ready(1.0);
  logic.onCommand(0.8, 0.0, false);
  EXPECT_FALSE(logic.onTick(1.0).set);  // exactly the timeout: still fresh
  auto result = logic.onTick(1.05);
  EXPECT_TRUE(result.set && result.timed_out);
  EXPECT_DOUBLE_EQ(logic.speed(), 0.0);
  EXPECT_TRUE(logic.onCommand(0.8, 1.1, false).needs_zero);  // the stream came back still held
  logic.onCommand(0.0, 1.2, false);
  EXPECT_TRUE(logic.onCommand(0.8, 1.3, false).set);
  EXPECT_TRUE(logic.onTick(5.0).timed_out);
}

TEST(RollerCommandLogic, AClosedGateStopsAndNeedsAZeroAfterItOpens) {
  auto logic = ready();
  logic.onCommand(0.5, 0.0, false);
  auto result = logic.onCommand(0.5, 0.1, true);  // inhibited
  EXPECT_TRUE(result.set);
  EXPECT_DOUBLE_EQ(result.speed, 0.0);
  EXPECT_TRUE(logic.onCommand(0.5, 0.2, false).needs_zero);  // open again, still held
  logic.onCommand(0.0, 0.3, false);
  EXPECT_TRUE(logic.onCommand(0.5, 0.4, false).set);
  result = logic.inhibit();  // the gate closing on its own (timer)
  EXPECT_TRUE(result.set);
  EXPECT_TRUE(logic.requiresZero());
}

TEST(RollerCommandLogic, ValuesAreClampedAndNonFiniteIsZero) {
  auto logic = ready(1.0, 0.7);
  EXPECT_DOUBLE_EQ(logic.onCommand(2.0, 0.1, false).speed, 0.7);
  EXPECT_DOUBLE_EQ(logic.onCommand(-1.0, 0.2, false).speed, 0.0);
  logic.onCommand(0.5, 0.3, false);
  auto result = logic.onCommand(std::numeric_limits<double>::quiet_NaN(), 0.4, false);
  EXPECT_TRUE(result.set);
  EXPECT_DOUBLE_EQ(result.speed, 0.0);
}

TEST(RollerCommandLogic, InvalidSettingsFallBackSafely) {
  RollerCommandLogic logic;
  logic.configure(0.0, std::numeric_limits<double>::infinity());
  EXPECT_DOUBLE_EQ(logic.timeoutSec(), 1.0);  // a command always expires
  EXPECT_DOUBLE_EQ(logic.maxPower(), 0.0);    // an unusable cap spins nothing
}

TEST(RollerStatus, JsonHasOnlyTheMechanismsState) {
  esc_motor_control_cpp::RollerStatus status;
  status.command = 0.5;
  status.source = esc_motor_control_cpp::rollerSourceName("lab");
  status.max_power = 1.0;
  const std::string json = esc_motor_control_cpp::rollerStatusJson(status);
  EXPECT_EQ(json,
            "{\"command\": 0.500, \"source\": \"lab\", \"estop\": false, \"permission\": true, "
            "\"max_power\": 1.000, \"pwm_fault\": false, \"applied_pulse_us\": -1, "
            "\"pwm_backend\": \"none\", \"pwm_output_state\": \"UNKNOWN\", \"pwm_error\": 0}");
  EXPECT_STREQ(esc_motor_control_cpp::rollerSourceName("\"evil"), "other");
}

TEST(RollerStatus, ReportsPwmFailureWithoutRemovingMechanismFields) {
  esc_motor_control_cpp::RollerStatus status;
  status.pwm_fault = true;
  status.applied_pulse_us = 0;
  status.pwm_backend = "rp1_hw";
  status.pwm_output_state = "FAULT_LOW";
  status.pwm_error = -EIO;
  const auto json = esc_motor_control_cpp::rollerStatusJson(status);
  EXPECT_NE(json.find("\"pwm_fault\": true"), std::string::npos);
  EXPECT_NE(json.find("\"applied_pulse_us\": 0"), std::string::npos);
  EXPECT_NE(json.find("\"pwm_output_state\": \"FAULT_LOW\""), std::string::npos);
  EXPECT_NE(json.find("\"permission\": true"), std::string::npos);
}
