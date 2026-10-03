// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#include <gtest/gtest.h>

#include <limits>

#include "motor_control_app/actuation_gate.hpp"

namespace gate = motor_control_app::actuation_gate;
using gate::Block;
using gate::GateAction;

namespace {

// Everything fresh and allowed: the gate is open.
gate::Inputs open() {
  gate::Inputs in;
  in.estop_known = true;
  in.estop_active = false;
  in.estop_age_sec = 0.1;
  in.authority_known = true;
  in.authority_allowed = true;
  in.authority_age_sec = 0.1;
  return in;
}

}  // namespace

TEST(ActuationGate, OpenOnlyWithAFreshReleaseAndTheTeachersAuthority) {
  EXPECT_EQ(gate::evaluate(open()), Block::kNone);
}

// A1 / A11: at boot nothing has been heard: closed, E-stop first.
TEST(ActuationGate, BootWithNothingHeardIsClosed) {
  gate::Inputs in;  // defaults: nothing known, both required
  EXPECT_EQ(gate::evaluate(in), Block::kEstopUnknown);
  in.estop_known = true;
  in.estop_active = false;
  EXPECT_EQ(gate::evaluate(in), Block::kAuthorityUnknown);
}

// A2: a pressed E-stop closes the gate.
TEST(ActuationGate, PressedEstopCloses) {
  auto in = open();
  in.estop_active = true;
  EXPECT_EQ(gate::evaluate(in), Block::kEstopActive);
}

TEST(ActuationGate, SilentEstopAfterFirstMessageIsStale) {
  auto in = open();
  in.estop_age_sec = 1.2;
  EXPECT_EQ(gate::evaluate(in), Block::kEstopStale);
  in.estop_age_sec = 1.0;  // exactly the timeout is still fresh
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
  in.estop_age_sec = std::numeric_limits<double>::quiet_NaN();
  EXPECT_EQ(gate::evaluate(in), Block::kEstopStale);  // an unknown age is never fresh
  in.estop_timeout_sec = 0.0;                         // staleness check disabled explicitly
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
}

TEST(ActuationGate, DiagnosticOptOutStillStopsOnAPressedEstop) {
  gate::Inputs in = open();
  in.require_estop = false;
  in.estop_known = false;
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
  in.estop_known = true;
  in.estop_active = true;
  EXPECT_EQ(gate::evaluate(in), Block::kEstopActive);
}

// A practice launch without the GPIO safety path (enable_gpio_ref:=false) and without the
// teacher's authority opt-in (the questix_core default) moves like 3.2.0: nothing has to be
// heard first and a silent /emergency_stop is not a stop, but a received pressed one still is.
TEST(ActuationGate, PracticeWithoutGpioRefAndAuthorityMovesWithNothingHeard) {
  gate::Inputs in;  // nothing heard
  in.require_estop = false;
  in.require_authority = false;
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
  in.estop_known = true;
  in.estop_active = false;
  in.estop_age_sec = 30.0;  // no publisher any more: not stale when not required
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
  in.estop_active = true;
  EXPECT_EQ(gate::evaluate(in), Block::kEstopActive);
  in.estop_active = false;
  in.stop_fault = true;  // an unconfirmed stop still closes it
  EXPECT_EQ(gate::evaluate(in), Block::kStopFault);
}

// The teacher's authority is not an emergency stop: with the E-stop path off (no publisher) an
// opted-in authority still decides on its own, and its reasons never read as E-stop reasons.
TEST(ActuationGate, AuthorityIsIndependentOfTheEstop) {
  gate::Inputs in;  // nothing heard
  in.require_estop = false;
  EXPECT_EQ(gate::evaluate(in), Block::kAuthorityUnknown);
  EXPECT_FALSE(gate::isEstopBlock(gate::evaluate(in)));
  in.authority_known = true;
  in.authority_allowed = true;
  in.authority_age_sec = 0.1;
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
  in.authority_allowed = false;
  EXPECT_EQ(gate::evaluate(in), Block::kAuthorityOff);
  EXPECT_FALSE(gate::isEstopBlock(gate::evaluate(in)));
}

// A11 / A12: the teacher's authority is a lease.
TEST(ActuationGate, AuthorityOffOrSilentCloses) {
  auto in = open();
  in.authority_allowed = false;
  EXPECT_EQ(gate::evaluate(in), Block::kAuthorityOff);
  in = open();
  in.authority_age_sec = 1.5;
  EXPECT_EQ(gate::evaluate(in), Block::kAuthorityStale);
  // Even an invalid timeout cannot make the lease endless.
  in.authority_timeout_sec = 0.0;
  EXPECT_EQ(gate::evaluate(in), Block::kAuthorityStale);
  in.authority_timeout_sec = std::numeric_limits<double>::infinity();
  EXPECT_EQ(gate::evaluate(in), Block::kAuthorityStale);
}

// A18: competition launches do not require the classroom heartbeat.
TEST(ActuationGate, CompetitionDoesNotNeedTheClassroomHeartbeat) {
  gate::Inputs in = open();
  in.require_authority = false;
  in.authority_known = false;
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
  in.estop_active = true;  // but the E-stop still applies
  EXPECT_EQ(gate::evaluate(in), Block::kEstopActive);
}

// A14: an unconfirmed stop keeps the gate closed whatever else says.
TEST(ActuationGate, StopFaultOverridesEverything) {
  auto in = open();
  in.stop_fault = true;
  EXPECT_EQ(gate::evaluate(in), Block::kStopFault);
}

TEST(ActuationGate, EstopReasonsAreNotAuthorityReasons) {
  EXPECT_TRUE(gate::isEstopBlock(Block::kEstopUnknown));
  EXPECT_TRUE(gate::isEstopBlock(Block::kEstopStale));
  EXPECT_FALSE(gate::isEstopBlock(Block::kAuthorityOff));
  EXPECT_FALSE(gate::isEstopBlock(Block::kAuthorityStale));
  EXPECT_STREQ(gate::blockName(Block::kAuthorityStale), "authority_stale");
}

// A2 / A9 / A12: closing stops at once and disarms; A3 / A10 / A13: reopening never re-arms.
TEST(ActuationGate, ClosingStopsOnceAndReopeningDoesNotRestart) {
  EXPECT_EQ(gate::decideGateAction(Block::kNone, Block::kEstopActive, true),
            GateAction::kSafetyStop);
  EXPECT_EQ(gate::decideGateAction(Block::kNone, Block::kAuthorityOff, false),
            GateAction::kSafetyStop);  // the edge always sends a stop
  // Still closed, nothing armed: no stop spam (the idle path keeps only a zero alive).
  EXPECT_EQ(gate::decideGateAction(Block::kEstopActive, Block::kEstopActive, false),
            GateAction::kNone);
  // Still closed but something armed (a command raced the edge): stop again.
  EXPECT_EQ(gate::decideGateAction(Block::kEstopActive, Block::kAuthorityOff, true),
            GateAction::kSafetyStop);
  // Reopened: nothing to do; arming needs a fresh /target_twist.
  EXPECT_EQ(gate::decideGateAction(Block::kEstopActive, Block::kNone, false), GateAction::kNone);
}

// A15: an unconfirmed stop is retried at a bounded rate.
TEST(ActuationGate, StopRetryIsBounded) {
  EXPECT_FALSE(gate::shouldRetryStop(false, 10.0, 0.5));
  EXPECT_FALSE(gate::shouldRetryStop(true, 0.2, 0.5));
  EXPECT_TRUE(gate::shouldRetryStop(true, 0.5, 0.5));
  EXPECT_TRUE(gate::shouldRetryStop(true, 0.6, 0.0));  // invalid period -> 0.5 s
  EXPECT_FALSE(gate::shouldRetryStop(true, std::numeric_limits<double>::quiet_NaN(), 0.5));
}
