// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef JOY_CONTROLLER__TILT_INPUT_HPP_
#define JOY_CONTROLLER__TILT_INPUT_HPP_

#include <cmath>
#include <cstdint>
#include <vector>

namespace joy_controller {

// One tilt direction of the controller: its axis past +-0.5 in its sign, or its button when the
// axis is -1. Missing configured inputs stay inactive; never fall back to another control.
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
  // Treat both directions as held: a press that is still down (from before an activation or
  // while the launcher was not allowed) moves nothing until it is released and pressed again.
  void requireRelease() { up_ = down_ = true; }

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

}  // namespace joy_controller

#endif  // JOY_CONTROLLER__TILT_INPUT_HPP_
