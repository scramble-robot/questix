// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <cmath>

#include "motor_control_app/drive_control_sample_msg.hpp"

namespace {

namespace sample = motor_control_app::drive_control_sample;
using questix_msgs::msg::DriveControlSample;
using DriveMode = motor_control_lib::drive_mode_fsm::DriveMode;

const rclcpp::Time kNow(10, 0, RCL_ROS_TIME);

// A wheel whose tick had one answered exchange: the count went 7 -> 8 in 3.5 ms.
sample::WheelInput answeredWheel() {
  sample::WheelInput in;
  in.stats_before.feedback_count = 7;
  in.stats_before.transactions = 7;
  in.stats_after.feedback_count = 8;
  in.stats_after.transactions = 8;
  in.stats_after.last_roundtrip_ms = 3.5;
  in.stats_after.last_response_timeout = false;
  in.feedback.has_feedback = true;
  in.feedback.feedback_age_sec = 0.002;
  return in;
}

TEST(DriveControlSampleMsg, NoFeedbackYet) {
  sample::WheelInput in;  // nothing received, nothing exchanged
  in.ref_rpm = 12;
  in.command_rpm = 12;
  const auto msg = sample::toWheelSampleMsg(in, false, kNow);
  EXPECT_FALSE(msg.feedback_new);
  EXPECT_EQ(msg.feedback_count, 0u);
  EXPECT_EQ(rclcpp::Time(msg.feedback_stamp, RCL_ROS_TIME).nanoseconds(), 0);
  EXPECT_TRUE(std::isnan(msg.roundtrip_ms));
  EXPECT_FALSE(msg.response_timeout);
  EXPECT_EQ(msg.ref_rpm, 12);
  EXPECT_EQ(msg.command_rpm, 12);
  EXPECT_EQ(msg.velocity_rpm_raw, 0);
}

TEST(DriveControlSampleMsg, AnsweredExchangeIsNewWithItsRoundtripAndReceiptTime) {
  const auto msg = sample::toWheelSampleMsg(answeredWheel(), false, kNow);
  EXPECT_TRUE(msg.feedback_new);
  EXPECT_EQ(msg.feedback_count, 8u);
  EXPECT_FLOAT_EQ(msg.roundtrip_ms, 3.5f);
  EXPECT_FALSE(msg.response_timeout);
  EXPECT_NEAR(rclcpp::Time(msg.feedback_stamp, RCL_ROS_TIME).seconds(), 9.998, 1e-9);
}

TEST(DriveControlSampleMsg, TimeoutIsNaNAndNotNew) {
  auto in = answeredWheel();
  in.stats_after.feedback_count = 7;  // nothing new
  in.stats_after.last_response_timeout = true;
  in.stats_after.last_roundtrip_ms = std::nan("");
  const auto msg = sample::toWheelSampleMsg(in, false, kNow);
  EXPECT_FALSE(msg.feedback_new);
  EXPECT_TRUE(msg.response_timeout);
  EXPECT_TRUE(std::isnan(msg.roundtrip_ms));
}

TEST(DriveControlSampleMsg, ATickWithoutExchangeDoesNotRepeatTheLastRoundtrip) {
  auto in = answeredWheel();
  in.stats_before = in.stats_after;  // an idle tick: no exchange with this motor
  in.stats_after.last_response_timeout = true;  // left over from an earlier tick
  const auto msg = sample::toWheelSampleMsg(in, false, kNow);
  EXPECT_FALSE(msg.feedback_new);
  EXPECT_TRUE(std::isnan(msg.roundtrip_ms));
  EXPECT_FALSE(msg.response_timeout);
  EXPECT_EQ(msg.feedback_count, 8u);  // the same frame as the previous sample
}

TEST(DriveControlSampleMsg, CurrentRawOnlyInCurrentMode) {
  auto in = answeredWheel();
  in.stats_after.last_current_raw_sent = -2048;
  EXPECT_EQ(sample::toWheelSampleMsg(in, true, kNow).command_current_raw, -2048);
  EXPECT_EQ(sample::toWheelSampleMsg(in, false, kNow).command_current_raw, 0);
}

TEST(DriveControlSampleMsg, WireFieldsKeepTheirNativeSign) {
  // Right wheel driving forward: negative on the wire, and it stays negative.
  auto in = answeredWheel();
  in.ref_rpm = -40;
  in.command_rpm = -42;
  in.feedback.mode = 2;
  in.feedback.velocity_rpm_raw = -39;
  in.feedback.velocity_rpm = -30;  // the filtered value is not in the sample
  in.feedback.position_raw = 32760;
  in.feedback.current_raw = -1500;
  in.feedback.fault_code = 4;
  const auto msg = sample::toWheelSampleMsg(in, false, kNow);
  EXPECT_EQ(msg.ref_rpm, -40);
  EXPECT_EQ(msg.command_rpm, -42);
  EXPECT_EQ(msg.mode, 2);
  EXPECT_EQ(msg.velocity_rpm_raw, -39);
  EXPECT_EQ(msg.position_raw, 32760);
  EXPECT_EQ(msg.current_raw, -1500);
  EXPECT_EQ(msg.fault_code, 4);
}

TEST(DriveControlSampleMsg, FeedbackCountWrapsAtThirtyTwoBits) {
  auto in = answeredWheel();
  in.stats_after.feedback_count = (1ull << 32) + 5;
  EXPECT_EQ(sample::toWheelSampleMsg(in, false, kNow).feedback_count, 5u);
}

TEST(DriveControlSampleMsg, TickFields) {
  sample::TickInput in;
  in.seq = 41;
  in.tick_start = rclcpp::Time(9, 500000000, RCL_ROS_TIME);
  in.now = kNow;
  in.control_period_sec = 0.02;
  in.tick_duration_sec = 0.007;
  in.current_mode = true;
  in.drive_mode = DriveMode::kCreep;
  in.tick_action = DriveControlSample::TICK_DRIVE;
  in.lqr_active = false;
  in.shaped_linear = 0.25;
  in.shaped_angular = -0.5;
  in.command_sent = true;
  in.stop_frame = false;
  in.left = answeredWheel();
  const auto msg = sample::toDriveControlSampleMsg(in);
  EXPECT_NEAR(rclcpp::Time(msg.header.stamp, RCL_ROS_TIME).seconds(), 9.5, 1e-9);
  EXPECT_EQ(msg.seq, 41u);
  EXPECT_DOUBLE_EQ(msg.control_period_sec, 0.02);
  EXPECT_DOUBLE_EQ(msg.tick_duration_sec, 0.007);
  EXPECT_EQ(msg.control_mode, "current");
  EXPECT_EQ(msg.drive_mode, DriveControlSample::DRIVE_MODE_CREEP);
  EXPECT_EQ(msg.tick_action, DriveControlSample::TICK_DRIVE);
  EXPECT_DOUBLE_EQ(msg.shaped_linear, 0.25);
  EXPECT_DOUBLE_EQ(msg.shaped_angular, -0.5);
  EXPECT_TRUE(msg.command_sent);
  EXPECT_FALSE(msg.stop_frame);
  EXPECT_TRUE(msg.left.feedback_new);
  EXPECT_FALSE(msg.right.feedback_new);
  EXPECT_EQ(sample::toDriveModeField(DriveMode::kStop), DriveControlSample::DRIVE_MODE_STOP);
  EXPECT_EQ(sample::toDriveModeField(DriveMode::kRun), DriveControlSample::DRIVE_MODE_RUN);
  in.current_mode = false;
  EXPECT_EQ(sample::toDriveControlSampleMsg(in).control_mode, "velocity");
}

}  // namespace
