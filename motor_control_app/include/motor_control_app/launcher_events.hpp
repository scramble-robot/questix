// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__LAUNCHER_EVENTS_HPP_
#define MOTOR_CONTROL_APP__LAUNCHER_EVENTS_HPP_

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <string>

namespace motor_control_app {

// The shots and tilt moves in one /launcher_command stream (questix_msgs/LauncherCommand), as
// shot_component reads it. ROS-free and clock-injected (monotonic seconds) so every rule is
// unit-tested. The events are counters and a target, so a lost or repeated message never loses or
// repeats one (questix_msgs/msg/LauncherCommand.msg):
// - fire_seq: an increase over the previous message fires one disc (one per message at most).
// - tilt_steps: the change is that many tilt steps (+ up, - down).
// - tilt_deg: a finite value that differs from the previous message's (NaN before) is a target.
// The first message, one after silence longer than timeout_sec, and one whose fire_seq went
// backwards (its publisher restarted) only set the counters' baseline: nothing that happened
// before them is replayed. A tilt target is the current wish, not a past event, so it counts there
// too. A step change larger than kMaxStepsPerMessage is treated like a restart.
//
// Keep in step with command_arbiter's launcher_flow.hpp, which reads its inputs the same way.
class LauncherEvents {
public:
  static constexpr int32_t kMaxStepsPerMessage = 4;

  struct Command {
    double tilt_deg{std::numeric_limits<double>::quiet_NaN()};
    int32_t tilt_steps{0};
    uint32_t fire_seq{0};
  };

  struct Events {
    bool baseline{false};  // the counters were (re)based: no shot, no steps from this message
    bool fire{false};
    int32_t tilt_steps{0};
    bool tilt_target{false};
    double tilt_deg{0.0};
  };

  void configure(double timeout_sec) {
    timeout_sec_ = std::isfinite(timeout_sec) && timeout_sec > 0.0 ? timeout_sec : 1.0;
  }

  Events onCommand(const Command& command, double now_sec) {
    Events events;
    const bool silent = !have_ || now_sec - at_sec_ > timeout_sec_;
    const int64_t steps = static_cast<int64_t>(command.tilt_steps) - tilt_steps_;
    if (silent) {
      last_tilt_deg_ = std::numeric_limits<double>::quiet_NaN();
    }
    if (silent || command.fire_seq < fire_seq_ || steps > kMaxStepsPerMessage ||
        steps < -kMaxStepsPerMessage) {
      events.baseline = true;
    } else {
      events.fire = command.fire_seq > fire_seq_;
      events.tilt_steps = static_cast<int32_t>(steps);
    }
    if (std::isfinite(command.tilt_deg) &&
        (!std::isfinite(last_tilt_deg_) || command.tilt_deg != last_tilt_deg_)) {
      events.tilt_target = true;
      events.tilt_deg = command.tilt_deg;
    }
    have_ = true;
    at_sec_ = now_sec;
    fire_seq_ = command.fire_seq;
    tilt_steps_ = command.tilt_steps;
    last_tilt_deg_ = command.tilt_deg;
    return events;
  }

  // The next message sets the baseline (the node restarted its input, e.g. on cleanup).
  void reset() { have_ = false; }

  double timeoutSec() const { return timeout_sec_; }

private:
  double timeout_sec_{1.0};
  bool have_{false};
  double at_sec_{0.0};
  uint32_t fire_seq_{0};
  int32_t tilt_steps_{0};
  double last_tilt_deg_{std::numeric_limits<double>::quiet_NaN()};
};

enum class FireSource { kNone, kJoy, kLab, kOther };

inline FireSource fireSourceOf(const std::string& source) {
  if (source == "joy") {
    return FireSource::kJoy;
  }
  return source == "lab" ? FireSource::kLab : FireSource::kOther;
}

inline const char* fireSourceJson(FireSource source) {
  switch (source) {
    case FireSource::kJoy:
      return "\"joy\"";
    case FireSource::kLab:
      return "\"lab\"";
    case FireSource::kOther:
      return "\"other\"";
    case FireSource::kNone:
    default:
      return "null";
  }
}

// Seconds until the next shot is allowed (0 = now). last_fire_sec is -inf before any shot.
inline double nextFireInSec(double now_sec, double last_fire_sec, double min_interval_sec) {
  const double remaining = min_interval_sec - (now_sec - last_fire_sec);
  return std::isfinite(remaining) && remaining > 0.0 ? remaining : 0.0;
}

// /shot/status payload (std_msgs/String JSON): the mechanism's state and limits only (who may
// command it is command_arbiter's /command_arbiter/status). Every value is a number, a bool or one
// of the fixed names above, so nothing needs escaping.
struct ShotStatus {
  double tilt_deg{0.0};
  bool shooting{false};
  long fired_count{0};
  FireSource last_fire_source{FireSource::kNone};
  bool estop{false};
  // The motion permission (L2) for the launcher. Separate from estop: losing it is not an
  // emergency stop.
  bool permission{false};
  bool active{false};
  double tilt_min_deg{0.0};
  double tilt_max_deg{0.0};
  double next_fire_in_sec{0.0};
};

inline std::string shotStatusJson(const ShotStatus& s) {
  const auto finite = [](double value) { return std::isfinite(value) ? value : 0.0; };
  const auto flag = [](bool value) { return value ? "true" : "false"; };
  char buffer[384];
  std::snprintf(buffer, sizeof(buffer),
                "{\"tilt_deg\": %.1f, \"shooting\": %s, \"fired_count\": %ld, "
                "\"last_fire_source\": %s, \"estop\": %s, \"permission\": %s, \"active\": %s, "
                "\"tilt_min_deg\": %.1f, \"tilt_max_deg\": %.1f, \"next_fire_in_sec\": %.2f}",
                finite(s.tilt_deg), flag(s.shooting), s.fired_count,
                fireSourceJson(s.last_fire_source), flag(s.estop), flag(s.permission),
                flag(s.active), finite(s.tilt_min_deg), finite(s.tilt_max_deg),
                finite(s.next_fire_in_sec));
  return std::string(buffer);
}

}  // namespace motor_control_app

#endif  // MOTOR_CONTROL_APP__LAUNCHER_EVENTS_HPP_
