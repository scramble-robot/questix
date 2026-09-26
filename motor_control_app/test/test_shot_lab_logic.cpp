// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

#include "motor_control_app/shot_lab_logic.hpp"

namespace {

namespace shot_lab = motor_control_app::shot_lab;
using shot_lab::Refusal;

constexpr double kInf = std::numeric_limits<double>::infinity();
// Defaults from shot_config.yaml: lab_joy_quiet_sec 1.0, lab_min_fire_interval_sec 2.0,
// tilt range 0..120 deg.
constexpr double kQuiet = 1.0;
constexpr double kInterval = 2.0;
constexpr double kMinDeg = 0.0;
constexpr double kMaxDeg = 120.0;

shot_lab::Conditions ready(double now_sec = 100.0) {
  shot_lab::Conditions c;
  c.accept = true;
  c.estop = false;
  c.active = true;
  c.shooting = false;
  c.now_sec = now_sec;
  c.joy_active_at_sec = -kInf;
  c.joy_quiet_sec = kQuiet;
  return c;
}

// ---- tilt ----

TEST(ShotLabTilt, AppliesWithinRange) {
  const auto d = shot_lab::decideTilt(ready(), 45.0, kMinDeg, kMaxDeg);
  EXPECT_EQ(d.refusal, Refusal::kNone);
  EXPECT_DOUBLE_EQ(d.target_deg, 45.0);
}

TEST(ShotLabTilt, ClampsToTiltRange) {
  EXPECT_DOUBLE_EQ(shot_lab::decideTilt(ready(), 500.0, kMinDeg, kMaxDeg).target_deg, 120.0);
  EXPECT_DOUBLE_EQ(shot_lab::decideTilt(ready(), -30.0, kMinDeg, kMaxDeg).target_deg, 0.0);
}

TEST(ShotLabTilt, NonFiniteIsInvalid) {
  EXPECT_EQ(shot_lab::decideTilt(ready(), std::nan(""), kMinDeg, kMaxDeg).refusal,
            Refusal::kInvalid);
  EXPECT_EQ(shot_lab::decideTilt(ready(), kInf, kMinDeg, kMaxDeg).refusal, Refusal::kInvalid);
}

TEST(ShotLabTilt, RefusedWhenNotAccepted) {
  auto c = ready();
  c.accept = false;
  EXPECT_EQ(shot_lab::decideTilt(c, 45.0, kMinDeg, kMaxDeg).refusal, Refusal::kNotAccepted);
}

TEST(ShotLabTilt, RefusedDuringEmergencyStop) {
  auto c = ready();
  c.estop = true;
  c.active = false;  // the node tears down on E-stop; the E-stop reason wins
  EXPECT_EQ(shot_lab::decideTilt(c, 45.0, kMinDeg, kMaxDeg).refusal, Refusal::kEmergencyStop);
}

TEST(ShotLabTilt, RefusedWhenInactive) {
  auto c = ready();
  c.active = false;
  EXPECT_EQ(shot_lab::decideTilt(c, 45.0, kMinDeg, kMaxDeg).refusal, Refusal::kInactive);
}

TEST(ShotLabTilt, RefusedWhileShooting) {
  auto c = ready();
  c.shooting = true;
  EXPECT_EQ(shot_lab::decideTilt(c, 45.0, kMinDeg, kMaxDeg).refusal, Refusal::kShooting);
}

TEST(ShotLabTilt, RefusedUntilControllerQuiet) {
  auto c = ready(100.0);
  c.joy_active_at_sec = 99.5;
  EXPECT_EQ(shot_lab::decideTilt(c, 45.0, kMinDeg, kMaxDeg).refusal, Refusal::kController);
  c.now_sec = 100.5;  // exactly joy_quiet_sec: still the controller's
  EXPECT_EQ(shot_lab::decideTilt(c, 45.0, kMinDeg, kMaxDeg).refusal, Refusal::kController);
  c.now_sec = 100.51;
  EXPECT_EQ(shot_lab::decideTilt(c, 45.0, kMinDeg, kMaxDeg).refusal, Refusal::kNone);
}

// ---- fire ----

TEST(ShotLabFire, FirstShotAllowed) {
  EXPECT_EQ(shot_lab::decideFire(ready(), -kInf, kInterval), Refusal::kNone);
}

TEST(ShotLabFire, IntervalSinceLastShotFromAnySource) {
  auto c = ready(100.0);
  EXPECT_EQ(shot_lab::decideFire(c, 98.5, kInterval), Refusal::kInterval);
  c.now_sec = 100.5;
  EXPECT_EQ(shot_lab::decideFire(c, 98.5, kInterval), Refusal::kNone);
}

TEST(ShotLabFire, SharesTheCommonChecks) {
  auto c = ready();
  c.shooting = true;
  EXPECT_EQ(shot_lab::decideFire(c, -kInf, kInterval), Refusal::kShooting);
  c = ready();
  c.estop = true;
  EXPECT_EQ(shot_lab::decideFire(c, -kInf, kInterval), Refusal::kEmergencyStop);
  c = ready();
  c.active = false;
  EXPECT_EQ(shot_lab::decideFire(c, -kInf, kInterval), Refusal::kInactive);
  c = ready();
  c.accept = false;
  EXPECT_EQ(shot_lab::decideFire(c, -kInf, kInterval), Refusal::kNotAccepted);
  c = ready(100.0);
  c.joy_active_at_sec = 99.9;
  EXPECT_EQ(shot_lab::decideFire(c, -kInf, kInterval), Refusal::kController);
}

TEST(ShotLabFire, NextFireInSec) {
  EXPECT_DOUBLE_EQ(shot_lab::nextFireInSec(100.0, -kInf, kInterval), 0.0);
  EXPECT_DOUBLE_EQ(shot_lab::nextFireInSec(100.0, 99.5, kInterval), 1.5);
  EXPECT_DOUBLE_EQ(shot_lab::nextFireInSec(100.0, 90.0, kInterval), 0.0);
}

// ---- controller activity ----

// fire_button 5; tilt up/down on axis 7 (D-pad vertical, + up / - down) as in controls.uart.yaml,
// or on buttons 4 / 6 when the axes are -1.
const shot_lab::TiltControl kUpAxis{7, 1, 4};
const shot_lab::TiltControl kDownAxis{7, -1, 6};
const shot_lab::TiltControl kUpButton{-1, 1, 4};
const shot_lab::TiltControl kDownButton{-1, -1, 6};

TEST(ShotLabJoy, FireButtonCounts) {
  std::vector<int32_t> buttons(12, 0);
  std::vector<float> axes(8, 0.0F);
  EXPECT_FALSE(shot_lab::joyUsesLauncher(buttons, axes, 5, kUpAxis, kDownAxis));
  buttons[5] = 1;
  EXPECT_TRUE(shot_lab::joyUsesLauncher(buttons, axes, 5, kUpAxis, kDownAxis));
}

TEST(ShotLabJoy, AxisModeUsesEachDirectionsSign) {
  std::vector<int32_t> buttons(12, 0);
  std::vector<float> axes(8, 0.0F);
  axes[7] = 1.0F;
  EXPECT_TRUE(shot_lab::joyUsesLauncher(buttons, axes, 5, kUpAxis, kDownAxis));
  axes[7] = -1.0F;
  EXPECT_TRUE(shot_lab::joyUsesLauncher(buttons, axes, 5, kUpAxis, kDownAxis));
  axes[7] = 0.3F;
  EXPECT_FALSE(shot_lab::joyUsesLauncher(buttons, axes, 5, kUpAxis, kDownAxis));
  axes[7] = 0.0F;
  buttons[4] = 1;  // the tilt buttons are not the tilt input in axis mode
  EXPECT_FALSE(shot_lab::joyUsesLauncher(buttons, axes, 5, kUpAxis, kDownAxis));
}

TEST(ShotLabJoy, ButtonModeUsesTheTiltButtons) {
  std::vector<int32_t> buttons(12, 0);
  std::vector<float> axes(8, 0.0F);
  buttons[6] = 1;
  EXPECT_TRUE(shot_lab::joyUsesLauncher(buttons, axes, 5, kUpButton, kDownButton));
  buttons[6] = 0;
  buttons[4] = 1;
  EXPECT_TRUE(shot_lab::joyUsesLauncher(buttons, axes, 5, kUpButton, kDownButton));
}

TEST(ShotLabJoy, MixedDirectionsAreCheckedSeparately) {
  std::vector<int32_t> buttons(12, 0);
  std::vector<float> axes(8, 0.0F);
  buttons[6] = 1;  // down on a button, up on the axis
  EXPECT_TRUE(shot_lab::joyUsesLauncher(buttons, axes, 5, kUpAxis, kDownButton));
}

TEST(ShotLabJoy, OutOfRangeIndicesAreIgnored) {
  std::vector<int32_t> buttons(3, 1);
  std::vector<float> axes;
  EXPECT_FALSE(shot_lab::joyUsesLauncher(buttons, axes, 5, kUpAxis, kDownAxis));
  EXPECT_FALSE(shot_lab::joyUsesLauncher(buttons, axes, -1, {-1, 1, -1}, {-1, -1, -1}));
}

// ---- status ----

TEST(ShotLabStatus, JsonHasEveryField) {
  shot_lab::Status s;
  s.tilt_deg = 42.0;
  s.shooting = true;
  s.fired_count = 3;
  s.last_fire_source = shot_lab::FireSource::kLab;
  s.lab_accepted = true;
  s.estop = false;
  s.active = true;
  s.tilt_min_deg = 0.0;
  s.tilt_max_deg = 120.0;
  s.next_fire_in_sec = 1.25;
  s.lab_refused = Refusal::kInterval;
  EXPECT_EQ(shot_lab::statusJson(s),
            "{\"tilt_deg\": 42.0, \"shooting\": true, \"fired_count\": 3, "
            "\"last_fire_source\": \"lab\", \"lab_accepted\": true, \"estop\": false, "
            "\"active\": true, \"tilt_min_deg\": 0.0, \"tilt_max_deg\": 120.0, "
            "\"next_fire_in_sec\": 1.25, \"lab_refused\": \"interval\"}");
}

TEST(ShotLabStatus, NullsAndNonFinite) {
  shot_lab::Status s;
  s.tilt_deg = std::nan("");
  const std::string json = shot_lab::statusJson(s);
  EXPECT_NE(json.find("\"last_fire_source\": null"), std::string::npos);
  EXPECT_NE(json.find("\"lab_refused\": null"), std::string::npos);
  EXPECT_NE(json.find("\"tilt_deg\": 0.0"), std::string::npos);
  s.last_fire_source = shot_lab::FireSource::kJoy;
  EXPECT_NE(shot_lab::statusJson(s).find("\"last_fire_source\": \"joy\""), std::string::npos);
}

TEST(ShotLabStatus, RefusalNames) {
  EXPECT_STREQ(shot_lab::refusalName(Refusal::kNotAccepted), "not_accepted");
  EXPECT_STREQ(shot_lab::refusalName(Refusal::kEmergencyStop), "emergency_stop");
  EXPECT_STREQ(shot_lab::refusalName(Refusal::kInactive), "inactive");
  EXPECT_STREQ(shot_lab::refusalName(Refusal::kShooting), "shooting");
  EXPECT_STREQ(shot_lab::refusalName(Refusal::kController), "controller");
  EXPECT_STREQ(shot_lab::refusalName(Refusal::kInterval), "interval");
  EXPECT_STREQ(shot_lab::refusalName(Refusal::kInvalid), "invalid");
  EXPECT_STREQ(shot_lab::refusalName(Refusal::kRateLimited), "rate_limited");
}

}  // namespace
