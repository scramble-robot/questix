// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <cstdint>
#include <limits>
#include <vector>

#include "joy_controller/launcher_mapping.hpp"

using joy_controller::LauncherMapping;
using joy_controller::LauncherMappingConfig;
using joy_controller::validTiltInputs;

namespace {

// fire 0, roller 1, tilt up/down on buttons 2/3 (axis -1).
LauncherMappingConfig buttons() {
  LauncherMappingConfig config;
  config.fire_button = 0;
  config.full_speed_button = 1;
  config.full_speed_value = 0.6;
  config.tilt_up_axis = config.tilt_down_axis = -1;
  config.tilt_up_button_index = 2;
  config.tilt_down_button_index = 3;
  return config;
}

std::vector<int32_t> pressed(std::initializer_list<int> indices) {
  std::vector<int32_t> out(8, 0);
  for (const int index : indices) {
    out[static_cast<size_t>(index)] = 1;
  }
  return out;
}

}  // namespace

TEST(LauncherMapping, FireCountsFreshPressesOnly) {
  LauncherMapping mapping;
  mapping.configure(buttons());
  EXPECT_EQ(mapping.onJoy({}, pressed({})).fire_seq, 0u);
  EXPECT_EQ(mapping.onJoy({}, pressed({0})).fire_seq, 1u);
  EXPECT_EQ(mapping.onJoy({}, pressed({0})).fire_seq, 1u);  // held: one shot
  EXPECT_EQ(mapping.onJoy({}, pressed({})).fire_seq, 1u);
  EXPECT_EQ(mapping.onJoy({}, pressed({0})).fire_seq, 2u);
}

TEST(LauncherMapping, InputsHeldAtStartNeedARelease) {
  LauncherMapping mapping;
  mapping.configure(buttons());
  auto out = mapping.onJoy({}, pressed({0, 2}));
  EXPECT_EQ(out.fire_seq, 0u);
  EXPECT_EQ(out.tilt_steps, 0);
  out = mapping.onJoy({}, pressed({}));
  out = mapping.onJoy({}, pressed({0, 2}));
  EXPECT_EQ(out.fire_seq, 1u);
  EXPECT_EQ(out.tilt_steps, 1);
}

TEST(LauncherMapping, TiltStepsAccumulateAndConflictsMoveNothing) {
  LauncherMapping mapping;
  mapping.configure(buttons());
  mapping.onJoy({}, pressed({}));
  EXPECT_EQ(mapping.onJoy({}, pressed({2})).tilt_steps, 1);
  EXPECT_EQ(mapping.onJoy({}, pressed({})).tilt_steps, 1);
  EXPECT_EQ(mapping.onJoy({}, pressed({3})).tilt_steps, 0);
  EXPECT_EQ(mapping.onJoy({}, pressed({})).tilt_steps, 0);
  EXPECT_EQ(mapping.onJoy({}, pressed({3})).tilt_steps, -1);
  EXPECT_EQ(mapping.onJoy({}, pressed({})).tilt_steps, -1);
  EXPECT_EQ(mapping.onJoy({}, pressed({2, 3})).tilt_steps, -1);  // both: nothing
}

TEST(LauncherMapping, TiltOnAnAxisDirection) {
  LauncherMappingConfig config = buttons();
  config.tilt_up_axis = config.tilt_down_axis = 7;
  config.tilt_up_axis_sign = 1;
  config.tilt_down_axis_sign = -1;
  LauncherMapping mapping;
  mapping.configure(config);
  std::vector<float> axes(8, 0.0F);
  mapping.onJoy(axes, pressed({}));
  axes[7] = 1.0F;
  EXPECT_EQ(mapping.onJoy(axes, pressed({})).tilt_steps, 1);
  axes[7] = -1.0F;
  EXPECT_EQ(mapping.onJoy(axes, pressed({})).tilt_steps, 0);
}

TEST(LauncherMapping, RollerIsALevelWhileTheButtonIsHeld) {
  LauncherMapping mapping;
  mapping.configure(buttons());
  EXPECT_FLOAT_EQ(mapping.onJoy({}, pressed({1})).roller_power, 0.6F);
  EXPECT_FLOAT_EQ(mapping.onJoy({}, pressed({1})).roller_power, 0.6F);
  EXPECT_FLOAT_EQ(mapping.onJoy({}, pressed({})).roller_power, 0.0F);
}

TEST(LauncherMapping, RollerPowerIsClampedAndIndicesAreBoundsChecked) {
  LauncherMappingConfig config = buttons();
  config.full_speed_value = 3.0;
  LauncherMapping mapping;
  mapping.configure(config);
  EXPECT_FLOAT_EQ(mapping.onJoy({}, pressed({1})).roller_power, 1.0F);
  config.full_speed_value = std::numeric_limits<double>::quiet_NaN();
  mapping.configure(config);
  EXPECT_FLOAT_EQ(mapping.onJoy({}, pressed({1})).roller_power, 0.0F);
  config = buttons();
  config.fire_button = 40;  // beyond this controller's buttons: never pressed
  config.full_speed_button = -1;
  mapping.configure(config);
  const auto out = mapping.onJoy({}, {1, 1});
  EXPECT_FLOAT_EQ(out.roller_power, 0.0F);
}

TEST(LauncherMapping, TiltInputValidation) {
  LauncherMappingConfig config = buttons();
  EXPECT_TRUE(validTiltInputs(config));
  config.tilt_down_button_index = config.tilt_up_button_index;
  EXPECT_FALSE(validTiltInputs(config));  // the same button for both
  config = buttons();
  config.tilt_up_axis = config.tilt_down_axis = 7;
  config.tilt_up_axis_sign = config.tilt_down_axis_sign = 1;
  EXPECT_FALSE(validTiltInputs(config));  // the same half-axis for both
  config.tilt_down_axis_sign = -1;
  EXPECT_TRUE(validTiltInputs(config));
  config.tilt_up_axis_sign = 2;
  EXPECT_FALSE(validTiltInputs(config));
  config = buttons();
  config.tilt_up_axis = -3;
  EXPECT_FALSE(validTiltInputs(config));
}
