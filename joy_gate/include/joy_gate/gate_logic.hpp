// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#pragma once

namespace joy_gate {

// /gpio/controllable 受信タイムアウト付きゲート状態機械（ROS 非依存・時刻注入）
class GateLogic {
public:
  struct Result {
    bool changed{false};       // controllable 状態が遷移
    bool publish_zero{false};  // uncontrollable への遷移: ゼロ joy を publish
    bool timed_out{false};     // タイムアウトによる強制遷移
    bool recovered{false};     // タイムアウト後の受信復帰
  };

  void configure(double timeout_sec) { timeout_sec_ = timeout_sec; }

  Result onControllableMsg(bool controllable, double now_sec) {
    Result result;

    if (timed_out_) {
      timed_out_ = false;
      result.recovered = true;
    }

    last_msg_sec_ = now_sec;

    const bool prev_controllable = is_controllable_;
    is_controllable_ = controllable;

    result.changed = prev_controllable != is_controllable_;
    result.publish_zero = prev_controllable && !is_controllable_;

    return result;
  }

  Result onTimerCheck(double now_sec) {
    Result result;

    // Timeout disabled, or no stream to lose: nothing to evaluate.
    if (timeout_sec_ <= 0.0 || !is_controllable_) {
      return result;
    }

    // Strict '>' only: elapsed == timeout_sec_ does not fire.
    if (now_sec - last_msg_sec_ > timeout_sec_) {
      is_controllable_ = false;
      timed_out_ = true;

      result.changed = true;
      result.publish_zero = true;
      result.timed_out = true;
    }

    return result;
  }

  bool isControllable() const { return is_controllable_; }

private:
  double timeout_sec_{0.0};
  bool is_controllable_{false};
  bool timed_out_{false};
  double last_msg_sec_{0.0};
};

}  // namespace joy_gate
