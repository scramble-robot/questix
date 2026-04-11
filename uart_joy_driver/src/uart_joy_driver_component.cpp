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

#include <chrono>
#include <string>
#include <uart_joy_driver/uart_joy_driver_component.hpp>

using namespace std::chrono_literals;

namespace uart_joy_driver {

UartJoyDriverComponent::UartJoyDriverComponent(const rclcpp::NodeOptions& options)
    : Node("uart_joy_driver", options), serial_fd_(-1) {
  // Declare and load parameters
  declare_parameter("serial_port", "/dev/ttyAMA0");
  declare_parameter("baud_rate", 115200);
  declare_parameter("publish_rate", 50.0);

  get_parameter("serial_port", serial_port_);
  get_parameter("baud_rate", baud_rate_);
  get_parameter("publish_rate", publish_rate_);

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
  read_timer_ =
      this->create_wall_timer(std::chrono::duration_cast<std::chrono::nanoseconds>(period),
                              std::bind(&UartJoyDriverComponent::readTimerCallback, this));

  RCLCPP_INFO(this->get_logger(), "UART Joy Driver initialized: port=%s, baud=%d, rate=%.1fHz",
              serial_port_.c_str(), baud_rate_, publish_rate_);
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
  if (serial_fd_ < 0) {
    return;
  }

  // Read available data from serial port
  char buf[256];
  ssize_t n = read(serial_fd_, buf, sizeof(buf) - 1);
  if (n > 0) {
    // Debug: print raw bytes as hex
    buf[n] = '\0';
    std::string raw_hex;
    for (ssize_t i = 0; i < n; ++i) {
      char hex[8];
      snprintf(hex, sizeof(hex), "%02X ", static_cast<unsigned char>(buf[i]));
      raw_hex += hex;
    }
    RCLCPP_INFO(this->get_logger(), "Raw(%zd bytes): %s", n, raw_hex.c_str());

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

  if (!latest_line.empty()) {
    RCLCPP_INFO(this->get_logger(), "Line: %s", latest_line.c_str());
  }
}

bool UartJoyDriverComponent::readLine(std::string& line) {
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

}  // namespace uart_joy_driver

#include <rclcpp_components/register_node_macro.hpp>
RCLCPP_COMPONENTS_REGISTER_NODE(uart_joy_driver::UartJoyDriverComponent)
