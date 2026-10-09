// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef ESC_MOTOR_CONTROL_CPP__PWM_COMMAND_HPP_
#define ESC_MOTOR_CONTROL_CPP__PWM_COMMAND_HPP_

#include <functional>

#include "esc_motor_control_cpp/pwm_backend.hpp"

namespace esc_motor_control_cpp {

/// Tracks API-accepted pulses, not measured waveforms or motor rotation.
/// The owner serializes access. A fault can only be cleared by constructing a new instance.
class PwmCommand {
public:
  using ChangeLog = std::function<void(int, int, double)>;
  using ErrorLog = std::function<void(int)>;

  bool send(PwmBackend& backend, int pin, int pulse_us, double speed, const ChangeLog& changed,
            const ErrorLog& error) {
    if (pwm_fault_ && speed != 0.0) return false;
    if (requested_pulse_us_ != pulse_us) {
      changed(requested_pulse_us_, pulse_us, speed);
      requested_pulse_us_ = pulse_us;
    }
    if (attempt(backend, pin, pulse_us, error)) return true;
    if (speed != 0.0) return false;
    // One immediate retry for a stop/arm request. The first failure remains latched.
    if (attempt(backend, pin, pulse_us, error)) return true;
    stop_failed_neutral(backend, pin, error);
    return false;
  }

  bool initialize(PwmBackend& backend, int pin, int neutral_us, const ChangeLog& changed,
                  const ErrorLog& error) {
    const bool sent = send(backend, pin, neutral_us, 0.0, changed, error);
    return sent && !pwm_fault_;  // Never declare ready after even one arm failure.
  }

  bool fault() const { return pwm_fault_; }
  int applied_pulse_us() const { return applied_pulse_us_; }
  bool needs_stop(int stop_us) const {
    return applied_pulse_us_ != 0 && applied_pulse_us_ != stop_us;
  }

  static bool valid_pulse(int pulse_us) {
    return pulse_us == 0 || (pulse_us >= 500 && pulse_us <= 2500);
  }

private:
  bool attempt(PwmBackend& backend, int pin, int pulse_us, const ErrorLog& error) {
    if (backend.set_servo_pulse(pin, pulse_us)) {
      applied_pulse_us_ = pulse_us;
      return true;
    }
    pwm_fault_ = true;
    error(backend.last_error());
    return false;
  }

  // Approved fallback (2026-10-09). HYP4 hardware verification is still required.
  // Keep the policy here so it can be replaced by continued neutral retries if necessary.
  void stop_failed_neutral(PwmBackend& backend, int pin, const ErrorLog& error) {
    if (backend.stop_signal(pin)) {
      applied_pulse_us_ = 0;
    } else {
      error(backend.last_error());
    }
  }

  bool pwm_fault_{false};
  int applied_pulse_us_{-1};  // Unknown until a backend operation succeeds.
  int requested_pulse_us_{-1};
};

}  // namespace esc_motor_control_cpp

#endif  // ESC_MOTOR_CONTROL_CPP__PWM_COMMAND_HPP_
