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

#include <fcntl.h>
#include <termios.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <uart_joy_driver/uart_joy_driver_component.hpp>

#include "serial_utils/serial_port.hpp"

namespace uart_joy_driver {

UartJoyDriverComponent::UartJoyDriverComponent(const rclcpp::NodeOptions& options)
    : Node("uart_joy_driver", options),
      serial_fd_(-1),
      last_frame_time_(0, 0, RCL_ROS_TIME),
      have_received_frame_(false),
      neutral_published_(false) {
  declare_parameter("serial_port", "/dev/ttyAMA0");
  declare_parameter("baud_rate", 115200);
  declare_parameter("read_poll_rate", 50.0);
  declare_parameter("publish_rate", 50.0);
  declare_parameter("deadzone", 0.05);
  declare_parameter("message_timeout_sec", 0.5);
  declare_parameter("hold_axis_threshold", 0.1);
  declare_parameter("axis_release_confirm_frames", 2);
  declare_parameter("button_release_confirm_frames", 2);
  declare_parameter("debug_raw_input", false);

  get_parameter("serial_port", serial_port_);
  get_parameter("baud_rate", baud_rate_);
  get_parameter("read_poll_rate", read_poll_rate_);
  get_parameter("publish_rate", publish_rate_);
  get_parameter("deadzone", deadzone_);
  get_parameter("message_timeout_sec", message_timeout_sec_);
  get_parameter("hold_axis_threshold", hold_axis_threshold_);
  get_parameter("axis_release_confirm_frames", axis_release_confirm_frames_);
  get_parameter("button_release_confirm_frames", button_release_confirm_frames_);
  get_parameter("debug_raw_input", debug_raw_input_);

  joy_pub_ = this->create_publisher<sensor_msgs::msg::Joy>("/joy", 1);
  joy_raw_pub_ = this->create_publisher<sensor_msgs::msg::Joy>("/joy_raw_uart", 1);
  DropoutFilter::Config filter_config;
  filter_config.hold_axis_threshold = hold_axis_threshold_;
  filter_config.axis_release_confirm_frames = axis_release_confirm_frames_;
  filter_config.button_release_confirm_frames = button_release_confirm_frames_;
  dropout_filter_.configure(filter_config);
  dropout_filter_.reset(kJoyAxisCount, kJoyButtonCount);
  last_valid_joy_msg_.axes.assign(kJoyAxisCount, 0.0F);
  last_valid_joy_msg_.buttons.assign(kJoyButtonCount, 0);
  last_frame_time_ = this->now();

  if (!initializeSerial()) {
    RCLCPP_ERROR(this->get_logger(), "シリアルポートの初期化に失敗しました: %s",
                 serial_port_.c_str());
    RCLCPP_ERROR(this->get_logger(), "UARTの配線、受信モジュール、デバイス名を確認してください。");
  }

  const auto period = std::chrono::duration<double>(1.0 / std::max(1.0, read_poll_rate_));
  read_timer_ =
      this->create_wall_timer(std::chrono::duration_cast<std::chrono::nanoseconds>(period),
                              std::bind(&UartJoyDriverComponent::readTimerCallback, this));

  RCLCPP_INFO(this->get_logger(),
              "UART Joy Driver initialized: port=%s, baud=%d, read=%.1fHz, publish=%.1fHz, "
              "axis_release_frames=%d, button_release_frames=%d, timeout=%.2fs",
              serial_port_.c_str(), baud_rate_, read_poll_rate_, publish_rate_,
              axis_release_confirm_frames_, button_release_confirm_frames_, message_timeout_sec_);
}

UartJoyDriverComponent::~UartJoyDriverComponent() { closeSerial(); }

bool UartJoyDriverComponent::initializeSerial() {
  serial_utils::SerialConfig cfg{O_RDWR | O_NOCTTY | O_NONBLOCK, baud_rate_, 0, 0};
  serial_fd_ = serial_utils::openSerial(serial_port_, cfg, this->get_logger());
  if (serial_fd_ < 0) {
    return false;
  }

  tcflush(serial_fd_, TCIOFLUSH);
  RCLCPP_INFO(this->get_logger(), "シリアルポートが開きました: %s (baud=%d)", serial_port_.c_str(),
              baud_rate_);
  return true;
}

void UartJoyDriverComponent::closeSerial() {
  if (serial_fd_ >= 0) {
    close(serial_fd_);
    serial_fd_ = -1;
  }
}

void UartJoyDriverComponent::readTimerCallback() {
  if (serial_fd_ >= 0) {
    char buf[256];

    while (true) {
      const ssize_t bytes_read = read(serial_fd_, buf, sizeof(buf));
      if (bytes_read > 0) {
        if (debug_raw_input_) {
          std::string raw_hex;
          raw_hex.reserve(static_cast<size_t>(bytes_read) * 3);
          for (ssize_t i = 0; i < bytes_read; ++i) {
            char hex[4];
            std::snprintf(hex, sizeof(hex), "%02X ", static_cast<unsigned char>(buf[i]));
            raw_hex += hex;
          }
          RCLCPP_INFO(this->get_logger(), "Raw(%zd bytes): %s", bytes_read, raw_hex.c_str());
        }

        read_buffer_.append(buf, static_cast<size_t>(bytes_read));
        continue;
      }

      if (bytes_read < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
        RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 2000, "UART read error: %s",
                             std::strerror(errno));
      }
      break;
    }
  }

  if (read_buffer_.size() > 2048) {
    read_buffer_ = read_buffer_.substr(read_buffer_.size() - 1024);
  }

  std::string line;
  while (readLine(line)) {
    sensor_msgs::msg::Joy raw_joy_msg;
    if (!parseControllerLine(line, deadzone_, raw_joy_msg)) {
      RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 2000,
                           "Failed to parse UART controller line: %s", line.c_str());
      continue;
    }

    const auto now = this->now();
    raw_joy_msg.header.stamp = now;
    joy_raw_pub_->publish(raw_joy_msg);

    auto joy_msg = raw_joy_msg;
    dropout_filter_.apply(joy_msg);
    joy_msg.header.stamp = now;
    last_valid_joy_msg_ = joy_msg;
    last_frame_time_ = now;
    have_received_frame_ = true;
    neutral_published_ = false;

    if (debug_raw_input_) {
      RCLCPP_INFO(this->get_logger(),
                  "Received Joy: axes[0]=%.2f axes[1]=%.2f axes[3]=%.2f axes[7]=%.2f buttons[0]=%d "
                  "buttons[3]=%d",
                  joy_msg.axes[0], joy_msg.axes[1], joy_msg.axes[3], joy_msg.axes[7],
                  joy_msg.buttons[0], joy_msg.buttons[3]);
    }
  }

  if (!have_received_frame_) {
    return;
  }

  const auto now = this->now();
  if ((now - last_frame_time_).seconds() <= message_timeout_sec_) {
    auto held_msg = last_valid_joy_msg_;
    held_msg.header.stamp = now;
    joy_pub_->publish(held_msg);
  } else if (!neutral_published_) {
    publishNeutralJoy();
    neutral_published_ = true;
  }
}

bool UartJoyDriverComponent::readLine(std::string& line) {
  const auto pos = read_buffer_.find('\n');
  if (pos == std::string::npos) {
    return false;
  }

  line = read_buffer_.substr(0, pos);
  read_buffer_.erase(0, pos + 1);

  if (!line.empty() && line.back() == '\r') {
    line.pop_back();
  }

  while (!line.empty() && (line.front() == ' ' || line.front() == '\t')) {
    line.erase(line.begin());
  }
  while (!line.empty() && (line.back() == ' ' || line.back() == '\t')) {
    line.pop_back();
  }

  return !line.empty();
}

void UartJoyDriverComponent::publishNeutralJoy() {
  sensor_msgs::msg::Joy neutral_msg;
  neutral_msg.header.stamp = this->now();
  neutral_msg.axes.assign(kJoyAxisCount, 0.0F);
  neutral_msg.buttons.assign(kJoyButtonCount, 0);
  dropout_filter_.reset(kJoyAxisCount, kJoyButtonCount);
  last_valid_joy_msg_ = neutral_msg;
  joy_pub_->publish(neutral_msg);

  RCLCPP_WARN(this->get_logger(), "UART入力がタイムアウトしたため、ニュートラルJoyを送信しました");
}

}  // namespace uart_joy_driver

#include <rclcpp_components/register_node_macro.hpp>
RCLCPP_COMPONENTS_REGISTER_NODE(uart_joy_driver::UartJoyDriverComponent)
