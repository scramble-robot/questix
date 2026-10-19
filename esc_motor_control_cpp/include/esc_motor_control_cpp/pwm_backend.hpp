// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef ESC_MOTOR_CONTROL_CPP__PWM_BACKEND_HPP_
#define ESC_MOTOR_CONTROL_CPP__PWM_BACKEND_HPP_

#include <cstdio>
#include <memory>
#include <string>

// Conditional includes based on CMake detection
#ifdef HAVE_PIGPIO
extern "C" {
#include <pigpio.h>
}
#endif

#ifdef HAVE_LGPIO
extern "C" {
#include <lgpio.h>
}
#endif

namespace esc_motor_control_cpp {

/// Abstract PWM backend interface
class PwmBackend {
public:
  virtual ~PwmBackend() = default;

  /// Initialize the backend for the given GPIO pin
  /// @return true on success
  virtual bool initialize(int gpio_pin) = 0;

  /// Set servo pulse width in microseconds (0=off, 500-2500 valid range)
  virtual bool set_servo_pulse(int gpio_pin, int pulse_width_us) = 0;

  /// Stop pulses and drive the claimed output Low. Both operations are attempted.
  virtual bool stop_signal(int gpio_pin) = 0;

  /// Last backend API error (negative), or zero after success.
  virtual int last_error() const = 0;

  // Optional guarded lifecycle. Legacy backends keep their existing cleanup policy.
  virtual bool complete_arm() { return true; }
  virtual bool graceful_shutdown() { return false; }
  virtual bool terminal() const { return false; }
  virtual std::string output_state() const { return "LEGACY"; }
  virtual int applied_hint() const { return -1; }

  /// Release resources
  virtual void cleanup() = 0;

  /// Human-readable backend name
  virtual std::string name() const = 0;
};

}  // namespace esc_motor_control_cpp
#include "esc_motor_control_cpp/rp1_hardware_backend.hpp"
namespace esc_motor_control_cpp {

// ---------------------------------------------------------------------------
// pigpio backend
// ---------------------------------------------------------------------------
#ifdef HAVE_PIGPIO
class PigpioBackend : public PwmBackend {
public:
  PigpioBackend() = default;
  ~PigpioBackend() override { cleanup(); }

  bool initialize(int gpio_pin) override {
    gpio_pin_ = gpio_pin;
    int rc = gpioInitialise();
    last_error_ = rc < 0 ? rc : 0;
    if (rc < 0) {
      return false;
    }
    initialized_ = true;
    // Set the pin as output
    last_error_ = gpioSetMode(gpio_pin, PI_OUTPUT);
    return last_error_ == 0;
  }

  bool set_servo_pulse(int gpio_pin, int pulse_width_us) override {
    if (!initialized_) {
      last_error_ = -1;
      return false;
    }
    last_error_ = gpioServo(gpio_pin, pulse_width_us);
    return last_error_ == 0;
  }

  bool stop_signal(int gpio_pin) override {
    const bool stopped = set_servo_pulse(gpio_pin, 0);
    const int stop_error = last_error_;
    const int low_error = initialized_ ? gpioWrite(gpio_pin, 0) : -1;
    last_error_ = !stopped ? stop_error : low_error;
    if (!stopped) std::fprintf(stderr, "pigpio: servo stop failed (%d)\n", stop_error);
    if (low_error < 0) std::fprintf(stderr, "pigpio: Low write failed (%d)\n", low_error);
    return stopped && low_error == 0;
  }

  int last_error() const override { return last_error_; }

  void cleanup() override {
    if (initialized_) {
      stop_signal(gpio_pin_);
      gpioTerminate();
      initialized_ = false;
    }
  }

  std::string name() const override { return "pigpio"; }

private:
  bool initialized_{false};
  int gpio_pin_{-1};
  int last_error_{0};
};
#endif

// ---------------------------------------------------------------------------
// lgpio backend
// ---------------------------------------------------------------------------
#ifdef HAVE_LGPIO
class LgpioBackend : public PwmBackend {
public:
  explicit LgpioBackend(int chip_num = 0) : chip_num_(chip_num) {}
  ~LgpioBackend() override { cleanup(); }

  bool initialize(int gpio_pin) override {
    gpio_pin_ = gpio_pin;
    handle_ = lgGpiochipOpen(chip_num_);
    last_error_ = handle_ < 0 ? handle_ : 0;
    if (handle_ < 0) {
      return false;
    }
    // Claim the pin for output
    int rc = lgGpioClaimOutput(handle_, 0, gpio_pin, 0);
    if (rc < 0) {
      last_error_ = rc;
      lgGpiochipClose(handle_);
      handle_ = -1;
      return false;
    }
    initialized_ = true;
    return true;
  }

  bool set_servo_pulse(int gpio_pin, int pulse_width_us) override {
    if (!initialized_ || handle_ < 0) {
      last_error_ = -1;
      return false;
    }
    // lgTxServo(handle, gpio, pulseWidth, servoFrequency, offset, cycles)
    // pulseWidth: 0 (off) or 500-2500, frequency: 50Hz, offset: 0, cycles: 0 (infinite)
    int rc = lgTxServo(handle_, gpio_pin, pulse_width_us, 50, 0, 0);
    last_error_ = rc < 0 ? rc : 0;
    return rc >= 0;
  }

  bool stop_signal(int gpio_pin) override {
    const bool stopped = set_servo_pulse(gpio_pin, 0);
    const int stop_error = last_error_;
    const int low_error = initialized_ ? lgGpioWrite(handle_, gpio_pin, 0) : -1;
    last_error_ = !stopped ? stop_error : (low_error < 0 ? low_error : 0);
    // No ROS logger here: report each failure even during backend destruction.
    if (!stopped) std::fprintf(stderr, "lgpio: servo stop failed (%d)\n", stop_error);
    if (low_error < 0) std::fprintf(stderr, "lgpio: Low write failed (%d)\n", low_error);
    return stopped && low_error >= 0;
  }

  int last_error() const override { return last_error_; }

  void cleanup() override {
    if (initialized_ && handle_ >= 0) {
      stop_signal(gpio_pin_);
      const int rc = lgGpiochipClose(handle_);
      if (rc < 0) std::fprintf(stderr, "lgpio: chip close failed (%d)\n", rc);
      handle_ = -1;
      initialized_ = false;
    }
  }

  std::string name() const override { return "lgpio"; }

private:
  int chip_num_{0};
  int handle_{-1};
  int gpio_pin_{-1};
  int last_error_{0};
  bool initialized_{false};
};
#endif

// ---------------------------------------------------------------------------
// Simulation (no-op) backend – always available
// ---------------------------------------------------------------------------
class SimulationBackend : public PwmBackend {
public:
  bool initialize(int /*gpio_pin*/) override { return true; }
  bool set_servo_pulse(int /*gpio_pin*/, int /*pulse_width_us*/) override { return true; }
  // Simulation owns no output; stopping and cleanup have no physical side effects.
  bool stop_signal(int /*gpio_pin*/) override { return true; }
  int last_error() const override { return 0; }
  void cleanup() override {}
  std::string name() const override { return "simulation"; }
};

/// Factory: try to create the requested backend.
/// @param preferred  "auto", "pigpio", "lgpio", "rp1_hw", or "simulation"
/// @param chip_num   GPIO chip number (lgpio only, typically 0 for Pi4, 4 for Pi5)
/// @param out_name   filled with the name of the actually created backend
inline std::unique_ptr<PwmBackend> make_pwm_backend(
    const std::string& preferred, int chip_num, std::string& out_name,
    const std::string& rp1_socket = "/run/questix_pwm_guard/control.sock") {
  if (preferred == "rp1_hw") {
    out_name = "rp1_hw";
    return std::make_unique<Rp1HardwareBackend>(rp1_socket);
  }
  auto try_pigpio = [&]() -> std::unique_ptr<PwmBackend> {
#ifdef HAVE_PIGPIO
    return std::make_unique<PigpioBackend>();
#else
    (void)chip_num;
    return nullptr;
#endif
  };

  auto try_lgpio = [&]() -> std::unique_ptr<PwmBackend> {
#ifdef HAVE_LGPIO
    return std::make_unique<LgpioBackend>(chip_num);
#else
    (void)chip_num;
    return nullptr;
#endif
  };

  if (preferred == "pigpio") {
    auto b = try_pigpio();
    if (b) {
      out_name = b->name();
      return b;
    }
  } else if (preferred == "lgpio") {
    auto b = try_lgpio();
    if (b) {
      out_name = b->name();
      return b;
    }
  } else if (preferred == "auto") {
    // Legacy servo implementations; neither selects RP1 kernel hardware PWM.
    if (auto b = try_pigpio()) {
      out_name = b->name();
      return b;
    }
    if (auto b = try_lgpio()) {
      out_name = b->name();
      return b;
    }
  }

  // Fallback: simulation
  out_name = "simulation";
  return std::make_unique<SimulationBackend>();
}

}  // namespace esc_motor_control_cpp

#endif  // ESC_MOTOR_CONTROL_CPP__PWM_BACKEND_HPP_
