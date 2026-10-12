// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef JOY_CONTROLLER__LAUNCHER_MAPPING_HPP_
#define JOY_CONTROLLER__LAUNCHER_MAPPING_HPP_

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

#include "joy_controller/tilt_input.hpp"

namespace joy_controller {

// The controller's launcher buttons as a questix_msgs/LauncherCommand (ROS-free, unit-tested):
// what joy_launcher publishes for every /joy message (design/safety_permission_input_refactor.md,
// section 4.1). The launcher nodes no longer read /joy.
// - roller_power: the roller button held -> roller_power (full_speed_value), released -> 0. A
//   level, sent with every /joy message: esc_motor_control stops the roller when they stop.
// - fire_seq: +1 on each fresh press of the fire button.
// - tilt_steps: +1 on each fresh press of "up", -1 on "down" (tilt_input.hpp: an axis direction or
//   a button per direction; both at once moves nothing).
// Inputs already held when the node starts count only after a release, like a fresh press.
struct LauncherMappingConfig {
  int fire_button{5};
  int tilt_up_axis{7};
  int tilt_up_axis_sign{1};
  int tilt_down_axis{7};
  int tilt_down_axis_sign{-1};
  int tilt_up_button_index{4};
  int tilt_down_button_index{6};
  int full_speed_button{7};      // the roller button
  double full_speed_value{1.0};  // the roller power while it is held (0..1)
};

// Whether the tilt directions are usable: an axis >= 0 (with a sign of +1 / -1) or -1 with a
// button >= 0 each, and the two directions not the same input.
inline bool validTiltInputs(const LauncherMappingConfig& c) {
  if (c.tilt_up_axis < -1 || c.tilt_down_axis < -1 ||
      (c.tilt_up_axis_sign != 1 && c.tilt_up_axis_sign != -1) ||
      (c.tilt_down_axis_sign != 1 && c.tilt_down_axis_sign != -1) || c.tilt_up_button_index < 0 ||
      c.tilt_down_button_index < 0) {
    return false;
  }
  if (c.tilt_up_axis != c.tilt_down_axis) {
    return true;
  }
  return c.tilt_up_axis == -1 ? c.tilt_up_button_index != c.tilt_down_button_index
                              : c.tilt_up_axis_sign != c.tilt_down_axis_sign;
}

class LauncherMapping {
public:
  struct Output {
    float roller_power{0.0F};
    int32_t tilt_steps{0};
    uint32_t fire_seq{0};
  };

  // The roller power is clamped to [0, 1] (a non-finite value is 0).
  void configure(const LauncherMappingConfig& config) {
    config_ = config;
    config_.full_speed_value = std::isfinite(config.full_speed_value)
                                   ? std::clamp(config.full_speed_value, 0.0, 1.0)
                                   : 0.0;
  }

  const LauncherMappingConfig& config() const { return config_; }

  Output onJoy(const std::vector<float>& axes, const std::vector<int32_t>& buttons) {
    const bool fire = pressed(buttons, config_.fire_button);
    if (fire && !fire_held_) {
      ++output_.fire_seq;
    }
    fire_held_ = fire;
    const bool up = tiltInputPressed(axes, buttons, config_.tilt_up_axis, config_.tilt_up_axis_sign,
                                     config_.tilt_up_button_index);
    const bool down = tiltInputPressed(axes, buttons, config_.tilt_down_axis,
                                       config_.tilt_down_axis_sign, config_.tilt_down_button_index);
    output_.tilt_steps += tilt_.update(up, down);
    output_.roller_power = pressed(buttons, config_.full_speed_button)
                               ? static_cast<float>(config_.full_speed_value)
                               : 0.0F;
    return output_;
  }

private:
  // Every index comes from a parameter: checked against this message (a negative one is unset).
  static bool pressed(const std::vector<int32_t>& buttons, int index) {
    return index >= 0 && static_cast<std::size_t>(index) < buttons.size() &&
           buttons[static_cast<std::size_t>(index)] == 1;
  }

  LauncherMappingConfig config_{};
  Output output_{};
  // Held at start: a press needs a release first.
  bool fire_held_{true};
  TiltInputEdges tilt_{held()};

  static TiltInputEdges held() {
    TiltInputEdges edges;
    edges.requireRelease();
    return edges;
  }
};

}  // namespace joy_controller

#endif  // JOY_CONTROLLER__LAUNCHER_MAPPING_HPP_
