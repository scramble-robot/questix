// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <lifecycle_msgs/msg/state.hpp>
#include <limits>

#include "motor_control_app/shot_auto_start.hpp"

namespace {

using lifecycle_msgs::msg::State;
using motor_control_app::shot_auto_start::AutoStartAction;
using motor_control_app::shot_auto_start::decideAutoStartAction;
using motor_control_app::shot_auto_start::decideSafetyTeardownAction;
using motor_control_app::shot_auto_start::isControllableSignalStale;
using motor_control_app::shot_auto_start::normalizeControllableTimeout;
using motor_control_app::shot_auto_start::normalizePositivePeriod;
using motor_control_app::shot_auto_start::SafetyTeardownAction;
using motor_control_app::shot_auto_start::shouldHoldManualLifecycle;

// /gpio/controllable 未受信（enable_gpio_ref=false 等）は周期リトライにフォールバック
TEST(ShotAutoStart, UnconfiguredWithoutControllableFallsBackToConfigure) {
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_UNCONFIGURED, false, false),
            AutoStartAction::kConfigure);
}

TEST(ShotAutoStart, UnconfiguredWhileEstopPressedWaits) {
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_UNCONFIGURED, true, false),
            AutoStartAction::kWaitEstopRelease);
}

TEST(ShotAutoStart, UnconfiguredAfterEstopReleaseConfigures) {
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_UNCONFIGURED, true, true),
            AutoStartAction::kConfigure);
}

TEST(ShotAutoStart, InactiveWithoutControllableActivates) {
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_INACTIVE, false, false),
            AutoStartAction::kActivate);
}

TEST(ShotAutoStart, InactiveWhileEstopPressedWaits) {
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_INACTIVE, true, false),
            AutoStartAction::kWaitEstopRelease);
}

TEST(ShotAutoStart, InactiveAfterEstopReleaseActivates) {
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_INACTIVE, true, true),
            AutoStartAction::kActivate);
}

// ACTIVE 到達後は非常停止状態に関わらずタイマー停止（押下時の解体はエッジ側が行う）
TEST(ShotAutoStart, ActiveStopsTimerRegardlessOfEstop) {
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_ACTIVE, false, false),
            AutoStartAction::kStopTimer);
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_ACTIVE, true, false),
            AutoStartAction::kStopTimer);
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_ACTIVE, true, true),
            AutoStartAction::kStopTimer);
}

TEST(ShotAutoStart, FinalizedStopsTimerAndTransitionStatesDoNothing) {
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_FINALIZED, true, true),
            AutoStartAction::kStopTimer);
  EXPECT_EQ(decideAutoStartAction(State::TRANSITION_STATE_CONFIGURING, true, true),
            AutoStartAction::kNone);
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_UNKNOWN, true, true),
            AutoStartAction::kNone);
}

TEST(ShotAutoStart, ConfigureFailureRetriesFromUnconfigured) {
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_UNCONFIGURED, false, false),
            AutoStartAction::kConfigure);
}

TEST(ShotControllableTimeout, DisabledNeverFailsSafe) {
  EXPECT_FALSE(isControllableSignalStale(0.0, true, 10.0));
  EXPECT_FALSE(isControllableSignalStale(-1.0, true, 10.0));
  EXPECT_FALSE(isControllableSignalStale(std::numeric_limits<double>::infinity(), true, 10.0));
}

TEST(ShotControllableTimeout, StaleTrueSignalFailsSafe) {
  EXPECT_TRUE(isControllableSignalStale(1.0, true, 1.01));
}

// false（非常停止押下）は teardown 済みのため受信途絶でも fail-safe 対象にしない
TEST(ShotControllableTimeout, FalseSignalNeverFailsSafe) {
  EXPECT_FALSE(isControllableSignalStale(1.0, false, 2.0));
}

TEST(ShotControllableTimeout, FreshOrRecoveredSignalIsNotStale) {
  EXPECT_FALSE(isControllableSignalStale(1.0, true, 0.1));
}

TEST(ShotSafetyTeardown, StableStatesSelectSafeRetryAction) {
  EXPECT_EQ(decideSafetyTeardownAction(State::PRIMARY_STATE_ACTIVE),
            SafetyTeardownAction::kRetryDeactivate);
  EXPECT_EQ(decideSafetyTeardownAction(State::PRIMARY_STATE_INACTIVE),
            SafetyTeardownAction::kRetryCleanup);
  EXPECT_EQ(decideSafetyTeardownAction(State::PRIMARY_STATE_UNCONFIGURED),
            SafetyTeardownAction::kResetRetry);
  EXPECT_EQ(decideSafetyTeardownAction(State::PRIMARY_STATE_FINALIZED),
            SafetyTeardownAction::kStopTimers);
}

TEST(ShotSafetyTeardown, CanceledTimerHoldsManualPreActiveStates) {
  EXPECT_TRUE(shouldHoldManualLifecycle(State::PRIMARY_STATE_INACTIVE, true));
  EXPECT_TRUE(shouldHoldManualLifecycle(State::PRIMARY_STATE_UNCONFIGURED, true));
  EXPECT_FALSE(shouldHoldManualLifecycle(State::PRIMARY_STATE_ACTIVE, true));
  EXPECT_FALSE(shouldHoldManualLifecycle(State::PRIMARY_STATE_UNCONFIGURED, false));
}

TEST(ShotParameters, InvalidRetryPeriodFallsBackToDefault) {
  EXPECT_DOUBLE_EQ(normalizePositivePeriod(2.5, 3.0), 2.5);
  EXPECT_DOUBLE_EQ(normalizePositivePeriod(0.0, 3.0), 3.0);
  EXPECT_DOUBLE_EQ(normalizePositivePeriod(-1.0, 3.0), 3.0);
  EXPECT_DOUBLE_EQ(normalizePositivePeriod(std::numeric_limits<double>::quiet_NaN(), 3.0), 3.0);
  EXPECT_DOUBLE_EQ(normalizePositivePeriod(std::numeric_limits<double>::infinity(), 3.0), 3.0);
}

TEST(ShotParameters, NonFiniteControllableTimeoutFallsBackToDefault) {
  EXPECT_DOUBLE_EQ(normalizeControllableTimeout(0.0, 1.0), 0.0);
  EXPECT_DOUBLE_EQ(normalizeControllableTimeout(-1.0, 1.0), -1.0);
  EXPECT_DOUBLE_EQ(normalizeControllableTimeout(std::numeric_limits<double>::quiet_NaN(), 1.0),
                   1.0);
  EXPECT_DOUBLE_EQ(normalizeControllableTimeout(std::numeric_limits<double>::infinity(), 1.0), 1.0);
}

}  // namespace
