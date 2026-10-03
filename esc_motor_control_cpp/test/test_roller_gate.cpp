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
  in.authority.required = true;  // the opt-in, so the authority rules are exercised
  in.estop.known = true;
  in.estop.active = false;
  in.estop.age_sec = 0.1;
  in.authority.known = true;
  in.authority.allowed = true;
  in.authority.age_sec = 0.1;
  return in;
}

}  // namespace

TEST(RollerGate, OpenOnlyWithAFreshReleaseAndTheTeachersAuthority) {
  EXPECT_EQ(evaluateRollerGate(open()), RollerBlock::kNone);
}

TEST(RollerGate, DefaultsRequireTheEstopButNotTheAuthority) {
  RollerGateInputs in;
  EXPECT_TRUE(in.estop.required);
  EXPECT_FALSE(in.authority.required);
  in.estop.known = true;
  in.estop.active = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kNone);
}

TEST(RollerGate, NothingHeardIsClosedEstopFirst) {
  RollerGateInputs in;
  in.authority.required = true;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kEstopUnknown);
  in.estop.known = true;
  in.estop.active = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kAuthorityUnknown);
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

// The diagnostic opt-out without the authority opt-in: the roller may spin with nothing heard,
// a silent E-stop is not a stop, a pressed one still is.
TEST(RollerGate, DiagnosticOptOutWithoutAuthoritySpinsWithNothingHeard) {
  RollerGateInputs in;  // nothing heard
  in.estop.required = false;
  in.authority.required = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kNone);
  in.estop.known = true;
  in.estop.active = false;
  in.estop.age_sec = 30.0;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kNone);
  in.estop.active = true;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kEstopActive);
}

// The teacher's authority is not an emergency stop: it decides on its own when opted in.
TEST(RollerGate, AuthorityIsIndependentOfTheEstop) {
  RollerGateInputs in;  // nothing heard
  in.estop.required = false;
  in.authority.required = true;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kAuthorityUnknown);
  EXPECT_FALSE(esc_motor_control_cpp::isRollerEstopBlock(evaluateRollerGate(in)));
  in.authority.known = true;
  in.authority.allowed = false;
  in.authority.age_sec = 0.1;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kAuthorityOff);
  EXPECT_FALSE(esc_motor_control_cpp::isRollerEstopBlock(evaluateRollerGate(in)));
}

TEST(RollerGate, AuthorityIsALease) {
  auto in = open();
  in.authority.allowed = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kAuthorityOff);
  in = open();
  in.authority.age_sec = 1.2;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kAuthorityStale);
  in.authority.timeout_sec = 0.0;  // invalid: falls back to 1.0, never endless
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kAuthorityStale);
}

TEST(RollerGate, CompetitionDoesNotNeedTheClassroomHeartbeat) {
  auto in = open();
  in.authority.required = false;
  in.authority.known = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kNone);
}

TEST(RollerGate, ReasonsAreSeparate) {
  EXPECT_TRUE(esc_motor_control_cpp::isRollerEstopBlock(RollerBlock::kEstopStale));
  EXPECT_FALSE(esc_motor_control_cpp::isRollerEstopBlock(RollerBlock::kAuthorityOff));
  EXPECT_TRUE(esc_motor_control_cpp::isRollerAuthorityBlock(RollerBlock::kAuthorityStale));
  EXPECT_FALSE(esc_motor_control_cpp::isRollerAuthorityBlock(RollerBlock::kEstopActive));
  EXPECT_STREQ(esc_motor_control_cpp::rollerBlockName(RollerBlock::kAuthorityOff), "authority_off");
}

// Disabled means disabled: an authority that is not required is never looked at.
TEST(RollerGate, DisabledAuthorityIsNeverLookedAt) {
  esc_motor_control_cpp::RollerAuthorityInputs authority;
  authority.required = false;
  for (const bool known : {false, true}) {
    for (const bool allowed : {false, true}) {
      for (const double age : {0.0, 5.0, std::numeric_limits<double>::quiet_NaN()}) {
        authority.known = known;
        authority.allowed = allowed;
        authority.age_sec = age;
        EXPECT_EQ(esc_motor_control_cpp::evaluateRollerAuthority(authority), RollerBlock::kNone);
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
