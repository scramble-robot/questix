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

// Everything required, fresh and allowed: the gate is open.
gate::Inputs open() {
  gate::Inputs in;
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

TEST(ActuationGate, OpenOnlyWithAFreshReleaseAndTheTeachersAuthority) {
  EXPECT_EQ(gate::evaluate(open()), Block::kNone);
}

// The defaults: the E-stop is required (fail-closed), the teacher's authority is not (opt-in).
TEST(ActuationGate, DefaultsRequireTheEstopButNotTheAuthority) {
  gate::Inputs in;
  EXPECT_TRUE(in.estop.required);
  EXPECT_FALSE(in.authority.required);
  EXPECT_EQ(gate::evaluate(in), Block::kEstopUnknown);
  in.estop.known = true;
  in.estop.active = false;
  EXPECT_EQ(gate::evaluate(in), Block::kNone);  // no heartbeat needed
}

// A1 / A11: at boot nothing has been heard: closed, E-stop first.
TEST(ActuationGate, BootWithNothingHeardIsClosed) {
  gate::Inputs in;  // nothing known, both required
  in.authority.required = true;
  EXPECT_EQ(gate::evaluate(in), Block::kEstopUnknown);
  in.estop.known = true;
  in.estop.active = false;
  EXPECT_EQ(gate::evaluate(in), Block::kAuthorityUnknown);
}

// A2: a pressed E-stop closes the gate.
TEST(ActuationGate, PressedEstopCloses) {
  auto in = open();
  in.estop.active = true;
  EXPECT_EQ(gate::evaluate(in), Block::kEstopActive);
}

TEST(ActuationGate, SilentEstopAfterFirstMessageIsStale) {
  auto in = open();
  in.estop.age_sec = 1.2;
  EXPECT_EQ(gate::evaluate(in), Block::kEstopStale);
  in.estop.age_sec = 1.0;  // exactly the timeout is still fresh
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
  in.estop.age_sec = std::numeric_limits<double>::quiet_NaN();
  EXPECT_EQ(gate::evaluate(in), Block::kEstopStale);  // an unknown age is never fresh
  in.estop.timeout_sec = 0.0;                         // staleness check disabled explicitly
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
}

TEST(ActuationGate, DiagnosticOptOutStillStopsOnAPressedEstop) {
  gate::Inputs in = open();
  in.estop.required = false;
  in.estop.known = false;
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
  in.estop.known = true;
  in.estop.active = true;
  EXPECT_EQ(gate::evaluate(in), Block::kEstopActive);
}

// A practice launch without the GPIO safety path (enable_gpio_ref:=false) and without the
// teacher's authority opt-in (the questix_core default) moves like 3.2.0: nothing has to be
// heard first and a silent /emergency_stop is not a stop, but a received pressed one still is.
TEST(ActuationGate, PracticeWithoutGpioRefAndAuthorityMovesWithNothingHeard) {
  gate::Inputs in;  // nothing heard
  in.estop.required = false;
  in.authority.required = false;
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
  in.estop.known = true;
  in.estop.active = false;
  in.estop.age_sec = 30.0;  // no publisher any more: not stale when not required
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
  in.estop.active = true;
  EXPECT_EQ(gate::evaluate(in), Block::kEstopActive);
  in.estop.active = false;
  in.stop_fault = true;  // an unconfirmed stop still closes it
  EXPECT_EQ(gate::evaluate(in), Block::kStopFault);
}

// The teacher's authority is not an emergency stop: with the E-stop path off (no publisher) an
// opted-in authority still decides on its own, and its reasons never read as E-stop reasons.
TEST(ActuationGate, AuthorityIsIndependentOfTheEstop) {
  gate::Inputs in;  // nothing heard
  in.estop.required = false;
  in.authority.required = true;
  EXPECT_EQ(gate::evaluate(in), Block::kAuthorityUnknown);
  EXPECT_FALSE(gate::isEstopBlock(gate::evaluate(in)));
  in.authority.known = true;
  in.authority.allowed = true;
  in.authority.age_sec = 0.1;
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
  in.authority.allowed = false;
  EXPECT_EQ(gate::evaluate(in), Block::kAuthorityOff);
  EXPECT_FALSE(gate::isEstopBlock(gate::evaluate(in)));
}

// A11 / A12: the teacher's authority is a lease.
TEST(ActuationGate, AuthorityOffOrSilentCloses) {
  auto in = open();
  in.authority.allowed = false;
  EXPECT_EQ(gate::evaluate(in), Block::kAuthorityOff);
  in = open();
  in.authority.age_sec = 1.5;
  EXPECT_EQ(gate::evaluate(in), Block::kAuthorityStale);
  // Even an invalid timeout cannot make the lease endless.
  in.authority.timeout_sec = 0.0;
  EXPECT_EQ(gate::evaluate(in), Block::kAuthorityStale);
  in.authority.timeout_sec = std::numeric_limits<double>::infinity();
  EXPECT_EQ(gate::evaluate(in), Block::kAuthorityStale);
}

// A18: competition launches do not require the classroom heartbeat.
TEST(ActuationGate, CompetitionDoesNotNeedTheClassroomHeartbeat) {
  gate::Inputs in = open();
  in.authority.required = false;
  in.authority.known = false;
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
  in.estop.active = true;  // but the E-stop still applies
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

// The two concepts are judged by separate functions: the E-stop never looks at the authority and
// the authority never looks at the E-stop.
TEST(ActuationGate, EstopAndAuthorityAreEvaluatedSeparately) {
  gate::EstopInputs estop;
  estop.known = true;
  estop.active = false;
  EXPECT_EQ(gate::evaluateEstop(estop), Block::kNone);
  estop.active = true;
  EXPECT_EQ(gate::evaluateEstop(estop), Block::kEstopActive);

  gate::AuthorityInputs authority;
  authority.required = true;
  EXPECT_EQ(gate::evaluateAuthority(authority), Block::kAuthorityUnknown);
  authority.known = true;
  authority.allowed = true;
  EXPECT_EQ(gate::evaluateAuthority(authority), Block::kNone);

  // Combined: the E-stop reason wins, and an authority reason is never an E-stop reason.
  gate::Inputs in;
  in.estop = estop;
  in.authority = authority;
  EXPECT_EQ(gate::evaluate(in), Block::kEstopActive);
  in.estop.active = false;
  in.authority.allowed = false;
  EXPECT_EQ(gate::evaluate(in), Block::kAuthorityOff);
  EXPECT_TRUE(gate::isAuthorityBlock(gate::evaluate(in)));
  EXPECT_FALSE(gate::isEstopBlock(gate::evaluate(in)));
}

// Disabled means disabled: an authority that is not required allows whatever its other fields
// say (never heard, said off, silent for ages, invalid lease).
TEST(ActuationGate, DisabledAuthorityIsNeverLookedAt) {
  gate::AuthorityInputs authority;
  authority.required = false;
  for (const bool known : {false, true}) {
    for (const bool allowed : {false, true}) {
      for (const double age : {0.0, 5.0, std::numeric_limits<double>::quiet_NaN()}) {
        authority.known = known;
        authority.allowed = allowed;
        authority.age_sec = age;
        authority.timeout_sec = 0.0;
        EXPECT_EQ(gate::evaluateAuthority(authority), Block::kNone);
      }
    }
  }
}

// An E-stop that is not required (no publisher, enable_gpio_ref:=false) only stops on a received
// pressed state: never heard, released, or silent for any time is not a stop.
TEST(ActuationGate, NotRequiredEstopOnlyStopsWhenPressed) {
  gate::EstopInputs estop;
  estop.required = false;
  EXPECT_EQ(gate::evaluateEstop(estop), Block::kNone);  // never heard (active stays true)
  estop.known = true;
  estop.active = false;
  for (const double age : {0.0, 1.5, 3600.0, std::numeric_limits<double>::quiet_NaN()}) {
    estop.age_sec = age;
    EXPECT_EQ(gate::evaluateEstop(estop), Block::kNone);
  }
  estop.active = true;
  EXPECT_EQ(gate::evaluateEstop(estop), Block::kEstopActive);
}
