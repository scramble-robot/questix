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

#include <cstddef>
#include <sensor_msgs/msg/joy.hpp>
#include <uart_joy_driver/dropout_filter.hpp>
#include <vector>

namespace {

constexpr size_t kAxisCount = 8;
constexpr size_t kButtonCount = 16;

uart_joy_driver::DropoutFilter makeFilter(int axis_frames = 2, int button_frames = 2) {
  uart_joy_driver::DropoutFilter filter;
  uart_joy_driver::DropoutFilter::Config config;
  config.hold_axis_threshold = 0.1;
  config.axis_release_confirm_frames = axis_frames;
  config.button_release_confirm_frames = button_frames;
  filter.configure(config);
  return filter;
}

sensor_msgs::msg::Joy makeJoy(float axis0 = 0.0F, int button0 = 0) {
  sensor_msgs::msg::Joy joy_msg;
  joy_msg.axes.assign(kAxisCount, 0.0F);
  joy_msg.buttons.assign(kButtonCount, 0);
  joy_msg.axes[0] = axis0;
  joy_msg.buttons[0] = button0;
  return joy_msg;
}

float applyAxis(uart_joy_driver::DropoutFilter& filter, float axis0) {
  auto joy_msg = makeJoy(axis0);
  filter.apply(joy_msg);
  return joy_msg.axes[0];
}

int applyButton(uart_joy_driver::DropoutFilter& filter, int button0) {
  auto joy_msg = makeJoy(0.0F, button0);
  filter.apply(joy_msg);
  return joy_msg.buttons[0];
}

TEST(DropoutFilterTest, ActiveAxisPassesThrough) {
  auto filter = makeFilter();
  EXPECT_FLOAT_EQ(applyAxis(filter, 0.8F), 0.8F);
}

TEST(DropoutFilterTest, AxisDropoutHeldUntilConfirmed) {
  auto filter = makeFilter();
  EXPECT_FLOAT_EQ(applyAxis(filter, 0.8F), 0.8F);
  // First zero frame: held (release count 1 of 2).
  EXPECT_FLOAT_EQ(applyAxis(filter, 0.0F), 0.8F);
  // Second zero frame: release confirmed.
  EXPECT_FLOAT_EQ(applyAxis(filter, 0.0F), 0.0F);
}

TEST(DropoutFilterTest, ReleaseCounterResetsOnReactivation) {
  auto filter = makeFilter();
  EXPECT_FLOAT_EQ(applyAxis(filter, 0.8F), 0.8F);
  EXPECT_FLOAT_EQ(applyAxis(filter, 0.0F), 0.8F);  // count 1
  EXPECT_FLOAT_EQ(applyAxis(filter, 0.8F), 0.8F);  // re-press resets count
  EXPECT_FLOAT_EQ(applyAxis(filter, 0.0F), 0.8F);  // count restarts at 1
  EXPECT_FLOAT_EQ(applyAxis(filter, 0.0F), 0.0F);  // count 2: released
}

TEST(DropoutFilterTest, SubThresholdAxisIsNotHeld) {
  auto filter = makeFilter();
  EXPECT_FLOAT_EQ(applyAxis(filter, 0.05F), 0.0F);
  EXPECT_FLOAT_EQ(applyAxis(filter, 0.0F), 0.0F);
}

TEST(DropoutFilterTest, ButtonDropoutHeldUntilConfirmed) {
  auto filter = makeFilter();
  EXPECT_EQ(applyButton(filter, 1), 1);
  EXPECT_EQ(applyButton(filter, 0), 1);
  EXPECT_EQ(applyButton(filter, 0), 0);
}

TEST(DropoutFilterTest, ZeroConfirmFramesBehavesAsOne) {
  auto filter = makeFilter(0, 0);
  EXPECT_EQ(applyButton(filter, 1), 1);
  EXPECT_EQ(applyButton(filter, 0), 0);

  auto axis_filter = makeFilter(0, 0);
  EXPECT_FLOAT_EQ(applyAxis(axis_filter, 0.8F), 0.8F);
  EXPECT_FLOAT_EQ(applyAxis(axis_filter, 0.0F), 0.0F);
}

TEST(DropoutFilterTest, ResizesForDifferentMessageShapes) {
  auto filter = makeFilter();
  EXPECT_FLOAT_EQ(applyAxis(filter, 0.8F), 0.8F);

  sensor_msgs::msg::Joy small_msg;
  small_msg.axes.assign(3, 0.5F);
  small_msg.buttons.assign(2, 1);
  filter.apply(small_msg);
  ASSERT_EQ(small_msg.axes.size(), 3U);
  ASSERT_EQ(small_msg.buttons.size(), 2U);
  EXPECT_FLOAT_EQ(small_msg.axes[0], 0.5F);
  EXPECT_EQ(small_msg.buttons[0], 1);
}

TEST(DropoutFilterTest, ResetClearsHeldState) {
  auto filter = makeFilter();
  auto active_msg = makeJoy(0.8F, 1);
  filter.apply(active_msg);
  EXPECT_FLOAT_EQ(active_msg.axes[0], 0.8F);
  EXPECT_EQ(active_msg.buttons[0], 1);

  filter.reset(kAxisCount, kButtonCount);

  // Without reset these would be held for one more frame.
  auto neutral_msg = makeJoy();
  filter.apply(neutral_msg);
  EXPECT_FLOAT_EQ(neutral_msg.axes[0], 0.0F);
  EXPECT_EQ(neutral_msg.buttons[0], 0);
}

}  // namespace

int main(int argc, char** argv) {
  testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
