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
  in.estop_known = true;
  in.estop_active = false;
  in.estop_age_sec = 0.1;
  in.authority_known = true;
  in.authority_allowed = true;
  in.authority_age_sec = 0.1;
  return in;
}

}  // namespace

TEST(RollerGate, OpenOnlyWithAFreshReleaseAndTheTeachersAuthority) {
  EXPECT_EQ(evaluateRollerGate(open()), RollerBlock::kNone);
}

TEST(RollerGate, NothingHeardIsClosedEstopFirst) {
  RollerGateInputs in;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kEstopUnknown);
  in.estop_known = true;
  in.estop_active = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kAuthorityUnknown);
}

TEST(RollerGate, PressedOrSilentEstopCloses) {
  auto in = open();
  in.estop_active = true;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kEstopActive);
  in = open();
  in.estop_age_sec = 1.5;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kEstopStale);
  in.estop_age_sec = std::numeric_limits<double>::quiet_NaN();
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kEstopStale);
}

TEST(RollerGate, DiagnosticOptOutStillStopsOnAPressedEstop) {
  auto in = open();
  in.require_estop = false;
  in.estop_known = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kNone);
  in.estop_known = true;
  in.estop_active = true;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kEstopActive);
}

TEST(RollerGate, AuthorityIsALease) {
  auto in = open();
  in.authority_allowed = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kAuthorityOff);
  in = open();
  in.authority_age_sec = 1.2;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kAuthorityStale);
  in.authority_timeout_sec = 0.0;  // invalid: falls back to 1.0, never endless
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kAuthorityStale);
}

TEST(RollerGate, CompetitionDoesNotNeedTheClassroomHeartbeat) {
  auto in = open();
  in.require_authority = false;
  in.authority_known = false;
  EXPECT_EQ(evaluateRollerGate(in), RollerBlock::kNone);
}

TEST(RollerGate, ReasonsAreSeparate) {
  EXPECT_TRUE(esc_motor_control_cpp::isRollerEstopBlock(RollerBlock::kEstopStale));
  EXPECT_FALSE(esc_motor_control_cpp::isRollerEstopBlock(RollerBlock::kAuthorityOff));
  EXPECT_TRUE(esc_motor_control_cpp::isRollerAuthorityBlock(RollerBlock::kAuthorityStale));
  EXPECT_FALSE(esc_motor_control_cpp::isRollerAuthorityBlock(RollerBlock::kEstopActive));
  EXPECT_STREQ(esc_motor_control_cpp::rollerBlockName(RollerBlock::kAuthorityOff), "authority_off");
}
