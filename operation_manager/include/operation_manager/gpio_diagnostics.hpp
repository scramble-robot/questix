// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#ifndef OPERATION_MANAGER__GPIO_DIAGNOSTICS_HPP_
#define OPERATION_MANAGER__GPIO_DIAGNOSTICS_HPP_

#include <diagnostic_msgs/msg/diagnostic_status.hpp>
#include <diagnostic_msgs/msg/key_value.hpp>
#include <string>  // NOLINT(build/include_order)

#include "operation_manager/gpio_safety_evaluator.hpp"

namespace operation_manager {

// The per-pin key/values every GPIO judge of this package reports on /diagnostics
// (pin_<n>_state, _expected, _received, _age_sec; GPIO27 also its signal limit).
inline void appendGpioPinValues(diagnostic_msgs::msg::DiagnosticStatus& status,
                                const GpioSafetyEvaluation& evaluation) {
  const auto add = [&status](const std::string& key, const std::string& value) {
    diagnostic_msgs::msg::KeyValue kv;
    kv.key = key;
    kv.value = value;
    status.values.push_back(kv);
  };
  for (const auto& pin : evaluation.pins) {
    const std::string prefix = "pin_" + std::to_string(pin.pin);
    add(prefix + "_state", pin.received ? (pin.value ? "true" : "false") : "not_received");
    add(prefix + "_expected", pin.expected_value ? "true" : "false");
    add(prefix + "_received", pin.received ? "true" : "false");
    add(prefix + "_age_sec", pin.received ? std::to_string(pin.age_seconds) : "not_received");
    if (pin.pin == 27U) {
      add("pin_27_signal_limit",
          "true cannot distinguish permission, disconnected, client unpowered, or "
          "primary-side open");
    }
  }
}

}  // namespace operation_manager

#endif  // OPERATION_MANAGER__GPIO_DIAGNOSTICS_HPP_
