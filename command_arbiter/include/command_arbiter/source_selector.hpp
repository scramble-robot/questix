// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef COMMAND_ARBITER__SOURCE_SELECTOR_HPP_
#define COMMAND_ARBITER__SOURCE_SELECTOR_HPP_

#include <limits>

namespace command_arbiter {

// Which input reaches an actuator: the controller's or a QUESTiX LAB run's (L3, input selection).
// One rule for the drive and the launcher (design/safety_permission_input_refactor.md, 4.3);
// ROS-free and clock-injected (now_sec, monotonic) so it is unit-tested once. It only chooses: the
// actuators stop on /emergency_stop and /motion_permission themselves.
//
// - The controller is the default; its commands pass while it is the source.
// - QUESTiX LAB takes over with a non-neutral command, but only while the teacher's lesson
//   permission is on, the lab is not locked out, and the controller is not busy: its last command
//   was not neutral and is fresh (joy_timeout_sec), or it was used within controller_quiet_sec.
// - The controller always wins: using it while the lab has the actuator, or while the lab asks
//   for it, hands the actuator to the controller at once and locks the lab out until its run ends.
// - A lab run ends with a neutral command (forwarded: it is the stop), with silence for
//   lab_timeout_sec, or when the permission goes; the last two publish a stop. The lock goes with
//   the run.
// Both inputs publish continuously while in use, so "silent" means that input stopped.
class SourceSelector {
public:
  enum class Source { kJoy, kLab };
  enum class Reason { kStart, kLabStarted, kController, kLabEnded, kLabIdle, kNotPermitted };
  enum class Refusal { kNone, kNotPermitted, kController, kLocked, kInvalid };

  struct Config {
    double controller_quiet_sec{0.0};  // the controller idle this long before the lab may take over
    double joy_timeout_sec{0.5};       // no controller command this long = no controller
    double lab_timeout_sec{0.3};       // the lab silent this long = its run ended
  };

  struct LabDecision {
    bool forward{false};  // publish this lab command
    bool stop{false};     // publish a stop instead (the lab had the actuator and lost it)
    Refusal refusal{Refusal::kNone};
  };

  void configure(const Config& config) { config_ = config; }
  const Config& config() const { return config_; }

  // A controller command (active: not neutral). Returns whether to publish it.
  bool onJoy(bool active, double now_sec) {
    if (active && (source_ == Source::kLab || labAsking(now_sec))) {
      if (!lab_locked_) {
        lab_locked_ = true;
        ++version_;
      }
    }
    joy_at_sec_ = now_sec;
    joy_active_ = active;
    if (active) {
      joy_active_at_sec_ = now_sec;
    }
    if (source_ == Source::kLab) {
      if (!active) {
        return false;  // the lab has it: the controller's neutral stream is not forwarded
      }
      switchTo(Source::kJoy, Reason::kController);
    }
    return true;
  }

  // A lab command. neutral: it ends the lab's run (zero velocity, roller 0, nothing new).
  // permitted: the teacher's lesson permission for this mechanism is fresh and on.
  LabDecision onLab(bool neutral, bool permitted, double now_sec) {
    LabDecision decision;
    lab_at_sec_ = now_sec;
    lab_neutral_ = neutral;
    ++lab_count_;
    if (source_ == Source::kLab) {
      if (!permitted) {
        switchTo(Source::kJoy, Reason::kNotPermitted);
        decision.stop = true;
        decision.refusal = Refusal::kNotPermitted;
      } else {
        decision.forward = true;  // a neutral command is the run's stop: it goes out
        if (neutral) {
          switchTo(Source::kJoy, Reason::kLabEnded);
        }
      }
    } else if (neutral) {
      setLocked(false);  // the run that was locked out has ended
    } else if (!permitted) {
      decision.refusal = Refusal::kNotPermitted;
    } else if (lab_locked_) {
      decision.refusal = Refusal::kLocked;
    } else if (joyBusy(now_sec)) {
      decision.refusal = Refusal::kController;
    } else {
      switchTo(Source::kLab, Reason::kLabStarted);
      decision.forward = true;
    }
    setRefusal(decision.refusal);
    return decision;
  }

  // Records that a lab command was refused for a reason of the caller's (an invalid value).
  void refuse(Refusal refusal) { setRefusal(refusal); }

  // Periodic check. Returns true when a stop must be published: the lab had the actuator and its
  // run ended by silence or by losing the permission.
  bool onTick(bool permitted, double now_sec) {
    const bool quiet = now_sec - lab_at_sec_ > config_.lab_timeout_sec;
    bool stop = false;
    if (source_ == Source::kLab && (quiet || !permitted)) {
      switchTo(Source::kJoy, quiet ? Reason::kLabIdle : Reason::kNotPermitted);
      stop = true;
    }
    if (lab_locked_ && quiet) {
      setLocked(false);  // that lab run is over
    }
    return stop;
  }

  // The controller is in use: its last command is not neutral and fresh, or it was used within
  // controller_quiet_sec.
  bool joyBusy(double now_sec) const {
    return (joy_active_ && now_sec - joy_at_sec_ <= config_.joy_timeout_sec) ||
           now_sec - joy_active_at_sec_ <= config_.controller_quiet_sec;
  }

  // The lab is asking for the actuator: its last command was not neutral and is fresh.
  bool labAsking(double now_sec) const {
    return !lab_neutral_ && now_sec - lab_at_sec_ <= config_.lab_timeout_sec;
  }

  Source source() const { return source_; }
  Reason reason() const { return reason_; }
  Refusal refusal() const { return refusal_; }
  bool labLocked() const { return lab_locked_; }
  unsigned labCount() const { return lab_count_; }
  // Bumped whenever source, reason, lock or refusal change (publish the status then).
  unsigned version() const { return version_; }

  static const char* sourceName(Source source) { return source == Source::kLab ? "lab" : "joy"; }

  static const char* reasonName(Reason reason) {
    switch (reason) {
      case Reason::kLabStarted:
        return "lab";
      case Reason::kController:
        return "controller";
      case Reason::kLabEnded:
        return "lab_ended";
      case Reason::kLabIdle:
        return "lab_idle";
      case Reason::kNotPermitted:
        return "not_permitted";
      case Reason::kStart:
      default:
        return "start";
    }
  }

  static const char* refusalName(Refusal refusal) {
    switch (refusal) {
      case Refusal::kNotPermitted:
        return "not_permitted";
      case Refusal::kController:
        return "controller";
      case Refusal::kLocked:
        return "locked";
      case Refusal::kInvalid:
        return "invalid";
      case Refusal::kNone:
      default:
        return "";
    }
  }

private:
  void switchTo(Source source, Reason reason) {
    source_ = source;
    reason_ = reason;
    ++version_;
  }

  void setLocked(bool locked) {
    if (lab_locked_ != locked) {
      lab_locked_ = locked;
      ++version_;
    }
  }

  void setRefusal(Refusal refusal) {
    if (refusal_ != refusal) {
      refusal_ = refusal;
      ++version_;
    }
  }

  static constexpr double kNever = -std::numeric_limits<double>::infinity();

  Config config_{};
  Source source_{Source::kJoy};
  Reason reason_{Reason::kStart};
  Refusal refusal_{Refusal::kNone};
  bool lab_locked_{false};
  unsigned version_{0};
  unsigned lab_count_{0};
  bool joy_active_{false};
  double joy_at_sec_{kNever};
  double joy_active_at_sec_{kNever};
  bool lab_neutral_{true};
  double lab_at_sec_{kNever};
};

}  // namespace command_arbiter

#endif  // COMMAND_ARBITER__SOURCE_SELECTOR_HPP_
