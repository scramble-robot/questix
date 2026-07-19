// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <lifecycle_msgs/msg/state.hpp>
#include <limits>

#include "motor_control_app/lifecycle_auto_start.hpp"

namespace {

using lifecycle_msgs::msg::State;
using motor_control_app::lifecycle_auto_start::AutoStartAction;
using motor_control_app::lifecycle_auto_start::decideAutoStartAction;
using motor_control_app::lifecycle_auto_start::isValidStatusPublishRate;
using motor_control_app::lifecycle_auto_start::normalizeRetryPeriod;
using motor_control_app::lifecycle_auto_start::statusTimerPeriodNanoseconds;

TEST(LifecycleAutoStart, UnconfiguredTriggersConfigure) {
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_UNCONFIGURED), AutoStartAction::kConfigure);
}

TEST(LifecycleAutoStart, InactiveTriggersActivate) {
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_INACTIVE), AutoStartAction::kActivate);
}

TEST(LifecycleAutoStart, ActiveStopsTimer) {
  // 正常稼働に到達したらタイマーを止め、以降の手動 deactivate/cleanup を
  // 自動再遷移で覆さない（shot_component bc037d1 の教訓）。
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_ACTIVE), AutoStartAction::kStopTimer);
}

TEST(LifecycleAutoStart, FinalizedStopsTimer) {
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_FINALIZED), AutoStartAction::kStopTimer);
}

TEST(LifecycleAutoStart, TransitionStatesDoNothing) {
  // configure/activate は同期呼び出しだが、遷移中状態を観測しても安全側に倒す。
  EXPECT_EQ(decideAutoStartAction(State::TRANSITION_STATE_CONFIGURING), AutoStartAction::kNone);
  EXPECT_EQ(decideAutoStartAction(State::TRANSITION_STATE_ACTIVATING), AutoStartAction::kNone);
  EXPECT_EQ(decideAutoStartAction(State::TRANSITION_STATE_DEACTIVATING), AutoStartAction::kNone);
  EXPECT_EQ(decideAutoStartAction(State::TRANSITION_STATE_CLEANINGUP), AutoStartAction::kNone);
  EXPECT_EQ(decideAutoStartAction(State::TRANSITION_STATE_SHUTTINGDOWN), AutoStartAction::kNone);
  EXPECT_EQ(decideAutoStartAction(State::TRANSITION_STATE_ERRORPROCESSING), AutoStartAction::kNone);
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_UNKNOWN), AutoStartAction::kNone);
}

TEST(LifecycleAutoStart, PoweredStartupReachesActiveInOneTick) {
  // 通電済み起動: configure 成功で inactive を再評価すると同一ティックで
  // activate まで進む（起動タイミング維持の受け入れ条件）。
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_UNCONFIGURED), AutoStartAction::kConfigure);
  // configure() 成功後の状態 = INACTIVE
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_INACTIVE), AutoStartAction::kActivate);
}

TEST(LifecycleAutoStart, UnpoweredStartupRetriesConfigure) {
  // 未通電起動: configure 失敗で unconfigured に戻り、次ティックも kConfigure。
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_UNCONFIGURED), AutoStartAction::kConfigure);
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_UNCONFIGURED), AutoStartAction::kConfigure);
}

TEST(LifecycleAutoStart, UnexpectedStateDoesNothing) {
  EXPECT_EQ(decideAutoStartAction(State::PRIMARY_STATE_UNKNOWN), AutoStartAction::kNone);
}

TEST(LifecycleParameters, InvalidRetryPeriodFallsBackToDefault) {
  EXPECT_DOUBLE_EQ(normalizeRetryPeriod(2.5, 1.0), 2.5);
  EXPECT_DOUBLE_EQ(normalizeRetryPeriod(0.0, 1.0), 1.0);
  EXPECT_DOUBLE_EQ(normalizeRetryPeriod(-1.0, 1.0), 1.0);
  EXPECT_DOUBLE_EQ(normalizeRetryPeriod(std::numeric_limits<double>::quiet_NaN(), 1.0), 1.0);
  EXPECT_DOUBLE_EQ(normalizeRetryPeriod(std::numeric_limits<double>::infinity(), 1.0), 1.0);
}

TEST(LifecycleParameters, StatusPublishRateMustBeFiniteAndPositive) {
  EXPECT_TRUE(isValidStatusPublishRate(10.0));
  EXPECT_FALSE(isValidStatusPublishRate(0.0));
  EXPECT_FALSE(isValidStatusPublishRate(-1.0));
  EXPECT_FALSE(isValidStatusPublishRate(std::numeric_limits<double>::quiet_NaN()));
  EXPECT_FALSE(isValidStatusPublishRate(std::numeric_limits<double>::infinity()));
}

TEST(LifecycleParameters, StatusTimerPeriodMustRemainPositiveAfterConversion) {
  EXPECT_EQ(statusTimerPeriodNanoseconds(10.0), 100000000);
  EXPECT_EQ(statusTimerPeriodNanoseconds(1000.0), 1000000);
  EXPECT_EQ(statusTimerPeriodNanoseconds(1000000000.0), 1);
  EXPECT_EQ(statusTimerPeriodNanoseconds(2000000000.0), 0);
  EXPECT_FALSE(isValidStatusPublishRate(2000000000.0));
}

}  // namespace

int main(int argc, char** argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
