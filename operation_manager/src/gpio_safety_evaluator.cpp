// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#include "operation_manager/gpio_safety_evaluator.hpp"

#include <cmath>
#include <limits>
#include <set>
#include <stdexcept>

namespace operation_manager {

GpioSafetyEvaluator::GpioSafetyEvaluator(const std::vector<int64_t>& safe_low_pins,
                                         const std::vector<int64_t>& safe_high_pins,
                                         double timeout_seconds)
    : timeout_seconds_(timeout_seconds) {
  if (!std::isfinite(timeout_seconds_) || timeout_seconds_ <= 0.0) {
    throw std::invalid_argument("timeout_seconds must be finite and greater than zero");
  }

  add_pins(safe_low_pins, false, "safe_low_pins");
  add_pins(safe_high_pins, true, "safe_high_pins");
  if (pins_.empty()) {
    throw std::invalid_argument("at least one safe GPIO pin must be configured");
  }
}

void GpioSafetyEvaluator::add_pins(const std::vector<int64_t>& pins, bool expected_value,
                                   const std::string& parameter_name) {
  std::set<int64_t> parameter_pins;
  for (const auto pin : pins) {
    if (pin < kMinBcmPin || pin > kMaxBcmPin) {
      throw std::invalid_argument(parameter_name + " contains out-of-range BCM pin " +
                                  std::to_string(pin));
    }
    if (!parameter_pins.insert(pin).second) {
      throw std::invalid_argument(parameter_name + " contains duplicate pin " +
                                  std::to_string(pin));
    }

    const auto result =
        pins_.emplace(static_cast<unsigned int>(pin), PinState{expected_value, false, false, 0.0});
    if (!result.second) {
      throw std::invalid_argument("pin " + std::to_string(pin) +
                                  " is configured as both safe-low and safe-high");
    }
  }
}

void GpioSafetyEvaluator::update(unsigned int pin, bool value, double monotonic_now_seconds) {
  auto it = pins_.find(pin);
  if (it == pins_.end()) {
    throw std::invalid_argument("received update for unmonitored pin " + std::to_string(pin));
  }
  it->second.received = true;
  it->second.value = value;
  it->second.last_update_seconds = monotonic_now_seconds;
}

GpioSafetyEvaluation GpioSafetyEvaluator::evaluate(double monotonic_now_seconds) const {
  GpioSafetyEvaluation result{true, "", {}};
  result.pins.reserve(pins_.size());

  for (const auto& pair : pins_) {
    const auto pin = pair.first;
    const auto& state = pair.second;
    const bool invalid_time = state.received && (!std::isfinite(monotonic_now_seconds) ||
                                                 !std::isfinite(state.last_update_seconds));
    const bool time_moved_backwards =
        state.received && !invalid_time && monotonic_now_seconds < state.last_update_seconds;
    const double age_seconds =
        state.received && !invalid_time && !time_moved_backwards
            ? monotonic_now_seconds - state.last_update_seconds
            : (state.received ? std::numeric_limits<double>::infinity() : 0.0);
    result.pins.push_back(
        GpioPinEvaluation{pin, state.expected_value, state.received, state.value, age_seconds});

    if (!state.received) {
      result.controllable = false;
      result.reason += "pin " + std::to_string(pin) + " not received; ";
    } else if (invalid_time) {
      result.controllable = false;
      result.reason += "pin " + std::to_string(pin) + " time is not finite; ";
    } else if (time_moved_backwards) {
      result.controllable = false;
      result.reason += "pin " + std::to_string(pin) + " time moved backwards; ";
    } else if (age_seconds > timeout_seconds_) {
      result.controllable = false;
      result.reason += "pin " + std::to_string(pin) + " timeout; ";
    } else if (state.value != state.expected_value) {
      result.controllable = false;
      result.reason += "pin " + std::to_string(pin) + " is " + (state.value ? "true" : "false") +
                       ", expected " + (state.expected_value ? "true" : "false") + "; ";
    }
  }

  return result;
}

std::vector<unsigned int> GpioSafetyEvaluator::monitored_pins() const {
  std::vector<unsigned int> pins;
  pins.reserve(pins_.size());
  for (const auto& pair : pins_) {
    pins.push_back(pair.first);
  }
  return pins;
}

}  // namespace operation_manager
