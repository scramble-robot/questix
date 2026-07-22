// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include "motor_control_app/motor_status_msg.hpp"

namespace {

using motor_control_app::toMotorFeedbackMsg;
using MotorFeedbackData = motor_control_lib::DdtMotorLib::MotorFeedbackData;

TEST(ToMotorFeedbackMsg, FieldsPassThrough) {
  MotorFeedbackData fb;
  fb.motor_id = 4;
  fb.mode = 2;
  fb.current_raw = 16384;  // 半分 -> 約 4A
  fb.velocity_rpm = -120;
  fb.target_rpm = -150;
  fb.position_raw = 12345;
  fb.temperature = 0;
  fb.fault_code = 3;
  fb.has_feedback = true;
  fb.feedback_age_sec = 0.0;

  auto msg = toMotorFeedbackMsg(fb, rclcpp::Time(10, 0, RCL_ROS_TIME));
  EXPECT_EQ(msg.motor_id, 4);
  EXPECT_EQ(msg.mode, 2);
  EXPECT_EQ(msg.current_raw, 16384);
  EXPECT_EQ(msg.velocity_rpm, -120);
  EXPECT_EQ(msg.target_rpm, -150);
  EXPECT_EQ(msg.position_raw, 12345);
  EXPECT_EQ(msg.temperature, 0);
  EXPECT_EQ(msg.fault_code, 3);
  // current_amp = 16384 * 8 / 32767 ~= 4.0
  EXPECT_NEAR(msg.current_amp, 4.0f, 0.01f);
}

TEST(ToMotorFeedbackMsg, StampSubtractsAgeWhenFresh) {
  MotorFeedbackData fb;
  fb.has_feedback = true;
  fb.feedback_age_sec = 0.25;

  rclcpp::Time now(10, 0, RCL_ROS_TIME);
  auto msg = toMotorFeedbackMsg(fb, now);
  // stamp = now - 0.25s = 9.75s
  EXPECT_NEAR(rclcpp::Time(msg.header.stamp, RCL_ROS_TIME).seconds(), 9.75, 1e-6);
}

TEST(ToMotorFeedbackMsg, ZeroStampWhenNoFeedback) {
  MotorFeedbackData fb;  // has_feedback defaults to false
  fb.motor_id = 5;
  fb.target_rpm = 42;

  auto msg = toMotorFeedbackMsg(fb, rclcpp::Time(10, 0, RCL_ROS_TIME));
  // 未受信 -> stamp は 0（msg 契約）だが motor_id / target_rpm は保持される。
  EXPECT_EQ(rclcpp::Time(msg.header.stamp, RCL_ROS_TIME).nanoseconds(), 0);
  EXPECT_EQ(msg.motor_id, 5);
  EXPECT_EQ(msg.target_rpm, 42);
  EXPECT_EQ(msg.velocity_rpm, 0);
}

}  // namespace
