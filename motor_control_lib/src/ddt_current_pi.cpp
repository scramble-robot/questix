// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "motor_control_lib/ddt_current_pi.hpp"

#include <algorithm>
#include <cmath>

namespace motor_control_lib::ddt_current_pi {

double sanitizeDt(double dt_seconds) {
  if (!(dt_seconds > 0.0 && dt_seconds <= 0.2)) {
    return 0.01;  // 異常値クリップ（初回および異常時のフォールバック [s]）
  }
  return dt_seconds;
}

bool inZeroDeadband(int rpm_ref, int measured_rpm, int deadband_rpm) {
  return rpm_ref == 0 && std::abs(measured_rpm) <= deadband_rpm;
}

int16_t stepToRaw(State& state, const Params& params, int rpm_ref, int measured_rpm, double dt,
                  double* i_cmd_amp_out) {
  int measured = params.invert_measured ? -measured_rpm : measured_rpm;

  double error = static_cast<double>(rpm_ref - measured);

  // 積分項更新 (アンチワインドアップ: 積分項寄与 = Ki * integral を ±integral_limit_amp
  // にクランプ)
  state.integral_amp += error * dt;
  if (params.ki > 1e-9) {
    double integ_clip = params.integral_limit_amp / params.ki;
    state.integral_amp = std::clamp(state.integral_amp, -integ_clip, integ_clip);
  } else {
    state.integral_amp = 0.0;
  }

  double i_cmd_amp = params.kp * error + params.ki * state.integral_amp;
  i_cmd_amp = std::clamp(i_cmd_amp, -params.max_current_amp, params.max_current_amp);
  if (i_cmd_amp_out != nullptr) {
    *i_cmd_amp_out = i_cmd_amp;
  }

  // -8A..8A が -32767..32767 に対応（仕様書）
  double raw_d = (i_cmd_amp / 8.0) * 32767.0;
  int raw = static_cast<int>(std::lround(raw_d));
  raw = std::clamp(raw, -32767, 32767);
  return static_cast<int16_t>(raw);
}

}  // namespace motor_control_lib::ddt_current_pi
