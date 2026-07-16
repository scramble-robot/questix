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

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <uart_joy_driver/dropout_filter.hpp>

namespace uart_joy_driver {

void DropoutFilter::configure(const Config& config) { config_ = config; }

void DropoutFilter::apply(sensor_msgs::msg::Joy& joy_msg) {
  if (filtered_axes_.size() != joy_msg.axes.size()) {
    filtered_axes_.assign(joy_msg.axes.size(), 0.0F);
    axis_release_counts_.assign(joy_msg.axes.size(), 0);
  }
  if (filtered_buttons_.size() != joy_msg.buttons.size()) {
    filtered_buttons_.assign(joy_msg.buttons.size(), 0);
    button_release_counts_.assign(joy_msg.buttons.size(), 0);
  }

  const int axis_release_frames = std::max(1, config_.axis_release_confirm_frames);
  const int button_release_frames = std::max(1, config_.button_release_confirm_frames);

  for (size_t i = 0; i < joy_msg.axes.size(); ++i) {
    const float raw_axis = joy_msg.axes[i];
    if (std::abs(raw_axis) >= config_.hold_axis_threshold) {
      filtered_axes_[i] = raw_axis;
      axis_release_counts_[i] = 0;
    } else if (std::abs(filtered_axes_[i]) >= config_.hold_axis_threshold) {
      axis_release_counts_[i] += 1;
      if (axis_release_counts_[i] >= axis_release_frames) {
        filtered_axes_[i] = 0.0F;
        axis_release_counts_[i] = 0;
      }
    } else {
      filtered_axes_[i] = 0.0F;
      axis_release_counts_[i] = 0;
    }
    joy_msg.axes[i] = filtered_axes_[i];
  }

  for (size_t i = 0; i < joy_msg.buttons.size(); ++i) {
    const bool raw_pressed = joy_msg.buttons[i] == 1;
    if (raw_pressed) {
      filtered_buttons_[i] = 1;
      button_release_counts_[i] = 0;
    } else if (filtered_buttons_[i] == 1) {
      button_release_counts_[i] += 1;
      if (button_release_counts_[i] >= button_release_frames) {
        filtered_buttons_[i] = 0;
        button_release_counts_[i] = 0;
      }
    } else {
      filtered_buttons_[i] = 0;
      button_release_counts_[i] = 0;
    }
    joy_msg.buttons[i] = filtered_buttons_[i];
  }
}

void DropoutFilter::reset(size_t axis_count, size_t button_count) {
  filtered_axes_.assign(axis_count, 0.0F);
  filtered_buttons_.assign(button_count, 0);
  axis_release_counts_.assign(axis_count, 0);
  button_release_counts_.assign(button_count, 0);
}

}  // namespace uart_joy_driver
