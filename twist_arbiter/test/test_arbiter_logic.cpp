// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <limits>

#include "twist_arbiter/arbiter_logic.hpp"

namespace {

using twist_arbiter::ArbiterLogic;
using Source = ArbiterLogic::Source;
using Reason = ArbiterLogic::Reason;

ArbiterLogic makeArbiter() {
  ArbiterLogic logic;
  logic.configure(ArbiterLogic::Config{});  // 0.02 m/s, 0.05 rad/s, lab 0.3 s, joy 0.5 s
  return logic;
}

}  // namespace

TEST(ArbiterLogicTest, ControllerPassesByDefault) {
  auto logic = makeArbiter();
  const auto command = logic.onJoy(0.3, 0.0, 0.0);
  ASSERT_TRUE(command.has_value());
  EXPECT_DOUBLE_EQ(command->linear, 0.3);
  EXPECT_EQ(logic.source(), Source::kJoy);
}

TEST(ArbiterLogicTest, LabTakesOverOnlyWhileTheStickIsNeutral) {
  auto logic = makeArbiter();
  logic.onJoy(0.3, 0.0, 0.0);
  EXPECT_FALSE(logic.onLab(0.1, 0.0, 0.1).has_value());  // a hand on the stick wins
  EXPECT_EQ(logic.source(), Source::kJoy);
  logic.onJoy(0.0, 0.0, 0.2);
  const auto command = logic.onLab(0.1, 0.0, 0.25);
  ASSERT_TRUE(command.has_value());
  EXPECT_DOUBLE_EQ(command->linear, 0.1);
  EXPECT_EQ(logic.source(), Source::kLab);
  EXPECT_EQ(logic.reason(), Reason::kLabStarted);
  // The controller's neutral stream is not forwarded while the lab drives.
  EXPECT_FALSE(logic.onJoy(0.0, 0.0, 0.3).has_value());
}

TEST(ArbiterLogicTest, LabDrivesWhenNoControllerRuns) {
  auto logic = makeArbiter();
  EXPECT_TRUE(logic.onLab(0.1, 0.2, 5.0).has_value());
}

TEST(ArbiterLogicTest, StickTakesOverAndLocksTheLabOutUntilItGoesQuiet) {
  auto logic = makeArbiter();
  logic.onLab(0.2, 0.0, 0.0);
  const auto command = logic.onJoy(0.0, 0.5, 0.05);
  ASSERT_TRUE(command.has_value());
  EXPECT_DOUBLE_EQ(command->angular, 0.5);
  EXPECT_EQ(logic.source(), Source::kJoy);
  EXPECT_EQ(logic.reason(), Reason::kController);
  EXPECT_TRUE(logic.labLocked());
  // The same run keeps sending but cannot grab the robot back, even with the stick released.
  EXPECT_FALSE(logic.onLab(0.2, 0.0, 0.1).has_value());
  logic.onJoy(0.0, 0.0, 0.2);
  EXPECT_FALSE(logic.onLab(0.2, 0.0, 0.25).has_value());
  logic.onTick(0.4);
  EXPECT_TRUE(logic.labLocked());  // still sending until 0.25 + 0.3
  logic.onTick(0.6);
  EXPECT_FALSE(logic.labLocked());
  // A new run may take over again.
  EXPECT_TRUE(logic.onLab(0.1, 0.0, 0.7).has_value());
}

TEST(ArbiterLogicTest, QuietLabHandsBackToTheController) {
  auto logic = makeArbiter();
  logic.onLab(0.1, 0.0, 0.0);
  logic.onTick(0.2);
  EXPECT_EQ(logic.source(), Source::kLab);
  logic.onTick(0.4);
  EXPECT_EQ(logic.source(), Source::kJoy);
  EXPECT_EQ(logic.reason(), Reason::kLabIdle);
  EXPECT_TRUE(logic.onJoy(0.1, 0.0, 0.5).has_value());
}

TEST(ArbiterLogicTest, SmallStickNoiseDoesNotTakeOver) {
  auto logic = makeArbiter();
  logic.onLab(0.1, 0.0, 0.0);
  EXPECT_FALSE(logic.onJoy(0.01, 0.03, 0.05).has_value());
  EXPECT_EQ(logic.source(), Source::kLab);
}

TEST(ArbiterLogicTest, NonFiniteValuesBecomeAStop) {
  auto logic = makeArbiter();
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const auto command = logic.onLab(nan, nan, 0.0);
  ASSERT_TRUE(command.has_value());
  EXPECT_DOUBLE_EQ(command->linear, 0.0);
  EXPECT_DOUBLE_EQ(command->angular, 0.0);
  // An infinite stick value is cleaned to 0, i.e. neutral: the lab keeps the robot.
  EXPECT_FALSE(logic.onJoy(std::numeric_limits<double>::infinity(), 0.0, 1.0).has_value());
}

TEST(ArbiterLogicTest, VersionChangesOnlyOnNews) {
  auto logic = makeArbiter();
  const auto version = logic.version();
  logic.onJoy(0.0, 0.0, 0.0);
  logic.onTick(0.1);
  EXPECT_EQ(logic.version(), version);
  logic.onLab(0.1, 0.0, 0.2);
  EXPECT_EQ(logic.version(), version + 1);
}

TEST(ArbiterLogicTest, NamesForTheStatus) {
  EXPECT_STREQ(ArbiterLogic::sourceName(Source::kLab), "lab");
  EXPECT_STREQ(ArbiterLogic::reasonName(Reason::kController), "controller");
  EXPECT_STREQ(ArbiterLogic::reasonName(Reason::kLabIdle), "lab_idle");
}
