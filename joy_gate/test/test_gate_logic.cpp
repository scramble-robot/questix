// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include "joy_gate/gate_logic.hpp"

namespace {

joy_gate::GateLogic makeGate(double timeout_sec = 1.0) {
  joy_gate::GateLogic gate;
  gate.configure(timeout_sec);
  return gate;
}

}  // namespace

TEST(GateLogicTest, InitiallyUncontrollable) {
  auto gate = makeGate();
  EXPECT_FALSE(gate.isControllable());
}

TEST(GateLogicTest, NoStartupFalseFireBeforeAnyMessage) {
  auto gate = makeGate(1.0);
  // No message has ever been received; the timer must not report anything.
  const auto r = gate.onTimerCheck(1000.0);
  EXPECT_FALSE(r.changed);
  EXPECT_FALSE(r.publish_zero);
  EXPECT_FALSE(r.timed_out);
  EXPECT_FALSE(r.recovered);
  EXPECT_FALSE(gate.isControllable());
}

TEST(GateLogicTest, MessageTrueThenFalseTransitions) {
  auto gate = makeGate();

  const auto r_true = gate.onControllableMsg(true, 0.0);
  EXPECT_TRUE(r_true.changed);
  EXPECT_FALSE(r_true.publish_zero);
  EXPECT_TRUE(gate.isControllable());

  const auto r_false = gate.onControllableMsg(false, 0.1);
  EXPECT_TRUE(r_false.changed);
  EXPECT_TRUE(r_false.publish_zero);
  EXPECT_FALSE(gate.isControllable());
}

TEST(GateLogicTest, RegularMessagesNeverTimeOut) {
  auto gate = makeGate(1.0);
  gate.onControllableMsg(true, 0.0);

  // Messages every 0.5s, checked every 0.1s, for 5 simulated seconds.
  double t = 0.0;
  double next_msg = 0.5;
  while (t <= 5.0) {
    if (t >= next_msg) {
      const auto r = gate.onControllableMsg(true, t);
      EXPECT_FALSE(r.timed_out);
      next_msg += 0.5;
    }
    const auto r = gate.onTimerCheck(t);
    EXPECT_FALSE(r.timed_out);
    t += 0.1;
  }
  EXPECT_TRUE(gate.isControllable());
}

TEST(GateLogicTest, BoundaryExactlyAtTimeoutDoesNotFire) {
  auto gate = makeGate(1.0);
  gate.onControllableMsg(true, 0.0);

  const auto r = gate.onTimerCheck(1.0);  // elapsed == timeout_sec: no fire
  EXPECT_FALSE(r.changed);
  EXPECT_FALSE(r.timed_out);
  EXPECT_TRUE(gate.isControllable());
}

TEST(GateLogicTest, JustPastTimeoutFires) {
  auto gate = makeGate(1.0);
  gate.onControllableMsg(true, 0.0);

  const auto r = gate.onTimerCheck(1.0 + 1e-6);
  EXPECT_TRUE(r.changed);
  EXPECT_TRUE(r.publish_zero);
  EXPECT_TRUE(r.timed_out);
  EXPECT_FALSE(gate.isControllable());
}

TEST(GateLogicTest, RepeatedTimeoutCheckIsSingleShot) {
  auto gate = makeGate(1.0);
  gate.onControllableMsg(true, 0.0);

  const auto r1 = gate.onTimerCheck(2.0);
  EXPECT_TRUE(r1.timed_out);

  const auto r2 = gate.onTimerCheck(3.0);
  EXPECT_FALSE(r2.changed);
  EXPECT_FALSE(r2.publish_zero);
  EXPECT_FALSE(r2.timed_out);
  EXPECT_FALSE(r2.recovered);
}

TEST(GateLogicTest, RecoveryWithTrueRestoresControllable) {
  auto gate = makeGate(1.0);
  gate.onControllableMsg(true, 0.0);
  gate.onTimerCheck(2.0);  // times out
  ASSERT_FALSE(gate.isControllable());

  const auto r = gate.onControllableMsg(true, 2.5);
  EXPECT_TRUE(r.recovered);
  EXPECT_TRUE(r.changed);
  EXPECT_FALSE(r.publish_zero);
  EXPECT_TRUE(gate.isControllable());
}

TEST(GateLogicTest, RecoveryWithFalseStaysUncontrollable) {
  auto gate = makeGate(1.0);
  gate.onControllableMsg(true, 0.0);
  gate.onTimerCheck(2.0);  // times out
  ASSERT_FALSE(gate.isControllable());

  const auto r = gate.onControllableMsg(false, 2.5);
  EXPECT_TRUE(r.recovered);
  EXPECT_FALSE(r.changed);
  EXPECT_FALSE(r.publish_zero);
  EXPECT_FALSE(gate.isControllable());
}

TEST(GateLogicTest, StreamLossWhileAlreadyUncontrollableIsNoOp) {
  auto gate = makeGate(1.0);
  gate.onControllableMsg(false, 0.0);
  ASSERT_FALSE(gate.isControllable());

  const auto r = gate.onTimerCheck(1000.0);
  EXPECT_FALSE(r.changed);
  EXPECT_FALSE(r.publish_zero);
  EXPECT_FALSE(r.timed_out);
  EXPECT_FALSE(r.recovered);
}

TEST(GateLogicTest, ZeroTimeoutDisablesFeature) {
  auto gate = makeGate(0.0);
  gate.onControllableMsg(true, 0.0);

  const auto r = gate.onTimerCheck(1000.0);
  EXPECT_FALSE(r.timed_out);
  EXPECT_TRUE(gate.isControllable());
}

TEST(GateLogicTest, NegativeTimeoutDisablesFeature) {
  auto gate = makeGate(-1.0);
  gate.onControllableMsg(true, 0.0);

  const auto r = gate.onTimerCheck(1000.0);
  EXPECT_FALSE(r.timed_out);
  EXPECT_TRUE(gate.isControllable());
}

int main(int argc, char** argv) {
  testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
