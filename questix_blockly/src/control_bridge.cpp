// Adapter to the production QUESTiX control core. No ROS or device I/O.
#include <algorithm>

#include "motor_control_app/control_core.hpp"

using motor_control_app::control_core::Config;
using motor_control_app::control_core::ControlCore;

extern "C" {
void* questix_create(const double* p) {
  Config c;
  c.max_linear_accel = p[0];
  c.max_angular_accel = p[1];
  c.min_linear_accel = p[2];
  c.min_angular_accel = p[3];
  c.accel_demand_ref_linear = p[4];
  c.accel_demand_ref_angular = p[5];
  c.slew_taper_band_linear = p[6];
  c.slew_taper_band_angular = p[7];
  c.wheel_radius = p[8];
  c.wheel_separation = p[9];
  c.min_command_rpm = p[10];
  return new ControlCore(c);
}

void questix_destroy(void* ptr) { delete static_cast<ControlCore*>(ptr); }

void questix_reset(void* ptr) { static_cast<ControlCore*>(ptr)->reset(); }

void questix_step(void* ptr, double v, double w, double dt, int limit, double* result) {
  auto* core = static_cast<ControlCore*>(ptr);
  auto out = core->step(v, w, dt);
  int left = out.stop ? 0 : std::clamp(out.left_rpm, -limit, limit);
  int right = out.stop ? 0 : std::clamp(out.right_rpm, -limit, limit);
  auto twist = motor_control_lib::differential_kinematics::wheelRpmToTwist(
      left, right, core->config().wheel_radius, core->config().wheel_separation);
  result[0] = left;
  result[1] = right;
  result[2] = twist.first;
  result[3] = twist.second;
}
}
