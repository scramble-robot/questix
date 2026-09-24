// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#pragma once

#include <cmath>
#include <limits>
#include <optional>

namespace twist_arbiter {

// Which velocity command reaches the drive: the controller's or a QUESTiX LAB experiment's.
// ROS-free and clock-injected (now_sec, monotonic) so every rule is unit-tested.
//
// The switch follows what people do, so nobody has to relaunch anything between a lesson and
// driving by hand:
// - The controller is the default; its commands pass while it is the active source.
// - A lab experiment takes over when it starts sending, but only while the controller's stick
//   is neutral (or no controller command arrives): a page never overrides a hand on the stick.
// - Moving the stick during a lab run hands the robot back to the controller at once and locks
//   the lab out until its input has gone quiet (the run ended), so the same run cannot grab the
//   robot back. The status says why (Reason::kController) and the lab page stops its run.
// - When the lab input is quiet for lab_timeout_sec, the controller is active again.
// Both inputs publish continuously while in use (joy_controller at the joy rate, the lab bridge
// at 20 Hz with its own dead-man timeout), so "quiet" means that source stopped.
class ArbiterLogic {
public:
  enum class Source { kJoy, kLab };
  enum class Reason { kStart, kLabStarted, kController, kLabIdle };

  struct Command {
    double linear{0.0};   // [m/s]
    double angular{0.0};  // [rad/s]
  };

  struct Config {
    double neutral_linear{0.02};   // [m/s] a stick command below this is neutral
    double neutral_angular{0.05};  // [rad/s]
    double lab_timeout_sec{0.3};   // lab input quiet this long = its run ended
    double joy_timeout_sec{0.5};   // no controller command this long = no controller
  };

  void configure(const Config& config) { config_ = config; }

  // Command to publish for a controller message, or nullopt.
  std::optional<Command> onJoy(double linear, double angular, double now_sec) {
    const Command command{finiteOrZero(linear), finiteOrZero(angular)};
    joy_ = command;
    joy_at_sec_ = now_sec;
    if (source_ == Source::kLab) {
      if (isNeutral(command)) {
        return std::nullopt;
      }
      switchTo(Source::kJoy, Reason::kController);
      lab_locked_ = true;
    }
    return command;
  }

  // Command to publish for a lab message, or nullopt.
  std::optional<Command> onLab(double linear, double angular, double now_sec) {
    lab_at_sec_ = now_sec;
    if (lab_locked_) {
      return std::nullopt;
    }
    if (source_ == Source::kJoy) {
      if (!joyNeutral(now_sec)) {
        return std::nullopt;
      }
      switchTo(Source::kLab, Reason::kLabStarted);
    }
    return Command{finiteOrZero(linear), finiteOrZero(angular)};
  }

  // Hands the robot back to the controller once the lab input has gone quiet.
  void onTick(double now_sec) {
    const bool quiet = now_sec - lab_at_sec_ > config_.lab_timeout_sec;
    if (source_ == Source::kLab && quiet) {
      switchTo(Source::kJoy, Reason::kLabIdle);
    }
    if (lab_locked_ && quiet) {
      lab_locked_ = false;
      ++version_;
    }
  }

  // True while the stick is centred, or no controller command arrives at all.
  bool joyNeutral(double now_sec) const {
    return now_sec - joy_at_sec_ > config_.joy_timeout_sec || isNeutral(joy_);
  }

  Source source() const { return source_; }
  Reason reason() const { return reason_; }
  bool labLocked() const { return lab_locked_; }
  // Bumped whenever source, reason or lock change (the node publishes the status then).
  unsigned version() const { return version_; }

  static const char* sourceName(Source source) { return source == Source::kLab ? "lab" : "joy"; }

  static const char* reasonName(Reason reason) {
    switch (reason) {
      case Reason::kLabStarted:
        return "lab";
      case Reason::kController:
        return "controller";
      case Reason::kLabIdle:
        return "lab_idle";
      case Reason::kStart:
      default:
        return "start";
    }
  }

private:
  static double finiteOrZero(double value) { return std::isfinite(value) ? value : 0.0; }

  bool isNeutral(const Command& command) const {
    return std::abs(command.linear) < config_.neutral_linear &&
           std::abs(command.angular) < config_.neutral_angular;
  }

  void switchTo(Source source, Reason reason) {
    source_ = source;
    reason_ = reason;
    ++version_;
  }

  Config config_{};
  Source source_{Source::kJoy};
  Reason reason_{Reason::kStart};
  bool lab_locked_{false};
  unsigned version_{0};
  Command joy_{};
  double joy_at_sec_{-std::numeric_limits<double>::infinity()};
  double lab_at_sec_{-std::numeric_limits<double>::infinity()};
};

}  // namespace twist_arbiter
