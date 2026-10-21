// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "motor_control_lib/ddt_current_pi.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>

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

double frictionFeedforwardAmp(int rpm_ref, const Params& params) {
  if (rpm_ref == 0) {
    return 0.0;
  }
  const double ref = static_cast<double>(rpm_ref);
  const double static_scale = std::clamp(ref / kFrictionFfFullRpm, -1.0, 1.0);
  return params.ff_static_amp * static_scale + params.ff_viscous_amp_per_rpm * ref;
}

int16_t ampToRaw(double amp) {
  const double raw_d = amp / kAmpPerRaw;
  if (!std::isfinite(raw_d)) {
    return 0;
  }
  const long raw = std::lround(std::clamp(raw_d, -32767.0, 32767.0));
  return static_cast<int16_t>(raw);
}

double rawToAmp(int16_t raw) { return static_cast<double>(raw) * kAmpPerRaw; }

int16_t stepToRaw(State& state, const Params& params, int rpm_ref, double measured_rpm, double dt,
                  double* i_cmd_amp_out, bool* saturated_out) {
  const double measured = params.invert_measured ? -measured_rpm : measured_rpm;
  const double error = static_cast<double>(rpm_ref) - measured;

  // 積分項は電流 [A] で持つ（Ki を掛けてから積算する）。±integral_limit_amp でクランプ。
  double integral_candidate = 0.0;
  if (params.ki > 1e-9) {
    integral_candidate = std::clamp(state.integral_amp + params.ki * error * dt,
                                    -params.integral_limit_amp, params.integral_limit_amp);
  }

  const double unclamped =
      frictionFeedforwardAmp(rpm_ref, params) + params.kp * error + integral_candidate;
  const double i_cmd_amp = std::clamp(unclamped, -params.max_current_amp, params.max_current_amp);
  const bool saturated = i_cmd_amp != unclamped;

  // 条件付き積分: 出力が上限に張り付き、誤差がさらに張り付く向きなら積分を進めない。
  const bool pushing_into_limit = (unclamped > params.max_current_amp && error > 0.0) ||
                                  (unclamped < -params.max_current_amp && error < 0.0);
  if (params.ki <= 1e-9) {
    state.integral_amp = 0.0;
  } else if (!pushing_into_limit) {
    state.integral_amp = integral_candidate;
  }

  if (i_cmd_amp_out != nullptr) {
    *i_cmd_amp_out = i_cmd_amp;
  }
  if (saturated_out != nullptr) {
    *saturated_out = saturated;
  }
  return ampToRaw(i_cmd_amp);
}

const char* guardTripName(GuardTrip trip) {
  switch (trip) {
    case GuardTrip::kNone:
      return "none";
    case GuardTrip::kAccelAgainstCurrent:
      return "against";
    case GuardTrip::kOverspeed:
      return "overspeed";
    case GuardTrip::kOscillation:
      return "oscillation";
    case GuardTrip::kModeMismatch:
      return "mode";
  }
  return "unknown";
}

namespace {

int signOf(double v) { return (v > 0.0) - (v < 0.0); }

}  // namespace

GuardTrip updateGuard(GuardState& state, const GuardParams& params, const GuardSample& sample) {
  const double prev_abs = std::abs(sample.measured_prev_rpm);
  const double new_abs = std::abs(sample.measured_new_rpm);

  // 1) 回転を止める向きの電流の下で速くなり続けた（正帰還・外力）。
  //    2 つの実測の間に流れていたのは前の周期の指令（applied_amp）なので、それと比べる。
  const double against_min_amp =
      std::min(kAgainstMinCurrentAmp, 0.5 * std::max(0.0, sample.max_current_amp));
  const int prev_sign = signOf(sample.measured_prev_rpm);
  const bool braking = against_min_amp > 0.0 && std::abs(sample.applied_amp) >= against_min_amp &&
                       std::abs(sample.measured_prev_rpm) >= kAgainstMinSpeedRpm &&
                       signOf(sample.measured_new_rpm) == prev_sign &&
                       signOf(sample.applied_amp) == -prev_sign;
  if (braking) {
    // 正味の増加で数える（量子化ノイズの上下では溜まらない）。
    state.against_growth_rpm = std::max(0.0, state.against_growth_rpm + new_abs - prev_abs);
    if (state.against_growth_rpm >= kAgainstGrowthRpm) {
      return GuardTrip::kAccelAgainstCurrent;
    }
  } else {
    state.against_growth_rpm = 0.0;
  }

  // 2) 目標を超えたまま減速しない。
  if (new_abs > std::abs(static_cast<double>(sample.rpm_ref)) + params.overspeed_margin_rpm) {
    if (!state.overspeed_active) {
      state.overspeed_active = true;
      state.overspeed_since_sec = sample.now_sec;
      state.overspeed_start_abs_rpm = new_abs;
    } else if (sample.now_sec - state.overspeed_since_sec >= params.overspeed_time_sec &&
               new_abs >= state.overspeed_start_abs_rpm - kOverspeedSlowdownTolRpm) {
      return GuardTrip::kOverspeed;
    }
  } else {
    state.overspeed_active = false;
  }

  // 3) 上限に張り付いた電流指令の向きが短時間に入れ替わる（上限から上限への発振）。
  auto& n = state.saturation_count;
  // 古い記録を捨てる（記録は古い順）。
  int keep_from = 0;
  while (keep_from < n &&
         sample.now_sec - state.saturation_times[keep_from] > kOscillationWindowSec) {
    ++keep_from;
  }
  if (keep_from > 0) {
    for (int i = keep_from; i < n; ++i) {
      state.saturation_times[i - keep_from] = state.saturation_times[i];
      state.saturation_signs[i - keep_from] = state.saturation_signs[i];
    }
    n -= keep_from;
  }
  if (sample.max_current_amp > 0.0 &&
      std::abs(sample.commanded_amp) >= kSaturationFraction * sample.max_current_amp) {
    const auto sign = static_cast<int8_t>(signOf(sample.commanded_amp));
    if (n == 0 || state.saturation_signs[n - 1] != sign) {
      if (n == kOscillationSwitches) {  // 満杯なら最古を捨てる（ここには来ない想定の保険）
        for (int i = 1; i < n; ++i) {
          state.saturation_times[i - 1] = state.saturation_times[i];
          state.saturation_signs[i - 1] = state.saturation_signs[i];
        }
        --n;
      }
      state.saturation_times[n] = sample.now_sec;
      state.saturation_signs[n] = sign;
      ++n;
      if (n >= kOscillationSwitches) {
        return GuardTrip::kOscillation;
      }
    }
  }
  return GuardTrip::kNone;
}

}  // namespace motor_control_lib::ddt_current_pi
