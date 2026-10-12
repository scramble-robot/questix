// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// The one input-selection rule of the drive and the launcher (the cases of the former
// twist_arbiter, shot_lab_logic and roller_lab_logic tests).
#include <gtest/gtest.h>

#include "command_arbiter/source_selector.hpp"

namespace {

using command_arbiter::SourceSelector;
using Source = SourceSelector::Source;
using Reason = SourceSelector::Reason;
using Refusal = SourceSelector::Refusal;

// The drive: the lab may take over as soon as the stick is neutral (no quiet time), lab 0.3 s.
SourceSelector drive() {
  SourceSelector selector;
  selector.configure({0.0, 0.5, 0.3});
  return selector;
}

// The launcher: the controller's launcher inputs must be idle 1.0 s, lab 1.0 s.
SourceSelector launcher() {
  SourceSelector selector;
  selector.configure({1.0, 0.5, 1.0});
  return selector;
}

constexpr bool kActive = true;
constexpr bool kNeutral = true;
constexpr bool kPermitted = true;

}  // namespace

TEST(SourceSelector, ControllerPassesByDefault) {
  auto selector = drive();
  EXPECT_TRUE(selector.onJoy(kActive, 0.0));
  EXPECT_TRUE(selector.onJoy(!kActive, 0.1));
  EXPECT_EQ(selector.source(), Source::kJoy);
  EXPECT_EQ(selector.reason(), Reason::kStart);
}

TEST(SourceSelector, LabTakesOverOnlyWhileTheControllerIsIdle) {
  auto selector = drive();
  selector.onJoy(kActive, 0.0);
  auto decision = selector.onLab(!kNeutral, kPermitted, 0.1);
  EXPECT_FALSE(decision.forward);  // a hand on the stick wins
  EXPECT_EQ(decision.refusal, Refusal::kController);
  EXPECT_EQ(selector.source(), Source::kJoy);
  EXPECT_FALSE(selector.labLocked());  // the stick was held before the lab asked
  // Once the stick is neutral the lab's next command takes over.
  selector.onJoy(!kActive, 0.2);
  decision = selector.onLab(!kNeutral, kPermitted, 0.25);
  EXPECT_TRUE(decision.forward);
  EXPECT_EQ(decision.refusal, Refusal::kNone);
  EXPECT_EQ(selector.source(), Source::kLab);
  EXPECT_EQ(selector.reason(), Reason::kLabStarted);
  // The controller's neutral stream is not forwarded while the lab has the actuator.
  EXPECT_FALSE(selector.onJoy(!kActive, 0.3));
}

TEST(SourceSelector, LabTakesOverWhenNoControllerRuns) {
  auto selector = drive();
  EXPECT_TRUE(selector.onLab(!kNeutral, kPermitted, 5.0).forward);
  // A controller that stopped sending a moved stick long ago is not busy either.
  auto other = drive();
  other.onJoy(kActive, 0.0);
  EXPECT_TRUE(other.onLab(!kNeutral, kPermitted, 0.6).forward);
}

TEST(SourceSelector, ANeutralLabCommandNeverTakesOver) {
  auto selector = drive();
  const auto decision = selector.onLab(kNeutral, kPermitted, 0.0);
  EXPECT_FALSE(decision.forward);
  EXPECT_EQ(decision.refusal, Refusal::kNone);
  EXPECT_EQ(selector.source(), Source::kJoy);
}

TEST(SourceSelector, TheControllerTakesOverAndLocksTheLabOutUntilItsRunEnds) {
  auto selector = drive();
  selector.onLab(!kNeutral, kPermitted, 0.0);
  EXPECT_TRUE(selector.onJoy(kActive, 0.05));
  EXPECT_EQ(selector.source(), Source::kJoy);
  EXPECT_EQ(selector.reason(), Reason::kController);
  EXPECT_TRUE(selector.labLocked());
  // The same run keeps sending but cannot grab the actuator back, even with the stick released.
  EXPECT_EQ(selector.onLab(!kNeutral, kPermitted, 0.1).refusal, Refusal::kLocked);
  selector.onJoy(!kActive, 0.2);
  EXPECT_EQ(selector.onLab(!kNeutral, kPermitted, 0.25).refusal, Refusal::kLocked);
  selector.onTick(kPermitted, 0.4);
  EXPECT_TRUE(selector.labLocked());  // still sending until 0.25 + 0.3
  selector.onTick(kPermitted, 0.6);
  EXPECT_FALSE(selector.labLocked());
  // A new run may take over again.
  EXPECT_TRUE(selector.onLab(!kNeutral, kPermitted, 0.7).forward);
}

TEST(SourceSelector, ANeutralLabCommandEndsTheRunAndIsForwardedAsTheStop) {
  auto selector = drive();
  selector.onLab(!kNeutral, kPermitted, 0.0);
  const auto decision = selector.onLab(kNeutral, kPermitted, 0.1);
  EXPECT_TRUE(decision.forward);
  EXPECT_FALSE(decision.stop);
  EXPECT_EQ(selector.source(), Source::kJoy);
  EXPECT_EQ(selector.reason(), Reason::kLabEnded);
  EXPECT_TRUE(selector.onJoy(!kActive, 0.2));  // the controller's stream passes again
}

TEST(SourceSelector, ASilentLabHandsBackToTheControllerWithAStop) {
  auto selector = drive();
  selector.onLab(!kNeutral, kPermitted, 0.0);
  EXPECT_FALSE(selector.onTick(kPermitted, 0.2));
  EXPECT_EQ(selector.source(), Source::kLab);
  EXPECT_TRUE(selector.onTick(kPermitted, 0.4));  // publish a stop
  EXPECT_EQ(selector.source(), Source::kJoy);
  EXPECT_EQ(selector.reason(), Reason::kLabIdle);
  EXPECT_FALSE(selector.onTick(kPermitted, 0.5));  // only once
  EXPECT_TRUE(selector.onJoy(kActive, 0.5));
}

TEST(SourceSelector, TheLabNeedsTheTeachersPermissionAndLosesTheActuatorWithIt) {
  auto selector = drive();
  auto decision = selector.onLab(!kNeutral, !kPermitted, 0.0);
  EXPECT_FALSE(decision.forward);
  EXPECT_EQ(decision.refusal, Refusal::kNotPermitted);
  EXPECT_EQ(selector.refusal(), Refusal::kNotPermitted);
  decision = selector.onLab(!kNeutral, kPermitted, 0.1);
  EXPECT_TRUE(decision.forward);
  EXPECT_EQ(selector.refusal(), Refusal::kNone);
  // The permission goes during the run: a stop, by the next message or by the tick.
  decision = selector.onLab(!kNeutral, !kPermitted, 0.2);
  EXPECT_FALSE(decision.forward);
  EXPECT_TRUE(decision.stop);
  EXPECT_EQ(selector.reason(), Reason::kNotPermitted);
  auto other = drive();
  other.onLab(!kNeutral, kPermitted, 0.0);
  EXPECT_TRUE(other.onTick(!kPermitted, 0.1));
  EXPECT_EQ(other.source(), Source::kJoy);
  EXPECT_EQ(other.reason(), Reason::kNotPermitted);
}

// The launcher: the controller's launcher inputs (roller button, tilt, fire) must have been idle
// for controller_quiet_sec before the lab may take over.
TEST(SourceSelector, TheLauncherWaitsForTheControllerQuietTime) {
  auto selector = launcher();
  selector.onJoy(kActive, 10.0);   // the roller button pressed
  selector.onJoy(!kActive, 10.2);  // released
  EXPECT_EQ(selector.onLab(!kNeutral, kPermitted, 10.5).refusal, Refusal::kController);
  // That refusal does not lock: the lab was not running when the controller was used.
  EXPECT_FALSE(selector.labLocked());
  EXPECT_EQ(selector.onLab(!kNeutral, kPermitted, 11.0).refusal, Refusal::kController);
  EXPECT_TRUE(selector.onLab(!kNeutral, kPermitted, 11.01).forward);
}

// A press while the lab asks locks it until it sends 0 or goes quiet, so a heartbeat that keeps
// coming cannot take the roller right after the controller lets go.
TEST(SourceSelector, APressWhileTheLabAsksLocksItUntilZero) {
  auto selector = launcher();
  selector.onLab(!kNeutral, kPermitted, 10.0);
  EXPECT_EQ(selector.source(), Source::kLab);
  selector.onJoy(kActive, 10.1);
  EXPECT_EQ(selector.source(), Source::kJoy);
  selector.onJoy(!kActive, 10.2);
  EXPECT_EQ(selector.onLab(!kNeutral, kPermitted, 12.0).refusal, Refusal::kLocked);
  selector.onLab(kNeutral, kPermitted, 12.1);  // the lab's 0 ends its run
  EXPECT_FALSE(selector.labLocked());
  EXPECT_TRUE(selector.onLab(!kNeutral, kPermitted, 12.2).forward);
  // The same with the lab refused (not running) but asking when the controller is used.
  auto other = launcher();
  other.onJoy(kActive, 20.0);
  other.onLab(!kNeutral, kPermitted, 20.1);  // refused: the controller is busy
  other.onJoy(kActive, 20.2);                // used again while the lab asks
  EXPECT_TRUE(other.labLocked());
}

TEST(SourceSelector, AnInvalidLabCommandIsRecordedAsSuch) {
  auto selector = drive();
  selector.refuse(Refusal::kInvalid);
  EXPECT_EQ(selector.refusal(), Refusal::kInvalid);
  EXPECT_STREQ(SourceSelector::refusalName(selector.refusal()), "invalid");
}

TEST(SourceSelector, VersionChangesOnlyOnNews) {
  auto selector = drive();
  const auto version = selector.version();
  selector.onJoy(!kActive, 0.0);
  selector.onTick(kPermitted, 0.1);
  EXPECT_EQ(selector.version(), version);
  selector.onLab(!kNeutral, kPermitted, 0.2);
  EXPECT_EQ(selector.version(), version + 1);
  selector.onLab(!kNeutral, kPermitted, 0.25);
  EXPECT_EQ(selector.version(), version + 1);  // the same state again
  EXPECT_EQ(selector.labCount(), 2u);
}

TEST(SourceSelector, NamesForTheStatus) {
  EXPECT_STREQ(SourceSelector::sourceName(Source::kLab), "lab");
  EXPECT_STREQ(SourceSelector::reasonName(Reason::kController), "controller");
  EXPECT_STREQ(SourceSelector::reasonName(Reason::kLabIdle), "lab_idle");
  EXPECT_STREQ(SourceSelector::reasonName(Reason::kLabEnded), "lab_ended");
  EXPECT_STREQ(SourceSelector::reasonName(Reason::kNotPermitted), "not_permitted");
  EXPECT_STREQ(SourceSelector::refusalName(Refusal::kNone), "");
  EXPECT_STREQ(SourceSelector::refusalName(Refusal::kLocked), "locked");
}
