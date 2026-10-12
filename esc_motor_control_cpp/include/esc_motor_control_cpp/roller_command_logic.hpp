// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>
#include <string>

namespace esc_motor_control_cpp {

// The roller follows /launcher_command roller_power (questix_msgs/LauncherCommand, a level sent
// continuously while in use). ROS-free and clock-injected (now_sec, monotonic) so every rule is
// unit-tested. Who may command the roller (the controller or QUESTiX LAB) is decided upstream
// (joy_launcher, command_arbiter); the roller gate (roller_gate.hpp: motion permission, E-stop) is
// the node's. This class only turns the commands into the ESC output:
// - A command older than timeout_sec stops the roller (a publisher that dies cannot leave it
//   spinning).
// - After that timeout, after the gate closed (inhibited / inhibit()) and at start, a non-zero
//   command spins nothing until a 0 has been received: a button that was held, or a heartbeat
//   that kept coming, never restarts the roller by itself.
// - Values are clamped to [0, max_power]; a non-finite value is 0.
class RollerCommandLogic {
public:
  struct Result {
    bool set{false};         // set the ESC to `speed`
    double speed{0.0};       // [0, max_power]
    bool timed_out{false};   // the timeout stopped it (log once)
    bool needs_zero{false};  // a non-zero command was ignored until a 0 arrives
  };

  void configure(double timeout_sec, double max_power) {
    // A command must always expire: a non-positive timeout falls back to 1 s.
    timeout_sec_ = std::isfinite(timeout_sec) && timeout_sec > 0.0 ? timeout_sec : 1.0;
    max_power_ = std::isfinite(max_power) ? std::clamp(max_power, 0.0, 1.0) : 0.0;
  }

  // One command. inhibited: the gate is closed (no motion permission, E-stop not released).
  Result onCommand(double power, double now_sec, bool inhibited) {
    command_at_sec_ = now_sec;
    const double level = std::isfinite(power) ? std::clamp(power, 0.0, max_power_) : 0.0;
    if (inhibited) {
      return inhibit();
    }
    if (level <= 0.0) {
      require_zero_ = false;
      return setSpeed(0.0);
    }
    if (require_zero_) {
      Result result;
      result.needs_zero = true;
      return result;
    }
    return setSpeed(level);
  }

  // Periodic check: a spinning roller whose commands stopped is stopped.
  Result onTick(double now_sec) {
    Result result;
    if (speed_ > 0.0 && now_sec - command_at_sec_ > timeout_sec_) {
      result = setSpeed(0.0);
      result.timed_out = true;
      require_zero_ = true;
    }
    return result;
  }

  // The gate closed: stop, and spin again only after a 0.
  Result inhibit() {
    require_zero_ = true;
    return setSpeed(0.0);
  }

  double speed() const { return speed_; }
  bool requiresZero() const { return require_zero_; }
  double maxPower() const { return max_power_; }
  double timeoutSec() const { return timeout_sec_; }

private:
  Result setSpeed(double speed) {
    Result result;
    if (speed != speed_) {
      speed_ = speed;
      result.set = true;
      result.speed = speed;
    }
    return result;
  }

  double timeout_sec_{1.0};
  double max_power_{1.0};
  double speed_{0.0};
  bool require_zero_{true};  // at start: a command already non-zero needs a 0 first
  double command_at_sec_{-std::numeric_limits<double>::infinity()};
};

// /roller/status payload (std_msgs/String JSON): the mechanism's state only (who may command it
// is command_arbiter's /command_arbiter/status). Every value is a number, a bool or one of the
// fixed source names, so nothing needs escaping.
struct RollerStatus {
  double command{0.0};
  const char* source{"idle"};  // "joy" / "lab" while spinning for that source, else "idle"
  bool estop{false};
  // The motion permission (L2) for the launcher. Not an E-stop.
  bool permission{true};
  double max_power{0.0};
  bool pwm_fault{false};
  int applied_pulse_us{-1};
  std::string pwm_backend{"none"};
  std::string pwm_output_state{"UNKNOWN"};
  int pwm_error{0};
};

inline const char* rollerSourceName(const std::string& source) {
  if (source == "joy") {
    return "joy";
  }
  return source == "lab" ? "lab" : "other";
}

inline std::string rollerStatusJson(const RollerStatus& status) {
  const auto finite = [](double value) { return std::isfinite(value) ? value : 0.0; };
  char buffer[512];
  std::snprintf(buffer, sizeof(buffer),
                "{\"command\": %.3f, \"source\": \"%s\", \"estop\": %s, \"permission\": %s, "
                "\"max_power\": %.3f, \"pwm_fault\": %s, \"applied_pulse_us\": %d, "
                "\"pwm_backend\": \"%s\", \"pwm_output_state\": \"%s\", \"pwm_error\": %d}",
                finite(status.command), status.source ? status.source : "idle",
                status.estop ? "true" : "false", status.permission ? "true" : "false",
                finite(status.max_power), status.pwm_fault ? "true" : "false",
                status.applied_pulse_us, status.pwm_backend.c_str(),
                status.pwm_output_state.c_str(), status.pwm_error);
  return std::string(buffer);
}

}  // namespace esc_motor_control_cpp
