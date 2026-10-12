// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef COMMAND_ARBITER__LAUNCHER_FLOW_HPP_
#define COMMAND_ARBITER__LAUNCHER_FLOW_HPP_

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>

#include "command_arbiter/source_selector.hpp"

namespace command_arbiter {

// The events in one questix_msgs/LauncherCommand input stream (LauncherCommand.msg): fire_seq
// increases fire one disc, tilt_steps changes are steps, a tilt_deg that differs from the previous
// message's (NaN before) is a target. The first message, one after silence longer than
// timeout_sec, one whose fire_seq went backwards and one with an implausible step change only set
// the counters' baseline. Keep in step with motor_control_app/launcher_events.hpp, which reads
// /launcher_command the same way.
class InputEvents {
public:
  static constexpr int32_t kMaxStepsPerMessage = 4;

  struct Events {
    bool baseline{false};
    bool fire{false};
    int32_t tilt_steps{0};
    bool tilt_target{false};
    double tilt_deg{0.0};
  };

  void configure(double timeout_sec) {
    timeout_sec_ = std::isfinite(timeout_sec) && timeout_sec > 0.0 ? timeout_sec : 1.0;
  }

  Events onCommand(double tilt_deg, int32_t tilt_steps, uint32_t fire_seq, double now_sec) {
    Events events;
    const bool silent = !have_ || now_sec - at_sec_ > timeout_sec_;
    const int64_t steps = static_cast<int64_t>(tilt_steps) - tilt_steps_;
    if (silent) {
      last_tilt_deg_ = std::numeric_limits<double>::quiet_NaN();
    }
    if (silent || fire_seq < fire_seq_ || steps > kMaxStepsPerMessage ||
        steps < -kMaxStepsPerMessage) {
      events.baseline = true;
    } else {
      events.fire = fire_seq > fire_seq_;
      events.tilt_steps = static_cast<int32_t>(steps);
    }
    if (std::isfinite(tilt_deg) && (!std::isfinite(last_tilt_deg_) || tilt_deg != last_tilt_deg_)) {
      events.tilt_target = true;
      events.tilt_deg = tilt_deg;
    }
    have_ = true;
    at_sec_ = now_sec;
    fire_seq_ = fire_seq;
    tilt_steps_ = tilt_steps;
    last_tilt_deg_ = tilt_deg;
    return events;
  }

private:
  double timeout_sec_{1.0};
  bool have_{false};
  double at_sec_{0.0};
  uint32_t fire_seq_{0};
  int32_t tilt_steps_{0};
  double last_tilt_deg_{std::numeric_limits<double>::quiet_NaN()};
};

// The launcher's input selection in a lesson (design/safety_permission_input_refactor.md, 4.2):
// the controller (/launcher_command/joy) or a QUESTiX LAB run (/launcher_command/lab) ->
// /launcher_command. ROS-free and clock-injected (now_sec, monotonic) so every rule is unit-tested.
// - Who has the launcher is source_selector.hpp's rule. The controller is busy while its roller
//   button is held or it fired / stepped the tilt within controller_quiet_sec; a lab command is
//   neutral when the roller is 0 and it asks for nothing new (no shot, no new tilt target).
// - The output has its own counters: a forwarded shot or tilt step adds to them, so a source
//   switch never replays or loses an event at shot_component.
// - QUESTiX LAB's caps: roller power at most lab_max_power, tilt targets clamped to
//   [lab_tilt_min_deg, lab_tilt_max_deg] (shot_component clamps to the mechanism's own range too).
// - A lab run starts fresh: the command that hands the launcher to the lab carries roller 0 (the
//   ESC spins only after a 0, see esc_motor_control's roller_command_logic.hpp, and a lesson
//   without a controller stream would otherwise never send it) and no tilt target; the next
//   command carries the lab's power. A run's own tilt target is never carried into another run.
// - A lab shot needs the forwarded lab roller at min_fire_power or more for spin_up_sec without a
//   break, and fire_interval_sec since the last forwarded shot of any source; otherwise it is
//   refused (never queued) and the run goes on.
// It never looks at the E-stop or the motion permission: the launcher nodes stop on those.
class LauncherFlow {
public:
  enum class Precondition { kNone, kNotSpinning, kInterval };

  struct Config {
    SourceSelector::Config selector{1.0, 0.5, 1.0};  // controller quiet, joy timeout, lab timeout
    double input_timeout_sec{1.0};                   // an input silent this long is rebased
    double lab_max_power{0.8};
    double lab_tilt_min_deg{0.0};
    double lab_tilt_max_deg{120.0};
    double min_fire_power{0.2};
    double spin_up_sec{1.0};
    double fire_interval_sec{2.0};
  };

  struct Command {
    double roller_power{0.0};
    double tilt_deg{std::numeric_limits<double>::quiet_NaN()};
    int32_t tilt_steps{0};
    uint32_t fire_seq{0};
  };

  struct Output {
    bool publish{false};
    Command command;
    SourceSelector::Source source{SourceSelector::Source::kJoy};
  };

  void configure(const Config& config) {
    config_ = config;
    selector_.configure(config.selector);
    joy_.configure(config.input_timeout_sec);
    lab_.configure(config.input_timeout_sec);
  }
  const Config& config() const { return config_; }

  Output onJoy(const Command& in, double now_sec) {
    const auto events = joy_.onCommand(in.tilt_deg, in.tilt_steps, in.fire_seq, now_sec);
    const double roller =
        std::isfinite(in.roller_power) ? std::clamp(in.roller_power, 0.0, 1.0) : 0.0;
    const bool active = roller > 0.0 || events.fire || events.tilt_steps != 0 || events.tilt_target;
    if (!selector_.onJoy(active, now_sec)) {
      return Output{};  // the lab has the launcher and the controller is idle
    }
    out_.roller_power = roller;
    out_.tilt_deg = std::isfinite(in.tilt_deg) ? in.tilt_deg : kNaN;
    out_.tilt_steps += events.tilt_steps;
    if (events.fire) {
      fire(now_sec);
    }
    spin_since_sec_ = kNaN;
    setPrecondition(Precondition::kNone);
    return emit(SourceSelector::Source::kJoy);
  }

  // permitted: the teacher's lesson permission for the launcher (/lab_permission) is fresh and on.
  Output onLab(const Command& in, bool permitted, double now_sec) {
    if (!std::isfinite(in.roller_power) || std::isinf(in.tilt_deg)) {
      // A broken command is never forwarded: it ends a run the lab has, with a stop.
      Output output;
      if (selector_.source() == SourceSelector::Source::kLab) {
        selector_.onLab(true, permitted, now_sec);
        output = stop();
      }
      selector_.refuse(SourceSelector::Refusal::kInvalid);
      return output;
    }
    const auto events = lab_.onCommand(in.tilt_deg, in.tilt_steps, in.fire_seq, now_sec);
    const double roller = std::clamp(in.roller_power, 0.0, std::max(0.0, config_.lab_max_power));
    const bool neutral = roller <= 0.0 && !events.fire && !events.tilt_target;
    const bool was_lab = selector_.source() == SourceSelector::Source::kLab;
    const auto decision = selector_.onLab(neutral, permitted, now_sec);
    if (decision.stop) {
      return stop();
    }
    if (!decision.forward) {
      return Output{};
    }
    const bool starting = !was_lab && selector_.source() == SourceSelector::Source::kLab;
    if (starting) {
      out_.tilt_deg = kNaN;  // only this run's own targets
    }
    out_.roller_power = starting ? 0.0 : roller;
    if (out_.roller_power >= config_.min_fire_power) {
      if (std::isnan(spin_since_sec_)) {
        spin_since_sec_ = now_sec;
      }
    } else {
      spin_since_sec_ = kNaN;
    }
    if (events.tilt_target) {
      out_.tilt_deg = std::clamp(events.tilt_deg, config_.lab_tilt_min_deg,
                                 std::max(config_.lab_tilt_min_deg, config_.lab_tilt_max_deg));
    }
    if (events.fire) {
      if (spinReadyInSec(now_sec) != 0.0) {
        setPrecondition(Precondition::kNotSpinning);
      } else if (nextFireInSec(now_sec) > 0.0) {
        setPrecondition(Precondition::kInterval);
      } else {
        setPrecondition(Precondition::kNone);
        fire(now_sec);
      }
    }
    Output output = emit(SourceSelector::Source::kLab);
    if (selector_.source() != SourceSelector::Source::kLab) {
      spin_since_sec_ = kNaN;  // this was the run's own stop
      out_.tilt_deg = kNaN;
    }
    return output;
  }

  // Periodic check: a lab run that went silent or lost the permission is stopped.
  Output onTick(bool permitted, double now_sec) {
    if (selector_.onTick(permitted, now_sec)) {
      return stop();
    }
    return Output{};
  }

  const SourceSelector& selector() const { return selector_; }
  Precondition precondition() const { return precondition_; }

  // Why the last lab command was (partly) refused: the selector's reason, else a shot's.
  const char* labRefusal() const {
    if (selector_.refusal() != SourceSelector::Refusal::kNone) {
      return SourceSelector::refusalName(selector_.refusal());
    }
    switch (precondition_) {
      case Precondition::kNotSpinning:
        return "not_spinning";
      case Precondition::kInterval:
        return "interval";
      case Precondition::kNone:
      default:
        return "";
    }
  }

  // Seconds until a lab shot is allowed by the interval (0 = now).
  double nextFireInSec(double now_sec) const {
    const double remaining = config_.fire_interval_sec - (now_sec - last_fire_sec_);
    return std::isfinite(remaining) && remaining > 0.0 ? remaining : 0.0;
  }

  // Seconds until the lab's roller has spun long enough (0 = ready), NaN while it is not spinning
  // at min_fire_power for the lab.
  double spinReadyInSec(double now_sec) const {
    if (selector_.source() != SourceSelector::Source::kLab || std::isnan(spin_since_sec_)) {
      return kNaN;
    }
    return std::max(0.0, config_.spin_up_sec - (now_sec - spin_since_sec_));
  }

  // Bumped whenever the status changes (the selector's, a shot, or a refused shot).
  unsigned version() const { return selector_.version() + own_version_; }

private:
  static constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

  Output emit(SourceSelector::Source source) const {
    Output output;
    output.publish = true;
    output.command = out_;
    output.source = source;
    return output;
  }

  // The lab's run ended without its own stop: the roller goes to 0, nothing else moves.
  Output stop() {
    out_.roller_power = 0.0;
    out_.tilt_deg = kNaN;  // the run is over: its target is not carried into the next one
    spin_since_sec_ = kNaN;
    return emit(SourceSelector::Source::kLab);
  }

  // A forwarded shot: the output's counter, and the interval starts (the status changes too).
  void fire(double now_sec) {
    ++out_.fire_seq;
    last_fire_sec_ = now_sec;
    ++own_version_;
  }

  void setPrecondition(Precondition precondition) {
    if (precondition_ != precondition) {
      precondition_ = precondition;
      ++own_version_;
    }
  }

  Config config_{};
  SourceSelector selector_;
  InputEvents joy_;
  InputEvents lab_;
  Command out_{};
  double last_fire_sec_{-std::numeric_limits<double>::infinity()};
  double spin_since_sec_{kNaN};
  Precondition precondition_{Precondition::kNone};
  unsigned own_version_{0};
};

}  // namespace command_arbiter

#endif  // COMMAND_ARBITER__LAUNCHER_FLOW_HPP_
