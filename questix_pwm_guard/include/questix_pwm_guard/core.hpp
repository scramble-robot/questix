// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#pragma once
#include <cerrno>
#include <cstdint>
#include <functional>
#include <stdexcept>
#include <string>
namespace questix_pwm_guard {
enum class State { LowIdle, Arming, Active, Draining, TerminalLow, FaultLow, FaultUnknown };
inline const char* state_name(State s) {
  switch (s) {
    case State::LowIdle:
      return "LOW_IDLE";
    case State::Arming:
      return "ARMING";
    case State::Active:
      return "ACTIVE";
    case State::Draining:
      return "DRAINING";
    case State::TerminalLow:
      return "TERMINAL_LOW";
    case State::FaultLow:
      return "FAULT_LOW";
    case State::FaultUnknown:
      return "FAULT_UNKNOWN";
  }
  return "FAULT_UNKNOWN";
}
struct Config {
  int neutral_us{1000};
  int max_us{2000};
  int lease_ms{1000};
  int arm_ms{3000};
  int drain_ms{500};
  void validate() const {
    if (neutral_us != 1000 || max_us < neutral_us || max_us > 2500 || lease_ms < 100 ||
        lease_ms > 1000 || arm_ms < 2000 || arm_ms > 5000 || drain_ms < 0 || drain_ms > 500)
      throw std::invalid_argument("invalid safety config");
  }
};
class Output {
public:
  virtual ~Output() = default;
  virtual bool write_pulse(int us) = 0;
  virtual int error() const = 0;
  virtual bool check() { return true; }
};
// All calls are serialized by the daemon event loop. Times are injected monotonic milliseconds.
class Core {
public:
  explicit Core(Output& out, Config config = {}) : out_(out), config_(config) {
    config_.validate();
  }
  bool start() { return low(false); }
  int fault_error() const { return fault_error_; }
  bool authorize(int64_t now) {
    tick(now);
    if (state_ == State::Arming || state_ == State::Active || state_ == State::Draining ||
        state_ == State::FaultUnknown)
      return reject(EBUSY);
    if (!low(false)) return false;
    state_ = State::LowIdle;
    fault_error_ = 0;
    ticket_until_ = now + 30000;
    return true;
  }
  bool arm(uint64_t generation, int64_t now) {
    tick(now);
    if (state_ != State::LowIdle || ticket_until_ == 0 || now >= ticket_until_ || generation == 0)
      return reject(EPERM);
    ticket_until_ = 0;
    session_ = generation;
    seq_ = 0;
    if (!write(config_.neutral_us)) return false;
    state_ = State::Arming;
    deadline_ = now + config_.arm_ms;
    return true;
  }
  bool complete(uint64_t session, uint64_t seq, int64_t now) {
    tick(now);
    if (!valid(session, seq) || state_ != State::Arming) return reject(EPERM);
    seq_ = seq;
    state_ = State::Active;
    deadline_ = now + config_.lease_ms;
    return true;
  }
  bool command(uint64_t session, uint64_t seq, int us, int64_t now) {
    tick(now);
    if (!valid(session, seq) || (state_ != State::Active && state_ != State::Arming))
      return reject(EPERM);
    if (us != 0 && (us < 500 || us > config_.max_us)) return fail_command(EINVAL);
    if (state_ == State::Arming && us != config_.neutral_us) return reject(EPERM);
    seq_ = seq;
    if (us == 0) return low(true);
    if (!write(us)) return false;
    if (state_ == State::Active) deadline_ = now + config_.lease_ms;
    return true;
  }
  bool shutdown(uint64_t session, uint64_t seq, int64_t now) {
    tick(now);
    if (session != session_ || session == 0) return reject(EPERM);
    if (state_ == State::Draining || state_ == State::TerminalLow) return true;
    if (!valid(session, seq) || (state_ != State::Active && state_ != State::Arming))
      return reject(EPERM);
    seq_ = seq;
    ticket_until_ = 0;
    if (!write(config_.neutral_us)) return false;
    state_ = State::Draining;
    deadline_ = now + config_.drain_ms;
    return true;
  }
  bool stop(uint64_t session, uint64_t seq, int64_t now) {
    tick(now);
    if (!valid(session, seq)) return reject(EPERM);
    seq_ = seq;
    const bool latched = fault_error_ != 0;
    const bool ok = low(true);
    if (ok && latched) state_ = State::FaultLow;
    return ok;
  }
  void disconnected(int64_t now) {
    tick(now);
    if (state_ == State::Draining) return;  // Accepted normal shutdown has a fixed deadline.
    if (state_ == State::Arming || state_ == State::Active) fault(ECONNRESET);
  }
  bool emergency_low() {
    ticket_until_ = 0;
    const bool latched = fault_error_ != 0;
    const bool ok = low(true);
    if (ok && latched) state_ = State::FaultLow;
    return ok;
  }
  void tick(int64_t now) {
    if (state_ != State::FaultUnknown && !out_.check()) {
      fault(out_.error());
      return;
    }
    if (ticket_until_ && now >= ticket_until_) ticket_until_ = 0;
    if ((state_ == State::Arming || state_ == State::Active) && now >= deadline_)
      fault(ETIMEDOUT);
    else if (state_ == State::Draining && now >= deadline_)
      low(true);
  }
  State state() const { return state_; }
  int applied() const { return applied_; }  // API accepted, never a physical measurement.
  int error() const { return error_; }
  uint64_t session() const { return session_; }
  int64_t deadline() const { return deadline_; }

private:
  bool valid(uint64_t s, uint64_t seq) const { return s && s == session_ && seq > seq_; }
  bool fail_command(int code) {
    fault(code);
    return false;
  }
  bool reject(int code) {
    error_ = -code;
    return false;
  }
  bool write(int us) {
    if (applied_ == us) {
      if (!out_.check()) {
        fault(out_.error());
        return false;
      }
      error_ = 0;
      return true;
    }
    if (out_.write_pulse(us)) {
      applied_ = us;
      error_ = 0;
      return true;
    }
    fault(out_.error());
    return false;
  }
  bool low(bool terminal) {
    ticket_until_ = 0;
    // Always issue a Low write, including recovery from an unknown output state.
    if (out_.write_pulse(0)) {
      applied_ = 0;
      state_ = terminal ? State::TerminalLow : State::LowIdle;
      error_ = 0;
      return true;
    }
    applied_ = -1;
    state_ = State::FaultUnknown;
    error_ = out_.error();
    if (!fault_error_) fault_error_ = error_;
    return false;
  }
  void fault(int code) {
    ticket_until_ = 0;
    error_ = code < 0 ? code : -code;
    if (!fault_error_) fault_error_ = error_;
    if (out_.write_pulse(0)) {
      applied_ = 0;
      state_ = State::FaultLow;
    } else {
      applied_ = -1;
      state_ = State::FaultUnknown;
    }
  }
  Output& out_;
  Config config_;
  State state_{State::LowIdle};
  int applied_{-1};
  int error_{0};
  int fault_error_{0};
  uint64_t session_{0};
  uint64_t seq_{0};
  int64_t deadline_{0};
  int64_t ticket_until_{0};
};
}  // namespace questix_pwm_guard
