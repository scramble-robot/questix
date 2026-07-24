// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#ifndef OPERATION_MANAGER__GPIO_SAFETY_EVALUATOR_HPP_
#define OPERATION_MANAGER__GPIO_SAFETY_EVALUATOR_HPP_

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace operation_manager {

struct GpioPinEvaluation {
  unsigned int pin;
  bool expected_value;
  bool received;
  bool value;
  double age_seconds;
};

struct GpioSafetyEvaluation {
  bool controllable;
  std::string reason;
  std::vector<GpioPinEvaluation> pins;
};

class GpioSafetyEvaluator {
public:
  static constexpr int64_t kMinBcmPin = 0;
  static constexpr int64_t kMaxBcmPin = 53;

  GpioSafetyEvaluator(const std::vector<int64_t>& safe_low_pins,
                      const std::vector<int64_t>& safe_high_pins, double timeout_seconds);

  void update(unsigned int pin, bool value, double now_seconds);
  GpioSafetyEvaluation evaluate(double now_seconds) const;
  std::vector<unsigned int> monitored_pins() const;

private:
  struct PinState {
    bool expected_value;
    bool received{false};
    bool value{false};
    double last_update_seconds{0.0};
  };

  void add_pins(const std::vector<int64_t>& pins, bool expected_value,
                const std::string& parameter_name);

  std::map<unsigned int, PinState> pins_;
  double timeout_seconds_;
};

}  // namespace operation_manager

#endif  // OPERATION_MANAGER__GPIO_SAFETY_EVALUATOR_HPP_
