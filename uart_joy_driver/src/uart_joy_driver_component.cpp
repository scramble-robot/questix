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
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sstream>
#include <string>
#include <uart_joy_driver/uart_joy_driver_component.hpp>
#include <vector>

namespace uart_joy_driver {

namespace {

constexpr size_t kJoyAxisCount = 8;
constexpr size_t kJoyButtonCount = 16;
constexpr int kExpectedFunctionId = 0x01;

std::vector<std::string> splitString(const std::string& input, char delimiter) {
  std::vector<std::string> tokens;
  std::stringstream ss(input);
  std::string token;

  while (std::getline(ss, token, delimiter)) {
    tokens.push_back(token);
  }

  return tokens;
}

}  // namespace

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
  filtered_axes_.assign(kJoyAxisCount, 0.0F);
  filtered_buttons_.assign(kJoyButtonCount, 0);
  axis_release_counts_.assign(kJoyAxisCount, 0);
  button_release_counts_.assign(kJoyButtonCount, 0);
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
  serial_fd_ = open(serial_port_.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK);
  if (serial_fd_ < 0) {
    RCLCPP_ERROR(this->get_logger(), "シリアルポートが開けませんでした: %s", serial_port_.c_str());
    return false;
  }

  struct termios tty {};
  if (tcgetattr(serial_fd_, &tty) != 0) {
    RCLCPP_ERROR(this->get_logger(), "tcgetattr エラー");
    closeSerial();
    return false;
  }

  speed_t speed = B115200;
  switch (baud_rate_) {
    case 9600:
      speed = B9600;
      break;
    case 19200:
      speed = B19200;
      break;
    case 38400:
      speed = B38400;
      break;
    case 57600:
      speed = B57600;
      break;
    case 115200:
      speed = B115200;
      break;
    default:
      RCLCPP_WARN(this->get_logger(), "未対応のボーレート %d、115200を使用", baud_rate_);
      break;
  }
  cfsetospeed(&tty, speed);
  cfsetispeed(&tty, speed);

  tty.c_cflag = (tty.c_cflag & ~CSIZE) | CS8;
  tty.c_cflag |= (CLOCAL | CREAD);
  tty.c_cflag &= ~(PARENB | PARODD);
  tty.c_cflag &= ~CSTOPB;
  tty.c_cflag &= ~CRTSCTS;

  tty.c_iflag &= ~(IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL);
  tty.c_iflag &= ~(IXON | IXOFF | IXANY);
  tty.c_lflag &= ~(ECHO | ECHONL | ICANON | ISIG | IEXTEN);
  tty.c_oflag &= ~OPOST;

  tty.c_cc[VMIN] = 0;
  tty.c_cc[VTIME] = 0;

  if (tcsetattr(serial_fd_, TCSANOW, &tty) != 0) {
    RCLCPP_ERROR(this->get_logger(), "tcsetattr エラー");
    closeSerial();
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
    if (!parseControllerLine(line, raw_joy_msg)) {
      RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 2000,
                           "Failed to parse UART controller line: %s", line.c_str());
      continue;
    }

    const auto now = this->now();
    raw_joy_msg.header.stamp = now;
    joy_raw_pub_->publish(raw_joy_msg);

    auto joy_msg = raw_joy_msg;
    applyDropoutFilter(joy_msg);
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

bool UartJoyDriverComponent::parseControllerLine(const std::string& line,
                                                 sensor_msgs::msg::Joy& joy_msg) {
  std::string payload = line;
  const auto separator_pos = payload.find(':');
  if (separator_pos != std::string::npos) {
    payload = payload.substr(separator_pos + 1);
  }

  const auto tokens = splitString(payload, ',');
  size_t data_start_index = 0;
  if (tokens.size() == 8) {
    uint8_t function_id = 0;
    if (!parseHexByte(tokens[0], function_id) || function_id != kExpectedFunctionId) {
      return false;
    }
    data_start_index = 1;
  } else if (tokens.size() != 7) {
    return false;
  }

  uint8_t byte0 = 0;
  uint8_t byte1 = 0;
  uint8_t dpad = 0;
  uint8_t lx = 0x80;
  uint8_t ly = 0x80;
  uint8_t rx = 0x80;
  uint8_t ry = 0x80;

  if (!parseHexByte(tokens[data_start_index + 0], byte0) ||
      !parseHexByte(tokens[data_start_index + 1], byte1) ||
      !parseHexByte(tokens[data_start_index + 2], dpad) ||
      !parseHexByte(tokens[data_start_index + 3], lx) ||
      !parseHexByte(tokens[data_start_index + 4], ly) ||
      !parseHexByte(tokens[data_start_index + 5], rx) ||
      !parseHexByte(tokens[data_start_index + 6], ry)) {
    return false;
  }

  joy_msg.header.stamp = this->now();
  joy_msg.axes.assign(kJoyAxisCount, 0.0F);
  joy_msg.buttons.assign(kJoyButtonCount, 0);

  // Right-hand coordinate frame: stick left = +1, stick right = -1.
  // 右手座標系: スティック左を +1、右を -1 として出力します。
  joy_msg.axes[0] = static_cast<float>(normalizeAxis(lx, true));
  joy_msg.axes[1] = static_cast<float>(normalizeAxis(ly, true));
  joy_msg.axes[3] = static_cast<float>(normalizeAxis(rx, true));
  joy_msg.axes[4] = static_cast<float>(normalizeAxis(ry, true));
  fillDpadAxes(dpad, joy_msg);

  joy_msg.buttons[0] = (byte0 & 0x01) ? 1 : 0;   // A
  joy_msg.buttons[1] = (byte0 & 0x02) ? 1 : 0;   // B
  joy_msg.buttons[2] = (byte0 & 0x04) ? 1 : 0;   // X
  joy_msg.buttons[3] = (byte0 & 0x08) ? 1 : 0;   // Y
  joy_msg.buttons[4] = (byte0 & 0x10) ? 1 : 0;   // L
  joy_msg.buttons[5] = (byte0 & 0x20) ? 1 : 0;   // R
  joy_msg.buttons[6] = (byte0 & 0x40) ? 1 : 0;   // ZL
  joy_msg.buttons[7] = (byte0 & 0x80) ? 1 : 0;   // ZR
  joy_msg.buttons[8] = (byte1 & 0x01) ? 1 : 0;   // Minus
  joy_msg.buttons[9] = (byte1 & 0x02) ? 1 : 0;   // Plus
  joy_msg.buttons[10] = (byte1 & 0x04) ? 1 : 0;  // Home
  joy_msg.buttons[11] = (byte1 & 0x08) ? 1 : 0;  // Capture
  joy_msg.buttons[12] = (byte1 & 0x10) ? 1 : 0;  // LStick
  joy_msg.buttons[13] = (byte1 & 0x20) ? 1 : 0;  // RStick

  return true;
}

void UartJoyDriverComponent::applyDropoutFilter(sensor_msgs::msg::Joy& joy_msg) {
  if (filtered_axes_.size() != joy_msg.axes.size()) {
    filtered_axes_.assign(joy_msg.axes.size(), 0.0F);
    axis_release_counts_.assign(joy_msg.axes.size(), 0);
  }
  if (filtered_buttons_.size() != joy_msg.buttons.size()) {
    filtered_buttons_.assign(joy_msg.buttons.size(), 0);
    button_release_counts_.assign(joy_msg.buttons.size(), 0);
  }

  const int axis_release_frames = std::max(1, axis_release_confirm_frames_);
  const int button_release_frames = std::max(1, button_release_confirm_frames_);

  for (size_t i = 0; i < joy_msg.axes.size(); ++i) {
    const float raw_axis = joy_msg.axes[i];
    if (std::abs(raw_axis) >= hold_axis_threshold_) {
      filtered_axes_[i] = raw_axis;
      axis_release_counts_[i] = 0;
    } else if (std::abs(filtered_axes_[i]) >= hold_axis_threshold_) {
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

bool UartJoyDriverComponent::parseHexByte(const std::string& token, uint8_t& value) const {
  if (token.empty() || token.size() > 2) {
    return false;
  }

  char* end_ptr = nullptr;
  const unsigned long parsed = std::strtoul(token.c_str(), &end_ptr, 16);
  if (end_ptr == nullptr || *end_ptr != '\0' || parsed > 0xFFUL) {
    return false;
  }

  value = static_cast<uint8_t>(parsed);
  return true;
}

double UartJoyDriverComponent::normalizeAxis(uint8_t value, bool invert) const {
  double normalized = (static_cast<int>(value) - 128) / 127.0;
  normalized = std::clamp(normalized, -1.0, 1.0);
  if (invert) {
    normalized = -normalized;
  }
  if (std::abs(normalized) < deadzone_) {
    normalized = 0.0;
  }
  return normalized;
}

void UartJoyDriverComponent::fillDpadAxes(uint8_t dpad_value,
                                          sensor_msgs::msg::Joy& joy_msg) const {
  // Right-hand coordinate frame: D-pad left = +1, right = -1.
  // 右手座標系: 十字キー左を +1、右を -1 として出力します。
  double horizontal = 0.0;
  double vertical = 0.0;

  switch (dpad_value) {
    case 1:
      vertical = 1.0;
      break;
    case 2:
      horizontal = -1.0;
      vertical = 1.0;
      break;
    case 3:
      horizontal = -1.0;
      break;
    case 4:
      horizontal = -1.0;
      vertical = -1.0;
      break;
    case 5:
      vertical = -1.0;
      break;
    case 6:
      horizontal = 1.0;
      vertical = -1.0;
      break;
    case 7:
      horizontal = 1.0;
      break;
    case 8:
      horizontal = 1.0;
      vertical = 1.0;
      break;
    default:
      break;
  }

  joy_msg.axes[6] = static_cast<float>(horizontal);
  joy_msg.axes[7] = static_cast<float>(vertical);
}

void UartJoyDriverComponent::publishNeutralJoy() {
  sensor_msgs::msg::Joy neutral_msg;
  neutral_msg.header.stamp = this->now();
  neutral_msg.axes.assign(kJoyAxisCount, 0.0F);
  neutral_msg.buttons.assign(kJoyButtonCount, 0);
  filtered_axes_.assign(kJoyAxisCount, 0.0F);
  filtered_buttons_.assign(kJoyButtonCount, 0);
  axis_release_counts_.assign(kJoyAxisCount, 0);
  button_release_counts_.assign(kJoyButtonCount, 0);
  last_valid_joy_msg_ = neutral_msg;
  joy_pub_->publish(neutral_msg);

  RCLCPP_WARN(this->get_logger(), "UART入力がタイムアウトしたため、ニュートラルJoyを送信しました");
}

}  // namespace uart_joy_driver

#include <rclcpp_components/register_node_macro.hpp>
RCLCPP_COMPONENTS_REGISTER_NODE(uart_joy_driver::UartJoyDriverComponent)
