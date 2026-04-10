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

#include <uart_joy_driver/uart_joy_driver_component.hpp>

#include <fcntl.h>
#include <termios.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace std::chrono_literals;

namespace uart_joy_driver {

// Static DPAD lookup table definitions
constexpr double UartJoyDriverComponent::DPAD_X[9];
constexpr double UartJoyDriverComponent::DPAD_Y[9];

UartJoyDriverComponent::UartJoyDriverComponent(const rclcpp::NodeOptions & options)
    : Node("uart_joy_driver", options), serial_fd_(-1) {
  // Declare and load parameters
  declare_parameter("serial_port", "/dev/ttyAMA0");
  declare_parameter("baud_rate", 115200);
  declare_parameter("publish_rate", 50.0);
  declare_parameter("deadzone", 0.05);

  get_parameter("serial_port", serial_port_);
  get_parameter("baud_rate", baud_rate_);
  get_parameter("publish_rate", publish_rate_);
  get_parameter("deadzone", deadzone_);

  // Create Joy publisher
  joy_pub_ = this->create_publisher<sensor_msgs::msg::Joy>("/joy", 10);

  // Initialize serial port
  if (!initializeSerial()) {
    RCLCPP_ERROR(this->get_logger(), "シリアルポートの初期化に失敗しました: %s",
                 serial_port_.c_str());
    RCLCPP_ERROR(this->get_logger(),
                 "ポートが接続されていない可能性があります。タイマーは起動しますが、"
                 "データは送信されません。");
  }

  // Create periodic read timer
  auto period = std::chrono::duration<double>(1.0 / publish_rate_);
  read_timer_ = this->create_wall_timer(
      std::chrono::duration_cast<std::chrono::nanoseconds>(period),
      std::bind(&UartJoyDriverComponent::readTimerCallback, this));

  RCLCPP_INFO(this->get_logger(),
              "UART Joy Driver initialized: port=%s, baud=%d, rate=%.1fHz, deadzone=%.3f",
              serial_port_.c_str(), baud_rate_, publish_rate_, deadzone_);
}

UartJoyDriverComponent::~UartJoyDriverComponent() { closeSerial(); }

bool UartJoyDriverComponent::initializeSerial() {
  serial_fd_ = open(serial_port_.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK);
  if (serial_fd_ < 0) {
    RCLCPP_ERROR(this->get_logger(), "シリアルポートが開けませんでした: %s", serial_port_.c_str());
    return false;
  }

  struct termios tty;
  if (tcgetattr(serial_fd_, &tty) != 0) {
    RCLCPP_ERROR(this->get_logger(), "tcgetattr エラー");
    closeSerial();
    return false;
  }

  // Baud rate
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
      speed = B115200;
      break;
  }
  cfsetospeed(&tty, speed);
  cfsetispeed(&tty, speed);

  // 8N1 configuration
  tty.c_cflag = (tty.c_cflag & ~CSIZE) | CS8;
  tty.c_cflag |= (CLOCAL | CREAD);
  tty.c_cflag &= ~(PARENB | PARODD);
  tty.c_cflag &= ~CSTOPB;
  tty.c_cflag &= ~CRTSCTS;

  // Raw input - no canonical processing, but we handle line parsing ourselves
  tty.c_iflag &= ~(IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL);
  tty.c_iflag &= ~(IXON | IXOFF | IXANY);
  tty.c_lflag &= ~(ECHO | ECHONL | ICANON | ISIG | IEXTEN);
  tty.c_oflag &= ~OPOST;

  // Non-blocking reads: return immediately with whatever is available
  tty.c_cc[VMIN] = 0;
  tty.c_cc[VTIME] = 0;

  if (tcsetattr(serial_fd_, TCSANOW, &tty) != 0) {
    RCLCPP_ERROR(this->get_logger(), "tcsetattr エラー");
    closeSerial();
    return false;
  }

  // Flush any stale data in buffers
  tcflush(serial_fd_, TCIOFLUSH);

  RCLCPP_INFO(this->get_logger(), "シリアルポートが開きました: %s (baud=%d)",
              serial_port_.c_str(), baud_rate_);
  return true;
}

void UartJoyDriverComponent::closeSerial() {
  if (serial_fd_ >= 0) {
    close(serial_fd_);
    serial_fd_ = -1;
  }
}

void UartJoyDriverComponent::readTimerCallback() {
  if (serial_fd_ < 0) {
    return;
  }

  // Read available data from serial port
  char buf[256];
  ssize_t n = read(serial_fd_, buf, sizeof(buf) - 1);
  if (n > 0) {
    read_buffer_.append(buf, static_cast<size_t>(n));
  }

  // Prevent buffer from growing unbounded if no valid lines are found
  if (read_buffer_.size() > 1024) {
    read_buffer_ = read_buffer_.substr(read_buffer_.size() - 512);
  }

  // Process all complete lines, use only the latest one
  std::string latest_line;
  std::string line;
  while (readLine(line)) {
    latest_line = line;
  }

  if (latest_line.empty()) {
    return;
  }

  // Parse the hex data
  std::vector<uint8_t> bytes;
  if (!parseLine(latest_line, bytes)) {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                         "パースに失敗しました: '%s'", latest_line.c_str());
    return;
  }

  // Convert to Joy message and publish
  auto joy_msg = bytesToJoyMsg(bytes);
  joy_pub_->publish(joy_msg);
}

bool UartJoyDriverComponent::readLine(std::string & line) {
  // Look for \r\n or \n delimiter
  auto pos = read_buffer_.find('\n');
  if (pos == std::string::npos) {
    return false;
  }

  line = read_buffer_.substr(0, pos);
  read_buffer_.erase(0, pos + 1);

  // Strip trailing \r if present
  if (!line.empty() && line.back() == '\r') {
    line.pop_back();
  }

  // Strip leading/trailing whitespace
  while (!line.empty() && (line.front() == ' ' || line.front() == '\t')) {
    line.erase(line.begin());
  }
  while (!line.empty() && (line.back() == ' ' || line.back() == '\t')) {
    line.pop_back();
  }

  return !line.empty();
}

bool UartJoyDriverComponent::parseLine(const std::string & line,
                                       std::vector<uint8_t> & bytes) {
  // Expected format: "HH,HH,HH,HH,HH,HH,HH" (7 comma-separated hex values)
  bytes.clear();
  std::istringstream ss(line);
  std::string token;

  while (std::getline(ss, token, ',')) {
    // Strip whitespace from token
    token.erase(std::remove_if(token.begin(), token.end(),
                               [](unsigned char c) { return std::isspace(c); }),
                token.end());
    if (token.size() != 2) {
      return false;
    }
    // Validate hex characters
    for (char c : token) {
      if (!std::isxdigit(static_cast<unsigned char>(c))) {
        return false;
      }
    }
    unsigned long val = std::stoul(token, nullptr, 16);
    bytes.push_back(static_cast<uint8_t>(val));
  }

  return bytes.size() == 7;
}

sensor_msgs::msg::Joy UartJoyDriverComponent::bytesToJoyMsg(
    const std::vector<uint8_t> & bytes) {
  sensor_msgs::msg::Joy msg;
  msg.header.stamp = this->now();
  msg.header.frame_id = "uart_joy";

  // Initialize axes and buttons
  msg.axes.resize(NUM_AXES, 0.0f);
  msg.buttons.resize(NUM_BUTTONS, 0);

  // --- Axes ---
  // Normalize stick values: 0x00-0xFF (center 0x80) → -1.0 to 1.0
  // DualShock convention: left/up = positive, right/down = negative
  // UART: Byte3=LX (00=left, FF=right), Byte4=LY (00=up, FF=down)
  //       Byte5=RX (00=left, FF=right), Byte6=RY (00=up, FF=down)

  // axes[0]: Left Stick X — left=+1.0, right=-1.0 (invert)
  msg.axes[0] = static_cast<float>(
      applyDeadzone(-(static_cast<double>(bytes[3]) - 128.0) / 128.0, deadzone_));

  // axes[1]: Left Stick Y — up=+1.0, down=-1.0 (invert)
  msg.axes[1] = static_cast<float>(
      applyDeadzone(-(static_cast<double>(bytes[4]) - 128.0) / 128.0, deadzone_));

  // axes[2]: ZL trigger — 1.0 (released), -1.0 (pressed)
  bool zl_pressed = (bytes[0] >> 6) & 0x01;
  msg.axes[2] = zl_pressed ? -1.0f : 1.0f;

  // axes[3]: Right Stick X — left=+1.0, right=-1.0 (invert)
  msg.axes[3] = static_cast<float>(
      applyDeadzone(-(static_cast<double>(bytes[5]) - 128.0) / 128.0, deadzone_));

  // axes[4]: Right Stick Y — up=+1.0, down=-1.0 (invert)
  msg.axes[4] = static_cast<float>(
      applyDeadzone(-(static_cast<double>(bytes[6]) - 128.0) / 128.0, deadzone_));

  // axes[5]: ZR trigger — 1.0 (released), -1.0 (pressed)
  bool zr_pressed = (bytes[0] >> 7) & 0x01;
  msg.axes[5] = zr_pressed ? -1.0f : 1.0f;

  // axes[6], axes[7]: DPAD as hat axes
  uint8_t dpad = bytes[2];
  if (dpad <= 8) {
    msg.axes[6] = static_cast<float>(DPAD_X[dpad]);
    msg.axes[7] = static_cast<float>(DPAD_Y[dpad]);
  }

  // --- Buttons ---
  // Byte 0 bits: A(0), B(1), X(2), Y(3), L(4), R(5), ZL(6), ZR(7)
  for (int i = 0; i < 8; ++i) {
    msg.buttons[i] = (bytes[0] >> i) & 0x01;
  }

  // Byte 1 bits: -(0), +(1), Home(2), Capture(3), LStick(4), RStick(5)
  for (int i = 0; i < 6; ++i) {
    msg.buttons[8 + i] = (bytes[1] >> i) & 0x01;
  }

  return msg;
}

double UartJoyDriverComponent::applyDeadzone(double value, double deadzone) {
  if (std::abs(value) < deadzone) {
    return 0.0;
  }
  return value;
}

}  // namespace uart_joy_driver

#include <rclcpp_components/register_node_macro.hpp>
RCLCPP_COMPONENTS_REGISTER_NODE(uart_joy_driver::UartJoyDriverComponent)
