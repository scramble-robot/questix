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

#ifndef UART_JOY_DRIVER__UART_JOY_DRIVER_COMPONENT_HPP_
#define UART_JOY_DRIVER__UART_JOY_DRIVER_COMPONENT_HPP_

#if __cplusplus
extern "C" {
#endif

// Visibility control macros
#if defined _WIN32 || defined __CYGWIN__
#ifdef __GNUC__
#define UART_JOY_DRIVER_EXPORT __attribute__((dllexport))
#define UART_JOY_DRIVER_IMPORT __attribute__((dllimport))
#else
#define UART_JOY_DRIVER_EXPORT __declspec(dllexport)
#define UART_JOY_DRIVER_IMPORT __declspec(dllimport)
#endif
#ifdef UART_JOY_DRIVER_BUILDING_DLL
#define UART_JOY_DRIVER_PUBLIC UART_JOY_DRIVER_EXPORT
#else
#define UART_JOY_DRIVER_PUBLIC UART_JOY_DRIVER_IMPORT
#endif
#define UART_JOY_DRIVER_PUBLIC_TYPE UART_JOY_DRIVER_PUBLIC
#define UART_JOY_DRIVER_LOCAL
#else
#define UART_JOY_DRIVER_EXPORT __attribute__((visibility("default")))
#define UART_JOY_DRIVER_IMPORT
#if __GNUC__ >= 4
#define UART_JOY_DRIVER_PUBLIC __attribute__((visibility("default")))
#define UART_JOY_DRIVER_LOCAL __attribute__((visibility("hidden")))
#else
#define UART_JOY_DRIVER_PUBLIC
#define UART_JOY_DRIVER_LOCAL
#endif
#define UART_JOY_DRIVER_PUBLIC_TYPE
#endif

#if __cplusplus
}  // extern "C"
#endif

#include <memory>
#include <string>
#include <vector>

#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/joy.hpp>

namespace uart_joy_driver {

class UartJoyDriverComponent : public rclcpp::Node {
public:
  UART_JOY_DRIVER_PUBLIC
  explicit UartJoyDriverComponent(const rclcpp::NodeOptions & options);
  ~UartJoyDriverComponent() override;

private:
  // Serial port management
  bool initializeSerial();
  void closeSerial();

  // Timer callback for periodic reads
  void readTimerCallback();

  // Read a complete line from serial buffer
  bool readLine(std::string & line);

  // Parse "HH,HH,HH,HH,HH,HH,HH" into 7 bytes
  bool parseLine(const std::string & line, std::vector<uint8_t> & bytes);

  // Convert parsed bytes to Joy message
  sensor_msgs::msg::Joy bytesToJoyMsg(const std::vector<uint8_t> & bytes);

  // Apply deadzone to axis value
  double applyDeadzone(double value, double deadzone);

  // Parameters
  std::string serial_port_;
  int baud_rate_;
  double publish_rate_;
  double deadzone_;

  // Serial
  int serial_fd_;
  std::string read_buffer_;

  // ROS interfaces
  rclcpp::Publisher<sensor_msgs::msg::Joy>::SharedPtr joy_pub_;
  rclcpp::TimerBase::SharedPtr read_timer_;

  // DPAD lookup table: index 0-8 → (hat_x, hat_y)
  static constexpr double DPAD_X[9] = {0, 0, 1, 1, 1, 0, -1, -1, -1};
  static constexpr double DPAD_Y[9] = {0, 1, 1, 0, -1, -1, -1, 0, 1};

  // Constants
  static constexpr int NUM_AXES = 8;      // axes[0-7]: sticks + ZL/ZR triggers + DPAD
  static constexpr int NUM_BUTTONS = 14;  // A,B,X,Y,L,R,ZL,ZR,-,+,Home,Cap,LS,RS
};

}  // namespace uart_joy_driver

#endif  // UART_JOY_DRIVER__UART_JOY_DRIVER_COMPONENT_HPP_
