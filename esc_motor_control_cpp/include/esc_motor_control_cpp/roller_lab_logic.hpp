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

// Who drives the roller: the controller's full-speed button or a QUESTiX LAB experiment
// (/roller/lab, std_msgs/Float32 power fraction 0..1). ROS-free and clock-injected (now_sec,
// monotonic) so every rule is unit-tested. The controller always wins:
// - A lab value is applied only while the lab input is accepted, the E-stop is released and the
//   controller is not using the roller (its button is not held and was not pressed within
//   joy_quiet_sec). Values are clamped to [0, max_speed].
// - Pressing the controller button while the lab spins (or is asking to spin) hands the roller
//   to the controller at once and locks the lab out until it sends 0 (its run ended) or goes
//   quiet for timeout_sec. The same lock is set when the E-stop engages while the lab is asking
//   to spin, so a heartbeat that keeps coming cannot restart the roller after the release.
// - A lab command older than timeout_sec stops the roller (the bridge sends heartbeats at
//   10 Hz or more while the roller should spin).
// The node owns the actual ESC output; this class only says what to do.
class RollerLabLogic {
public:
  enum class Refusal { kNone, kNotAccepted, kLocked, kEmergencyStop, kController };

  struct Config {
    bool accept{false};
    double max_speed{0.8};      // lab power is clamped to [0, max_speed]
    double joy_quiet_sec{1.0};  // the controller button must be idle this long
    double timeout_sec{1.0};    // lab commands older than this stop the roller
  };

  // What the node must do after a lab message.
  struct LabDecision {
    bool apply{false};    // set the ESC to `command`
    double command{0.0};  // [0, max_speed]
    Refusal refusal{Refusal::kNone};
  };

  void configure(const Config& config) {
    config_ = config;
    config_.max_speed = sanitize(config.max_speed, 0.0, 1.0, 0.0);
    config_.joy_quiet_sec = sanitize(config.joy_quiet_sec, 0.0, 60.0, 1.0);
    // A lab command must always expire: a non-positive timeout falls back to 1 s.
    config_.timeout_sec =
        (std::isfinite(config.timeout_sec) && config.timeout_sec > 0.0) ? config.timeout_sec : 1.0;
  }

  // A lab message. joy_active: the controller's full-speed latch is on (the roller is the
  // controller's right now). estop: the E-stop is engaged.
  LabDecision onLab(double value, double now_sec, bool joy_active, bool estop) {
    LabDecision decision;
    const double requested = clampLab(value);
    lab_at_sec_ = now_sec;
    lab_requested_ = requested;

    if (requested <= 0.0) {
      // 0 ends a lab run: it re-arms a locked lab and stops a lab-driven roller.
      lab_locked_ = false;
      if (lab_active_) {
        lab_active_ = false;
        decision.apply = true;
        decision.command = 0.0;
      }
      return decision;
    }
    if (!config_.accept) {
      decision.refusal = Refusal::kNotAccepted;
      return decision;
    }
    if (lab_locked_) {
      decision.refusal = Refusal::kLocked;
      return decision;
    }
    if (estop) {
      lab_locked_ = true;
      lab_active_ = false;
      decision.refusal = Refusal::kEmergencyStop;
      return decision;
    }
    if (joy_active || now_sec - joy_at_sec_ <= config_.joy_quiet_sec) {
      decision.refusal = Refusal::kController;
      return decision;
    }
    lab_active_ = true;
    decision.apply = true;
    decision.command = requested;
    return decision;
  }

  // A controller message; pressed is the raw full-speed button. Returns true when the lab was
  // driving the roller and the node must stop it before handing over to the controller.
  bool onJoyButton(bool pressed, double now_sec) {
    if (!pressed) {
      return false;
    }
    joy_at_sec_ = now_sec;
    const bool preempted = lab_active_;
    if (lab_active_ || labAsking(now_sec)) {
      lab_locked_ = true;
    }
    lab_active_ = false;
    return preempted;
  }

  // The E-stop state changed. Returns true when a lab-driven roller must stop (the node stops
  // the ESC on the E-stop edge anyway; this keeps the lab from resuming after the release).
  bool onEmergencyStop(bool active, double now_sec) {
    if (!active) {
      return false;
    }
    const bool stopped = lab_active_;
    if (lab_active_ || labAsking(now_sec)) {
      lab_locked_ = true;
    }
    lab_active_ = false;
    return stopped;
  }

  // Periodic check. Returns true when a lab-driven roller timed out and must stop.
  bool onTick(double now_sec) {
    const bool quiet = now_sec - lab_at_sec_ > config_.timeout_sec;
    if (lab_locked_ && quiet) {
      lab_locked_ = false;  // that lab run is over
    }
    if (lab_active_ && quiet) {
      lab_active_ = false;
      return true;
    }
    return false;
  }

  bool labActive() const { return lab_active_; }
  bool labLocked() const { return lab_locked_; }
  const Config& config() const { return config_; }

  // "joy" while the controller latch runs the roller, "lab" while the lab does, else "idle".
  const char* sourceName(bool joy_active) const {
    if (joy_active) {
      return "joy";
    }
    return lab_active_ ? "lab" : "idle";
  }

  static const char* refusalName(Refusal refusal) {
    switch (refusal) {
      case Refusal::kNotAccepted:
        return "not_accepted";
      case Refusal::kLocked:
        return "controller_lock";
      case Refusal::kEmergencyStop:
        return "emergency_stop";
      case Refusal::kController:
        return "controller";
      case Refusal::kNone:
      default:
        return "none";
    }
  }

private:
  static double sanitize(double value, double lo, double hi, double fallback) {
    return std::isfinite(value) ? std::clamp(value, lo, hi) : fallback;
  }

  double clampLab(double value) const {
    return std::isfinite(value) ? std::clamp(value, 0.0, config_.max_speed) : 0.0;
  }

  // The lab sent a non-zero value that has not expired yet.
  bool labAsking(double now_sec) const {
    return lab_requested_ > 0.0 && now_sec - lab_at_sec_ <= config_.timeout_sec;
  }

  Config config_{};
  bool lab_active_{false};
  bool lab_locked_{false};
  double lab_requested_{0.0};
  double lab_at_sec_{-std::numeric_limits<double>::infinity()};
  double joy_at_sec_{-std::numeric_limits<double>::infinity()};
};

// /roller/status payload (std_msgs/String JSON). Every value is a number, a bool or one of the
// fixed source names, so nothing needs escaping.
struct RollerStatus {
  double command{0.0};
  const char* source{"idle"};
  bool lab_accepted{false};
  bool lab_locked{false};
  bool estop{false};
  double lab_max_speed{0.0};
};

inline std::string rollerStatusJson(const RollerStatus& status) {
  const auto finite = [](double value) { return std::isfinite(value) ? value : 0.0; };
  char buffer[256];
  std::snprintf(buffer, sizeof(buffer),
                "{\"command\": %.3f, \"source\": \"%s\", \"lab_accepted\": %s, "
                "\"lab_locked\": %s, \"estop\": %s, \"lab_max_speed\": %.3f}",
                finite(status.command), status.source ? status.source : "idle",
                status.lab_accepted ? "true" : "false", status.lab_locked ? "true" : "false",
                status.estop ? "true" : "false", finite(status.lab_max_speed));
  return std::string(buffer);
}

}  // namespace esc_motor_control_cpp
