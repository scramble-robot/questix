// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#pragma once
#include <algorithm>
#include <chrono>
#include <string>
#include <thread>
#include <utility>

#include "questix_pwm_guard/client.hpp"
namespace esc_motor_control_cpp {
// Included after PwmBackend definition. The owner serializes access with the component mutex.
class Rp1HardwareBackend : public PwmBackend {
public:
  explicit Rp1HardwareBackend(std::string socket) : socket_(std::move(socket)) {}
  ~Rp1HardwareBackend() override { cleanup(); }
  bool initialize(int pin) override {
    if (pin != 13 || !client_.connect(socket_)) {
      error_ = -ENODEV;
      return false;
    }
    auto r = client_.call("ARM");
    if (!accept(r) || r.state != "ARMING" || r.applied != 1000 || r.session == 0) {
      cleanup();
      return false;
    }
    session_ = r.session;
    ready_ = true;
    return true;
  }
  bool complete_arm() override {
    if (!ready_ || terminal_) return fail(EPERM);
    auto r = client_.call("COMPLETE", session_, ++seq_);
    return accept(r) && r.state == "ACTIVE";
  }
  bool set_servo_pulse(int pin, int us) override {
    if (pin != 13 || !ready_ || (terminal_ && us != 0)) return fail(EPERM);
    if (us != 0 && (us < 500 || us > 2000)) return fail(EINVAL);
    auto r = client_.call("COMMAND", session_, ++seq_, us);
    bool ok = accept(r);
    if (us == 0) terminal_ = true;
    return ok;
  }
  bool stop_signal(int pin) override {
    terminal_ = true;
    if (pin != 13 || !ready_) return fail(ENODEV);
    return accept(client_.call("STOP", session_, ++seq_));
  }
  bool graceful_shutdown() override {
    const auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(800);
    if (!ready_) return false;
    if (terminal_) return accept(client_.call_until("STOP", session_, ++seq_, 0, end));
    terminal_ = true;
    auto r = client_.call_until("SHUTDOWN", session_, ++seq_, 0, end);
    if (!accept(r)) return false;
    while (std::chrono::steady_clock::now() < end) {
      r = client_.call_until("STATUS", 0, 0, 0, end);
      if (!accept(r)) return false;
      if (r.session != session_) return fail(ESTALE);
      if (r.state == "TERMINAL_LOW" && r.applied == 0) return true;
      if (r.state != "DRAINING") return fail(EIO);
      std::this_thread::sleep_until(
          std::min(end, std::chrono::steady_clock::now() + std::chrono::milliseconds(10)));
    }
    return fail(ETIMEDOUT);
  }
  bool terminal() const override { return terminal_; }
  std::string output_state() const override { return state_; }
  int applied_hint() const override { return applied_; }
  int last_error() const override { return error_; }
  void cleanup() override {
    if (ready_ && !terminal_) stop_signal(13);
    client_.close();
    ready_ = false;
    terminal_ = true;
  }
  std::string name() const override { return "rp1_hw"; }

private:
  bool fail(int e) {
    error_ = -e;
    return false;
  }
  bool accept(const questix_pwm_guard::Reply& r) {
    if (ready_ && r.ok && r.session != session_) {
      client_.close();
      terminal_ = true;
      state_ = "UNKNOWN";
      applied_ = -1;
      return fail(ESTALE);
    }
    state_ = r.state;
    applied_ = r.applied;
    error_ = r.error;
    if (!r.ok || r.state == "FAULT_LOW" || r.state == "FAULT_UNKNOWN") {
      terminal_ = true;
      if (!error_) error_ = -EIO;
      return false;
    }
    return true;
  }
  std::string socket_;
  questix_pwm_guard::Client client_;
  uint64_t session_{0};
  uint64_t seq_{0};
  int error_{0};
  int applied_{-1};
  std::string state_{"UNKNOWN"};
  bool ready_{false};
  bool terminal_{false};
};
}  // namespace esc_motor_control_cpp
