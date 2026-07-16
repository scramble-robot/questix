// Copyright (c) 2026 Questix Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#ifndef UART_JOY_DRIVER__DROPOUT_FILTER_HPP_
#define UART_JOY_DRIVER__DROPOUT_FILTER_HPP_

#include <cstddef>
#include <sensor_msgs/msg/joy.hpp>
#include <vector>

namespace uart_joy_driver {

// Debounces momentary UART dropouts by holding the last active axis/button
// value until a configurable number of consecutive neutral frames confirms the
// release. State is retained between apply() calls.
class DropoutFilter {
public:
  struct Config {
    double hold_axis_threshold{0.1};
    int axis_release_confirm_frames{2};
    int button_release_confirm_frames{2};
  };

  DropoutFilter() = default;

  void configure(const Config& config);
  void apply(sensor_msgs::msg::Joy& joy_msg);
  void reset(size_t axis_count, size_t button_count);

private:
  Config config_;
  std::vector<float> filtered_axes_;
  std::vector<int> filtered_buttons_;
  std::vector<int> axis_release_counts_;
  std::vector<int> button_release_counts_;
};

}  // namespace uart_joy_driver

#endif  // UART_JOY_DRIVER__DROPOUT_FILTER_HPP_
