// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <string>

#include "motor_control_app/ddt_feedback_format.hpp"

namespace {

using motor_control_app::formatRow;
using motor_control_app::modeToStr;
using motor_control_app::positionRawToDeg;
using MotorFeedback = questix_msgs::msg::MotorFeedback;

MotorFeedback makeFeedback(uint8_t motor_id, uint8_t mode, int16_t current_raw, float current_amp,
                           int16_t velocity_rpm, int16_t target_rpm, uint16_t position_raw,
                           uint8_t fault_code, int32_t stamp_sec) {
  MotorFeedback fb;
  fb.motor_id = motor_id;
  fb.mode = mode;
  fb.current_raw = current_raw;
  fb.current_amp = current_amp;
  fb.velocity_rpm = velocity_rpm;
  fb.target_rpm = target_rpm;
  fb.position_raw = position_raw;
  fb.fault_code = fault_code;
  fb.header.stamp.sec = stamp_sec;
  fb.header.stamp.nanosec = 0;
  return fb;
}

TEST(ModeToStr, KnownAndUnknown) {
  EXPECT_EQ(modeToStr(MotorFeedback::MODE_CURRENT_LOOP), "CURRENT");
  EXPECT_EQ(modeToStr(MotorFeedback::MODE_VELOCITY_LOOP), "VELOCITY");
  EXPECT_EQ(modeToStr(0), "?(0)");
  EXPECT_EQ(modeToStr(7), "?(7)");
}

TEST(PositionRawToDeg, FullScale) {
  EXPECT_NEAR(positionRawToDeg(0), 0.0, 1e-9);
  EXPECT_NEAR(positionRawToDeg(32767), 360.0, 1e-6);
  EXPECT_NEAR(positionRawToDeg(8192), 90.0, 0.1);
}

TEST(FormatRow, FreshRowNoColor) {
  // current_amp = 4096 * 8 / 32767 ~= 1.0 A
  auto fb = makeFeedback(4, MotorFeedback::MODE_VELOCITY_LOOP, 4096, 1.0f, 120, 150, 8192, 0, 100);
  std::string row = formatRow(fb, 100.1, 0.5, false);
  EXPECT_NE(row.find("VELOCITY"), std::string::npos);
  EXPECT_NE(row.find("1.000"), std::string::npos);
  EXPECT_NE(row.find("120"), std::string::npos);
  EXPECT_NE(row.find("0x2000"), std::string::npos);  // position raw
  EXPECT_NE(row.find("0x00"), std::string::npos);    // fault
  EXPECT_NE(row.find("0.10"), std::string::npos);    // age
  // No ANSI escape when color is disabled.
  EXPECT_EQ(row.find("\033["), std::string::npos);
}

TEST(FormatRow, StaleMarkedAndDimWhenColor) {
  auto fb = makeFeedback(5, MotorFeedback::MODE_CURRENT_LOOP, 0, 0.0f, 0, 0, 0, 0, 100);
  std::string row = formatRow(fb, 101.0, 0.5, true);
  EXPECT_NE(row.find("!"), std::string::npos);               // stale marker on age
  EXPECT_EQ(row.rfind(motor_control_app::kAnsiDim, 0), 0u);  // dim prefix
}

TEST(FormatRow, NoFeedbackShowsDashes) {
  auto fb = makeFeedback(6, 0, 0, 0.0f, 0, 0, 0, 0, 0);  // stamp == 0 -> not received
  std::string row = formatRow(fb, 200.0, 0.5, false);
  EXPECT_NE(row.find("--"), std::string::npos);
}

TEST(FormatRow, FaultHighlightedRedWhenColor) {
  auto fb =
      makeFeedback(5, MotorFeedback::MODE_CURRENT_LOOP, -2048, -0.5f, -80, -100, 16384, 1, 100);
  std::string row = formatRow(fb, 100.05, 0.5, true);
  EXPECT_EQ(row.rfind(motor_control_app::kAnsiBoldRed, 0), 0u);  // red prefix
  EXPECT_NE(row.find("0x01"), std::string::npos);                // fault code
}

}  // namespace
