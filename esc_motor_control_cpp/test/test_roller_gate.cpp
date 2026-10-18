// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <limits>

#include "esc_motor_control_cpp/roller_gate.hpp"

using esc_motor_control_cpp::evaluateRollerGate;
using esc_motor_control_cpp::RollerBlock;
using esc_motor_control_cpp::RollerGateInputs;

namespace {

RollerGateInputs open() {
  RollerGateInputs in;
  in.permission.known = true;
  in.permission.allowed = true;
  in.permission.age_sec = 0.1;
  in.estop.known = true;
  in.estop.active = false;
  in.estop.age_sec = 0.1;
  return in;
}

}  // namespace

TEST(RollerGate, OpenOnlyWithAFreshPermissionAndAFreshRelease) {
  EXPECT_EQ(evaluateRollerGate(open()), RollerBlock::kNone);
}

TEST(RollerGate, DefaultsRequireThePermissionAndTheEstop) {
  RollerGateInputs in;
  EXPECT_TRUE(in.estop.required);
  EXPECT_TRUE(in.permission.required);
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kEstopUnknown);
  in.estop.known = true;
  in.estop.active = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kPermissionUnknown);
}

TEST(RollerGate, PressedOrSilentEstopCloses) {
  auto in = open();
  in.estop.active = true;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kEstopActive);
  in = open();
  in.estop.age_sec = 1.5;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kEstopStale);
  in.estop.age_sec = std::numeric_limits<double>::quiet_NaN();
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kEstopStale);
}

TEST(RollerGate, DiagnosticOptOutStillStopsOnAPressedEstop) {
  auto in = open();
  in.estop.required = false;
  in.estop.known = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kNone);
  in.estop.known = true;
  in.estop.active = true;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kEstopActive);
}

// A full diagnostic opt-out: the roller may spin with nothing heard, a silent E-stop is not a
// stop, a pressed one still is.
TEST(RollerGate, DiagnosticOptOutOfBothSpinsWithNothingHeard) {
  RollerGateInputs in;  // nothing heard
  in.estop.required = false;
  in.permission.required = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kNone);
  in.estop.known = true;
  in.estop.active = false;
  in.estop.age_sec = 30.0;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kNone);
  in.estop.active = true;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kEstopActive);
}

// The motion permission is not an emergency stop: its reasons never read as E-stop reasons.
TEST(RollerGate, PermissionIsIndependentOfTheEstop) {
  RollerGateInputs in;  // nothing heard
  in.estop.required = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kPermissionUnknown);
  EXPECT_FALSE(esc_motor_control_cpp::isRollerEstopBlock(evaluateRollerGate(in)));
  in.permission.known = true;
  in.permission.allowed = false;
  in.permission.age_sec = 0.1;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kPermissionOff);
  EXPECT_FALSE(esc_motor_control_cpp::isRollerEstopBlock(evaluateRollerGate(in)));
}

TEST(RollerGate, PermissionIsALease) {
  auto in = open();
  in.permission.allowed = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kPermissionOff);
  in = open();
  in.permission.age_sec = 0.6;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kPermissionStale);
  in.permission.timeout_sec = 0.0;  // invalid: falls back to 0.5, never endless
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kPermissionStale);
}

// L2 then L1: when both are closed, the E-stop (the last gate) is the reason.
TEST(RollerGate, TheEstopWinsWhenBothAreClosed) {
  auto in = open();
  in.permission.allowed = false;
  in.estop.active = true;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kEstopActive);
  in.estop.active = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kPermissionOff);
}

TEST(RollerGate, ReasonsAreSeparate) {
  EXPECT_TRUE(esc_motor_control_cpp::isRollerEstopBlock(RollerBlock::kEstopStale));
  EXPECT_FALSE(esc_motor_control_cpp::isRollerEstopBlock(RollerBlock::kPermissionOff));
  EXPECT_TRUE(esc_motor_control_cpp::isRollerPermissionBlock(RollerBlock::kPermissionStale));
  EXPECT_FALSE(esc_motor_control_cpp::isRollerPermissionBlock(RollerBlock::kEstopActive));
  EXPECT_STREQ(esc_motor_control_cpp::rollerBlockName(RollerBlock::kPermissionOff),
               "permission_off");
  EXPECT_STREQ(esc_motor_control_cpp::rollerBlockName(RollerBlock::kPermissionUnknown),
               "permission_unknown");
}

// A not-required permission (diagnostic opt-out) is never looked at.
TEST(RollerGate, DisabledPermissionIsNeverLookedAt) {
  esc_motor_control_cpp::RollerPermissionInputs permission;
  permission.required = false;
  for (const bool known : {false, true}) {
    for (const bool allowed : {false, true}) {
      for (const double age : {0.0, 5.0, std::numeric_limits<double>::quiet_NaN()}) {
        permission.known = known;
        permission.allowed = allowed;
        permission.age_sec = age;
        EXPECT_EQ(esc_motor_control_cpp::evaluateRollerPermission(permission), RollerBlock::kNone);
      }
    }
  }
}

// A not-required E-stop only stops on a received pressed state.
TEST(RollerGate, NotRequiredEstopOnlyStopsWhenPressed) {
  esc_motor_control_cpp::RollerEstopInputs estop;
  estop.required = false;
  EXPECT_EQ(esc_motor_control_cpp::evaluateRollerEstop(estop), RollerBlock::kNone);
  estop.known = true;
  estop.active = false;
  estop.age_sec = 3600.0;
  EXPECT_EQ(esc_motor_control_cpp::evaluateRollerEstop(estop), RollerBlock::kNone);
  estop.active = true;
  EXPECT_EQ(esc_motor_control_cpp::evaluateRollerEstop(estop), RollerBlock::kEstopActive);
}

TEST(RollerGate, PwmFaultNeverOpensAGateAndDoesNotHideEstopOrPermission) {
  esc_motor_control_cpp::RollerGateInputs inputs;
  inputs.pwm_fault = true;
  inputs.permission.required = false;
  inputs.estop.required = false;
  EXPECT_EQ(esc_motor_control_cpp::evaluateRollerGate(inputs), RollerBlock::kPwmFault);
  inputs.permission.required = true;
  EXPECT_EQ(esc_motor_control_cpp::evaluateRollerGate(inputs), RollerBlock::kPermissionUnknown);
  inputs.estop.required = true;
  EXPECT_EQ(esc_motor_control_cpp::evaluateRollerGate(inputs), RollerBlock::kEstopUnknown);
  EXPECT_STREQ(esc_motor_control_cpp::rollerBlockName(RollerBlock::kPwmFault), "pwm_fault");
}
