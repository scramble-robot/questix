#ifndef ESC_MOTOR_CONTROL_CPP__PWM_BACKEND_HPP_
#define ESC_MOTOR_CONTROL_CPP__PWM_BACKEND_HPP_

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

  /// Release resources
  virtual void cleanup() = 0;

  /// Human-readable backend name
  virtual std::string name() const = 0;
};

// ---------------------------------------------------------------------------
// pigpio backend
// ---------------------------------------------------------------------------
#ifdef HAVE_PIGPIO
class PigpioBackend : public PwmBackend {
public:
  PigpioBackend() = default;
  ~PigpioBackend() override { cleanup(); }

  bool initialize(int gpio_pin) override {
    int rc = gpioInitialise();
    if (rc < 0) {
      return false;
    }
    initialized_ = true;
    // Set the pin as output
    gpioSetMode(gpio_pin, PI_OUTPUT);
    return true;
  }

  bool set_servo_pulse(int gpio_pin, int pulse_width_us) override {
    if (!initialized_) return false;
    int rc = gpioServo(gpio_pin, pulse_width_us);
    return rc == 0;
  }

  void cleanup() override {
    if (initialized_) {
      gpioTerminate();
      initialized_ = false;
    }
  }

  std::string name() const override { return "pigpio"; }

private:
  bool initialized_{false};
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
    handle_ = lgGpiochipOpen(chip_num_);
    if (handle_ < 0) {
      return false;
    }
    // Claim the pin for output
    int rc = lgGpioClaimOutput(handle_, 0, gpio_pin, 0);
    if (rc < 0) {
      lgGpiochipClose(handle_);
      handle_ = -1;
      return false;
    }
    initialized_ = true;
    return true;
  }

  bool set_servo_pulse(int gpio_pin, int pulse_width_us) override {
    if (!initialized_ || handle_ < 0) return false;
    // lgTxServo(handle, gpio, pulseWidth, servoFrequency, offset, cycles)
    // pulseWidth: 0 (off) or 500-2500, frequency: 50Hz, offset: 0, cycles: 0 (infinite)
    int rc = lgTxServo(handle_, gpio_pin, pulse_width_us, 50, 0, 0);
    return rc >= 0;
  }

  void cleanup() override {
    if (initialized_ && handle_ >= 0) {
      lgGpiochipClose(handle_);
      handle_ = -1;
      initialized_ = false;
    }
  }

  std::string name() const override { return "lgpio"; }

private:
  int chip_num_{0};
  int handle_{-1};
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
  void cleanup() override {}
  std::string name() const override { return "simulation"; }
};

/// Factory: try to create the requested backend.
/// @param preferred  "auto", "pigpio", "lgpio", or "simulation"
/// @param chip_num   GPIO chip number (lgpio only, typically 0 for Pi4, 4 for Pi5)
/// @param out_name   filled with the name of the actually created backend
inline std::unique_ptr<PwmBackend> make_pwm_backend(const std::string& preferred, int chip_num,
                                                    std::string& out_name) {
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
    // Try pigpio first (hardware PWM), fall back to lgpio
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
