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

#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/joy.hpp>
#include <string>
#include <vector>

namespace uart_joy_driver {

class UartJoyDriverComponent : public rclcpp::Node {
public:
  UART_JOY_DRIVER_PUBLIC
  explicit UartJoyDriverComponent(const rclcpp::NodeOptions& options);
  ~UartJoyDriverComponent() override;

private:
  // Serial port management
  bool initializeSerial();
  void closeSerial();

  // Timer callback for periodic reads
  void readTimerCallback();

  // Read a complete line from serial buffer
  bool readLine(std::string& line);

  // Convert one ASCII line from the receiver module into a Joy message.
  bool parseControllerLine(const std::string& line, sensor_msgs::msg::Joy& joy_msg);
  bool parseHexByte(const std::string& token, uint8_t& value) const;
  double normalizeAxis(uint8_t value, bool invert) const;
  void fillDpadAxes(uint8_t dpad_value, sensor_msgs::msg::Joy& joy_msg) const;
  void applyDropoutFilter(sensor_msgs::msg::Joy& joy_msg);
  void publishNeutralJoy();

  // Parameters
  std::string serial_port_;
  int baud_rate_;
  double read_poll_rate_;
  double publish_rate_;
  double deadzone_;
  double message_timeout_sec_;
  double hold_axis_threshold_;
  int axis_release_confirm_frames_;
  int button_release_confirm_frames_;
  bool debug_raw_input_;

  // Serial
  int serial_fd_;
  std::string read_buffer_;

  // ROS interfaces
  rclcpp::Publisher<sensor_msgs::msg::Joy>::SharedPtr joy_pub_;
  rclcpp::Publisher<sensor_msgs::msg::Joy>::SharedPtr joy_raw_pub_;
  rclcpp::TimerBase::SharedPtr read_timer_;
  rclcpp::Time last_frame_time_;
  bool have_received_frame_;
  bool neutral_published_;
  sensor_msgs::msg::Joy last_valid_joy_msg_;
  std::vector<float> filtered_axes_;
  std::vector<int> filtered_buttons_;
  std::vector<int> axis_release_counts_;
  std::vector<int> button_release_counts_;
};

}  // namespace uart_joy_driver

#endif  // UART_JOY_DRIVER__UART_JOY_DRIVER_COMPONENT_HPP_
