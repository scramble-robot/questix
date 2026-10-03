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
  in.teacher_permission.required =
      true;  // the opt-in, so the teacher permission rules are exercised
  in.estop.known = true;
  in.estop.active = false;
  in.estop.age_sec = 0.1;
  in.teacher_permission.known = true;
  in.teacher_permission.allowed = true;
  in.teacher_permission.age_sec = 0.1;
  return in;
}

}  // namespace

TEST(RollerGate, OpenOnlyWithAFreshReleaseAndTheTeachersPermission) {
  EXPECT_EQ(evaluateRollerGate(open()), RollerBlock::kNone);
}

TEST(RollerGate, DefaultsRequireTheEstopButNotTheTeacherPermission) {
  RollerGateInputs in;
  EXPECT_TRUE(in.estop.required);
  EXPECT_FALSE(in.teacher_permission.required);
  in.estop.known = true;
  in.estop.active = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kNone);
}

TEST(RollerGate, NothingHeardIsClosedEstopFirst) {
  RollerGateInputs in;
  in.teacher_permission.required = true;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kEstopUnknown);
  in.estop.known = true;
  in.estop.active = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kTeacherPermissionUnknown);
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

// The diagnostic opt-out without the teacher permission opt-in: the roller may spin with nothing
// heard, a silent E-stop is not a stop, a pressed one still is.
TEST(RollerGate, DiagnosticOptOutWithoutTeacherPermissionSpinsWithNothingHeard) {
  RollerGateInputs in;  // nothing heard
  in.estop.required = false;
  in.teacher_permission.required = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kNone);
  in.estop.known = true;
  in.estop.active = false;
  in.estop.age_sec = 30.0;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kNone);
  in.estop.active = true;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kEstopActive);
}

// The teacher's permission is not an emergency stop: it decides on its own when opted in.
TEST(RollerGate, TeacherPermissionIsIndependentOfTheEstop) {
  RollerGateInputs in;  // nothing heard
  in.estop.required = false;
  in.teacher_permission.required = true;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kTeacherPermissionUnknown);
  EXPECT_FALSE(esc_motor_control_cpp::isRollerEstopBlock(evaluateRollerGate(in)));
  in.teacher_permission.known = true;
  in.teacher_permission.allowed = false;
  in.teacher_permission.age_sec = 0.1;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kTeacherPermissionOff);
  EXPECT_FALSE(esc_motor_control_cpp::isRollerEstopBlock(evaluateRollerGate(in)));
}

TEST(RollerGate, TeacherPermissionIsALease) {
  auto in = open();
  in.teacher_permission.allowed = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kTeacherPermissionOff);
  in = open();
  in.teacher_permission.age_sec = 1.2;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kTeacherPermissionStale);
  in.teacher_permission.timeout_sec = 0.0;  // invalid: falls back to 1.0, never endless
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kTeacherPermissionStale);
}

TEST(RollerGate, CompetitionDoesNotNeedTheClassroomHeartbeat) {
  auto in = open();
  in.teacher_permission.required = false;
  in.teacher_permission.known = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kNone);
}

TEST(RollerGate, ReasonsAreSeparate) {
  EXPECT_TRUE(esc_motor_control_cpp::isRollerEstopBlock(RollerBlock::kEstopStale));
  EXPECT_FALSE(esc_motor_control_cpp::isRollerEstopBlock(RollerBlock::kTeacherPermissionOff));
  EXPECT_TRUE(
      esc_motor_control_cpp::isRollerTeacherPermissionBlock(RollerBlock::kTeacherPermissionStale));
  EXPECT_FALSE(esc_motor_control_cpp::isRollerTeacherPermissionBlock(RollerBlock::kEstopActive));
  EXPECT_STREQ(esc_motor_control_cpp::rollerBlockName(RollerBlock::kTeacherPermissionOff),
               "teacher_permission_off");
}

// Disabled means disabled: a teacher permission that is not required is never looked at.
TEST(RollerGate, DisabledTeacherPermissionIsNeverLookedAt) {
  esc_motor_control_cpp::RollerTeacherPermissionInputs teacher_permission;
  teacher_permission.required = false;
  for (const bool known : {false, true}) {
    for (const bool allowed : {false, true}) {
      for (const double age : {0.0, 5.0, std::numeric_limits<double>::quiet_NaN()}) {
        teacher_permission.known = known;
        teacher_permission.allowed = allowed;
        teacher_permission.age_sec = age;
        EXPECT_EQ(esc_motor_control_cpp::evaluateRollerTeacherPermission(teacher_permission),
                  RollerBlock::kNone);
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
