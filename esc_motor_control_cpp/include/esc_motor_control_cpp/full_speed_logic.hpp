// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#pragma once

namespace esc_motor_control_cpp {

// フルスピードボタンのラッチ状態機械（ROS 非依存・時刻注入）
class FullSpeedLogic {
public:
  struct Result {
    bool start_full_speed{false};  // set_motor_speed(full_speed_value_) を実行
    bool stop{false};              // set_motor_speed(0.0) を実行
    bool timed_out{false};         // タイムアウト発火（WARN ログ用・1回のみ）
    bool ignored_press{false};     // 押し直し要求により押下を無視した
  };

  void configure(double timeout_sec) { timeout_sec_ = timeout_sec; }

  Result onButton(bool pressed, double now_sec) {
    Result result;

    if (pressed) {
      if (active_) {
        // Keep-alive: refresh the timeout window while held.
        last_command_sec_ = now_sec;
      } else if (require_release_) {
        // Latch was cleared by a safety timeout: ignore the held press until a
        // release is observed. No motion resumes without a fresh operator press.
        result.ignored_press = true;
      } else {
        active_ = true;
        last_command_sec_ = now_sec;
        result.start_full_speed = true;
      }
    } else {
      // A release re-arms the latch for the next press.
      require_release_ = false;
      if (active_) {
        active_ = false;
        result.stop = true;
      }
    }

    return result;
  }

  Result onTimerCheck(double now_sec) {
    Result result;

    // Timeout disabled, or nothing running: nothing to evaluate.
    // The '!active_' guard also prevents multiple fires after a single timeout.
    if (timeout_sec_ <= 0.0 || !active_) {
      return result;
    }

    // Strict '>' only: elapsed == timeout_sec_ does not fire.
    if (now_sec - last_command_sec_ > timeout_sec_) {
      active_ = false;
      require_release_ = true;

      result.stop = true;
      result.timed_out = true;
    }

    return result;
  }

  bool isActive() const { return active_; }

private:
  double timeout_sec_{0.0};
  bool active_{false};
  bool require_release_{false};  // タイムアウト後の押し直し要求
  double last_command_sec_{0.0};
};

}  // namespace esc_motor_control_cpp
