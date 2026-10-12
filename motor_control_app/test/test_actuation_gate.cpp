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
  in.permission.known = true;
  in.permission.allowed = true;
  in.permission.age_sec = 0.1;
  in.estop.known = true;
  in.estop.active = false;
  in.estop.age_sec = 0.1;
  return in;
}

}  // namespace

TEST(ActuationGate, OpenOnlyWithAFreshPermissionAndAFreshRelease) {
  EXPECT_EQ(gate::evaluate(open()), Block::kNone);
}

// The defaults: both the motion permission and the E-stop are required (fail-closed).
TEST(ActuationGate, DefaultsRequireThePermissionAndTheEstop) {
  gate::Inputs in;
  EXPECT_TRUE(in.permission.required);
  EXPECT_TRUE(in.estop.required);
  EXPECT_DOUBLE_EQ(in.permission.timeout_sec, 0.5);
  EXPECT_EQ(gate::evaluate(in), Block::kEstopUnknown);
  in.estop.known = true;
  in.estop.active = false;
  EXPECT_EQ(gate::evaluate(in), Block::kPermissionUnknown);  // no /motion_permission yet
}

// At boot nothing has been heard: closed, and the E-stop (the last gate) is the reason.
TEST(ActuationGate, BootWithNothingHeardIsClosedEstopReported) {
  gate::Inputs in;
  EXPECT_EQ(gate::evaluate(in), Block::kEstopUnknown);
  in.permission.known = true;
  in.permission.allowed = true;
  EXPECT_EQ(gate::evaluate(in), Block::kEstopUnknown);
  in.estop.known = true;
  in.estop.active = false;
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
}

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

// A full diagnostic opt-out (neither required): nothing has to be heard first and silence is not a
// stop, but a received pressed E-stop and an unconfirmed stop still are.
TEST(ActuationGate, DiagnosticOptOutOfBothMovesWithNothingHeard) {
  gate::Inputs in;  // nothing heard
  in.estop.required = false;
  in.permission.required = false;
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

// The motion permission is not an emergency stop: its reasons never read as E-stop reasons.
TEST(ActuationGate, PermissionReasonsAreNotEstopReasons) {
  auto in = open();
  in.permission.allowed = false;  // the referee or the teacher says no
  EXPECT_EQ(gate::evaluate(in), Block::kPermissionOff);
  EXPECT_TRUE(gate::isPermissionBlock(gate::evaluate(in)));
  EXPECT_FALSE(gate::isEstopBlock(gate::evaluate(in)));
}

// The permission is a lease: silence closes it, even with an invalid timeout.
TEST(ActuationGate, PermissionOffOrSilentCloses) {
  auto in = open();
  in.permission.age_sec = 0.6;
  EXPECT_EQ(gate::evaluate(in), Block::kPermissionStale);
  in.permission.timeout_sec = 0.0;
  EXPECT_EQ(gate::evaluate(in), Block::kPermissionStale);
  in.permission.timeout_sec = std::numeric_limits<double>::infinity();
  EXPECT_EQ(gate::evaluate(in), Block::kPermissionStale);
  in.permission.timeout_sec = 1.0;
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
}

// The order of the gates: L2 (permission), then L1 (E-stop). Moving needs both; when both are
// closed the E-stop, the last gate before the motors, is the reason.
TEST(ActuationGate, TheEstopWinsWhenBothAreClosed) {
  auto in = open();
  in.permission.allowed = false;
  in.estop.active = true;
  EXPECT_EQ(gate::evaluate(in), Block::kEstopActive);
  in.estop.active = false;
  EXPECT_EQ(gate::evaluate(in), Block::kPermissionOff);
  in.permission.allowed = true;
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
}

// An unconfirmed stop keeps the gate closed whatever else says.
TEST(ActuationGate, StopFaultOverridesEverything) {
  auto in = open();
  in.stop_fault = true;
  EXPECT_EQ(gate::evaluate(in), Block::kStopFault);
  in.estop.active = true;
  EXPECT_EQ(gate::evaluate(in), Block::kStopFault);
}

TEST(ActuationGate, BlockNames) {
  EXPECT_TRUE(gate::isEstopBlock(Block::kEstopUnknown));
  EXPECT_TRUE(gate::isEstopBlock(Block::kEstopStale));
  EXPECT_FALSE(gate::isEstopBlock(Block::kPermissionOff));
  EXPECT_FALSE(gate::isEstopBlock(Block::kPermissionStale));
  EXPECT_FALSE(gate::isPermissionBlock(Block::kEstopActive));
  EXPECT_STREQ(gate::blockName(Block::kPermissionUnknown), "permission_unknown");
  EXPECT_STREQ(gate::blockName(Block::kPermissionStale), "permission_stale");
  EXPECT_STREQ(gate::blockName(Block::kPermissionOff), "permission_off");
  EXPECT_STREQ(gate::blockName(Block::kEstopActive), "estop_active");
}

// Closing stops at once and disarms; reopening never re-arms.
TEST(ActuationGate, ClosingStopsOnceAndReopeningDoesNotRestart) {
  EXPECT_EQ(gate::decideGateAction(Block::kNone, Block::kEstopActive, true),
            GateAction::kSafetyStop);
  EXPECT_EQ(gate::decideGateAction(Block::kNone, Block::kPermissionOff, false),
            GateAction::kSafetyStop);  // the edge always sends a stop
  // Still closed, nothing armed: no stop spam (the idle path keeps only a zero alive).
  EXPECT_EQ(gate::decideGateAction(Block::kEstopActive, Block::kEstopActive, false),
            GateAction::kNone);
  // Still closed but something armed (a command raced the edge): stop again.
  EXPECT_EQ(gate::decideGateAction(Block::kEstopActive, Block::kPermissionOff, true),
            GateAction::kSafetyStop);
  // Reopened: nothing to do; arming needs a fresh /target_twist.
  EXPECT_EQ(gate::decideGateAction(Block::kPermissionOff, Block::kNone, false), GateAction::kNone);
}

// An unconfirmed stop is retried at a bounded rate.
TEST(ActuationGate, StopRetryIsBounded) {
  EXPECT_FALSE(gate::shouldRetryStop(false, 10.0, 0.5));
  EXPECT_FALSE(gate::shouldRetryStop(true, 0.2, 0.5));
  EXPECT_TRUE(gate::shouldRetryStop(true, 0.5, 0.5));
  EXPECT_TRUE(gate::shouldRetryStop(true, 0.6, 0.0));  // invalid period -> 0.5 s
  EXPECT_FALSE(gate::shouldRetryStop(true, std::numeric_limits<double>::quiet_NaN(), 0.5));
}

// The two concepts are judged by separate functions: the E-stop never looks at the permission
// and the permission never looks at the E-stop.
TEST(ActuationGate, EstopAndPermissionAreEvaluatedSeparately) {
  gate::EstopInputs estop;
  estop.known = true;
  estop.active = false;
  EXPECT_EQ(gate::evaluateEstop(estop), Block::kNone);
  estop.active = true;
  EXPECT_EQ(gate::evaluateEstop(estop), Block::kEstopActive);

  gate::PermissionInputs permission;
  EXPECT_EQ(gate::evaluatePermission(permission), Block::kPermissionUnknown);
  permission.known = true;
  permission.allowed = true;
  EXPECT_EQ(gate::evaluatePermission(permission), Block::kNone);
  permission.required = false;
  permission.allowed = false;
  EXPECT_EQ(gate::evaluatePermission(permission), Block::kNone);  // disabled: not looked at
}

// An E-stop that is not required (diagnostic opt-out) only stops on a received pressed state:
// never heard, released, or silent for any time is not a stop.
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

// Practice: operation_manager publishes /emergency_stop (released, also without the GPIO safety
// path) and MotionPermissionManager publishes an allowed /motion_permission (no vote needed), so
// the drive may move; when either publisher goes silent the drive stops.
TEST(ActuationGate, PracticeMovesOnTheTwoPublishersAndStopsWhenEitherDies) {
  gate::Inputs in;  // the integrated defaults
  in.estop.known = true;
  in.estop.active = false;  // "released (no GPIO safety path)"
  in.estop.age_sec = 0.1;
  in.permission.known = true;
  in.permission.allowed = true;  // practice: always allowed
  in.permission.age_sec = 0.05;
  EXPECT_EQ(gate::evaluate(in), Block::kNone);
  in.permission.age_sec = 0.8;  // MotionPermissionManager died
  EXPECT_EQ(gate::evaluate(in), Block::kPermissionStale);
  in.permission.age_sec = 0.05;
  in.estop.age_sec = 1.5;  // operation_manager died
  EXPECT_EQ(gate::evaluate(in), Block::kEstopStale);
}
