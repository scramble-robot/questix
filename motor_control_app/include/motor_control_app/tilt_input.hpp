// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__TILT_INPUT_HPP_
#define MOTOR_CONTROL_APP__TILT_INPUT_HPP_

#include <cmath>
#include <cstdint>
#include <vector>

namespace motor_control_app {

// Missing configured inputs stay inactive; never fall back to another control.
inline bool tiltInputPressed(const std::vector<float>& axes, const std::vector<int32_t>& buttons,
                             int axis, int sign, int button) {
  if (axis == -1) {
    return button >= 0 && static_cast<size_t>(button) < buttons.size() && buttons[button] == 1;
  }
  return axis >= 0 && static_cast<size_t>(axis) < axes.size() && (sign == 1 || sign == -1) &&
         std::isfinite(axes[axis]) && axes[axis] * sign > 0.5F;
}

class TiltInputEdges {
public:
  void reset() { up_ = down_ = false; }

  // One step on a fresh press. Conflicting simultaneous inputs produce no motion.
  int update(bool up, bool down) {
    const int direction = up && !up_ && !down ? 1 : down && !down_ && !up ? -1 : 0;
    up_ = up;
    down_ = down;
    return direction;
  }

private:
  bool up_ = false;
  bool down_ = false;
};

}  // namespace motor_control_app

#endif  // MOTOR_CONTROL_APP__TILT_INPUT_HPP_
