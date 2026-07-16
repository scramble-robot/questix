// Copyright (c) 2026 Questix Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include <gtest/gtest.h>

#include <cstdint>
#include <sensor_msgs/msg/joy.hpp>
#include <string>
#include <uart_joy_driver/joy_line_parser.hpp>
#include <vector>

namespace {

constexpr double kDeadzone = 0.05;

sensor_msgs::msg::Joy makeJoy() {
  sensor_msgs::msg::Joy joy_msg;
  joy_msg.axes.assign(uart_joy_driver::kJoyAxisCount, 0.0F);
  joy_msg.buttons.assign(uart_joy_driver::kJoyButtonCount, 0);
  return joy_msg;
}

TEST(ParseHexByteTest, AcceptsValidTokens) {
  uint8_t value = 0xAA;
  EXPECT_TRUE(uart_joy_driver::parseHexByte("00", value));
  EXPECT_EQ(value, 0);
  EXPECT_TRUE(uart_joy_driver::parseHexByte("FF", value));
  EXPECT_EQ(value, 255);
  EXPECT_TRUE(uart_joy_driver::parseHexByte("ff", value));
  EXPECT_EQ(value, 255);
  EXPECT_TRUE(uart_joy_driver::parseHexByte("7", value));
  EXPECT_EQ(value, 7);
}

TEST(ParseHexByteTest, RejectsInvalidTokens) {
  uint8_t value = 0;
  EXPECT_FALSE(uart_joy_driver::parseHexByte("", value));
  EXPECT_FALSE(uart_joy_driver::parseHexByte("100", value));
  EXPECT_FALSE(uart_joy_driver::parseHexByte("GG", value));
  EXPECT_FALSE(uart_joy_driver::parseHexByte("0x", value));
}

TEST(NormalizeAxisTest, NeutralValueIsZero) {
  EXPECT_DOUBLE_EQ(uart_joy_driver::normalizeAxis(0x80, false, kDeadzone), 0.0);
  EXPECT_DOUBLE_EQ(uart_joy_driver::normalizeAxis(0x80, true, kDeadzone), 0.0);
}

TEST(NormalizeAxisTest, ExtremesAreClampedAndInverted) {
  // 0x00 -> (0 - 128) / 127 = -1.0079 -> clamped to -1.0 -> inverted to +1.0.
  EXPECT_DOUBLE_EQ(uart_joy_driver::normalizeAxis(0x00, true, kDeadzone), 1.0);
  // 0xFF -> (255 - 128) / 127 = +1.0 -> inverted to -1.0.
  EXPECT_DOUBLE_EQ(uart_joy_driver::normalizeAxis(0xFF, true, kDeadzone), -1.0);
}

TEST(NormalizeAxisTest, DeadzoneSnapsSmallValuesToZero) {
  // 0x86 -> 6 / 127 = 0.0472 < 0.05 -> 0.0.
  EXPECT_DOUBLE_EQ(uart_joy_driver::normalizeAxis(0x86, false, kDeadzone), 0.0);
  // 0x8E -> 14 / 127 = 0.1102 >= 0.05 -> nonzero.
  EXPECT_NEAR(uart_joy_driver::normalizeAxis(0x8E, false, kDeadzone), 14.0 / 127.0, 1e-9);
}

TEST(FillDpadAxesTest, MapsAllDirections) {
  struct Case {
    uint8_t dpad;
    float horizontal;
    float vertical;
  };
  const std::vector<Case> cases = {
      {0, 0.0F, 0.0F},   {1, 0.0F, 1.0F},  {2, -1.0F, 1.0F},   {3, -1.0F, 0.0F},
      {4, -1.0F, -1.0F}, {5, 0.0F, -1.0F}, {6, 1.0F, -1.0F},   {7, 1.0F, 0.0F},
      {8, 1.0F, 1.0F},   {9, 0.0F, 0.0F},  {0xFF, 0.0F, 0.0F},
  };

  for (const auto& test_case : cases) {
    auto joy_msg = makeJoy();
    uart_joy_driver::fillDpadAxes(test_case.dpad, joy_msg);
    EXPECT_FLOAT_EQ(joy_msg.axes[6], test_case.horizontal) << "dpad=" << int{test_case.dpad};
    EXPECT_FLOAT_EQ(joy_msg.axes[7], test_case.vertical) << "dpad=" << int{test_case.dpad};
  }
}

TEST(ParseControllerLineTest, ParsesSevenTokenLine) {
  sensor_msgs::msg::Joy joy_msg;
  ASSERT_TRUE(uart_joy_driver::parseControllerLine("01,02,05,80,80,80,80", kDeadzone, joy_msg));

  ASSERT_EQ(joy_msg.axes.size(), uart_joy_driver::kJoyAxisCount);
  ASSERT_EQ(joy_msg.buttons.size(), uart_joy_driver::kJoyButtonCount);

  // byte0 = 0x01 -> button A only; byte1 = 0x02 -> Plus only.
  EXPECT_EQ(joy_msg.buttons[0], 1);
  for (size_t i = 1; i < 9; ++i) {
    EXPECT_EQ(joy_msg.buttons[i], 0) << "button " << i;
  }
  EXPECT_EQ(joy_msg.buttons[9], 1);
  for (size_t i = 10; i < joy_msg.buttons.size(); ++i) {
    EXPECT_EQ(joy_msg.buttons[i], 0) << "button " << i;
  }

  // dpad = 5 -> down: axes[6] = 0, axes[7] = -1; sticks neutral.
  EXPECT_FLOAT_EQ(joy_msg.axes[6], 0.0F);
  EXPECT_FLOAT_EQ(joy_msg.axes[7], -1.0F);
  EXPECT_FLOAT_EQ(joy_msg.axes[0], 0.0F);
  EXPECT_FLOAT_EQ(joy_msg.axes[1], 0.0F);
  EXPECT_FLOAT_EQ(joy_msg.axes[3], 0.0F);
  EXPECT_FLOAT_EQ(joy_msg.axes[4], 0.0F);
}

TEST(ParseControllerLineTest, ParsesEightTokenLineWithFunctionId) {
  sensor_msgs::msg::Joy joy_msg;
  ASSERT_TRUE(uart_joy_driver::parseControllerLine("01,01,02,05,00,FF,80,80", kDeadzone, joy_msg));

  // Data bytes after the function id: byte0=0x01, byte1=0x02, dpad=5,
  // lx=0x00, ly=0xFF, rx=0x80, ry=0x80.
  EXPECT_EQ(joy_msg.buttons[0], 1);
  EXPECT_EQ(joy_msg.buttons[9], 1);
  EXPECT_FLOAT_EQ(joy_msg.axes[6], 0.0F);
  EXPECT_FLOAT_EQ(joy_msg.axes[7], -1.0F);
  EXPECT_FLOAT_EQ(joy_msg.axes[0], 1.0F);   // lx=0x00 inverted.
  EXPECT_FLOAT_EQ(joy_msg.axes[1], -1.0F);  // ly=0xFF inverted.
  EXPECT_FLOAT_EQ(joy_msg.axes[3], 0.0F);
  EXPECT_FLOAT_EQ(joy_msg.axes[4], 0.0F);
}

TEST(ParseControllerLineTest, RejectsWrongFunctionId) {
  sensor_msgs::msg::Joy joy_msg;
  EXPECT_FALSE(uart_joy_driver::parseControllerLine("02,01,02,05,80,80,80,80", kDeadzone, joy_msg));
}

TEST(ParseControllerLineTest, StripsKeyPrefix) {
  sensor_msgs::msg::Joy joy_msg;
  ASSERT_TRUE(uart_joy_driver::parseControllerLine("JOY:01,00,05,80,80,80,80", kDeadzone, joy_msg));
  EXPECT_EQ(joy_msg.buttons[0], 1);
  EXPECT_FLOAT_EQ(joy_msg.axes[7], -1.0F);
}

TEST(ParseControllerLineTest, RejectsMalformedLines) {
  sensor_msgs::msg::Joy joy_msg;
  EXPECT_FALSE(uart_joy_driver::parseControllerLine("01,02,03,04,05,06", kDeadzone, joy_msg));
  EXPECT_FALSE(
      uart_joy_driver::parseControllerLine("01,02,03,04,05,06,07,08,09", kDeadzone, joy_msg));
  EXPECT_FALSE(uart_joy_driver::parseControllerLine("01,GG,05,80,80,80,80", kDeadzone, joy_msg));
  EXPECT_FALSE(uart_joy_driver::parseControllerLine("", kDeadzone, joy_msg));
}

TEST(ParseControllerLineTest, FullButtonBitmaps) {
  sensor_msgs::msg::Joy joy_msg;
  ASSERT_TRUE(uart_joy_driver::parseControllerLine("FF,3F,00,80,80,80,80", kDeadzone, joy_msg));

  ASSERT_EQ(joy_msg.axes.size(), uart_joy_driver::kJoyAxisCount);
  ASSERT_EQ(joy_msg.buttons.size(), uart_joy_driver::kJoyButtonCount);

  // byte0 = 0xFF -> buttons[0..7] all pressed.
  for (size_t i = 0; i < 8; ++i) {
    EXPECT_EQ(joy_msg.buttons[i], 1) << "button " << i;
  }
  // byte1 = 0x3F -> buttons[8..13] all pressed; 14 and 15 unused.
  for (size_t i = 8; i < 14; ++i) {
    EXPECT_EQ(joy_msg.buttons[i], 1) << "button " << i;
  }
  EXPECT_EQ(joy_msg.buttons[14], 0);
  EXPECT_EQ(joy_msg.buttons[15], 0);
}

}  // namespace

int main(int argc, char** argv) {
  testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
