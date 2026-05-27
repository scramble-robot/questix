// Copyright (c) 2025 Questix Project
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

#ifndef JOY_CONTROLLER__JOY_CONTROLLER_COMPONENT_HPP_
#define JOY_CONTROLLER__JOY_CONTROLLER_COMPONENT_HPP_

#if __cplusplus
extern "C" {
#endif

// Visibility control macros
#if defined _WIN32 || defined __CYGWIN__
#ifdef __GNUC__
#define JOY_CONTROLLER_EXPORT __attribute__((dllexport))
#define JOY_CONTROLLER_IMPORT __attribute__((dllimport))
#else
#define JOY_CONTROLLER_EXPORT __declspec(dllexport)
#define JOY_CONTROLLER_IMPORT __declspec(dllimport)
#endif
#ifdef JOY_CONTROLLER_BUILDING_DLL
#define JOY_CONTROLLER_PUBLIC JOY_CONTROLLER_EXPORT
#else
#define JOY_CONTROLLER_PUBLIC JOY_CONTROLLER_IMPORT
#endif
#define JOY_CONTROLLER_PUBLIC_TYPE JOY_CONTROLLER_PUBLIC
#define JOY_CONTROLLER_LOCAL
#else
#define JOY_CONTROLLER_EXPORT __attribute__((visibility("default")))
#define JOY_CONTROLLER_IMPORT
#if __GNUC__ >= 4
#define JOY_CONTROLLER_PUBLIC __attribute__((visibility("default")))
#define JOY_CONTROLLER_LOCAL __attribute__((visibility("hidden")))
#else
#define JOY_CONTROLLER_PUBLIC
#define JOY_CONTROLLER_LOCAL
#endif
#define JOY_CONTROLLER_PUBLIC_TYPE
#endif

#if __cplusplus
}  // extern "C"
#endif

#include <geometry_msgs/msg/twist.hpp>
#include <map>
#include <memory>
#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/joy.hpp>
#include <std_msgs/msg/int32.hpp>
#include <vector>

namespace joy_controller {

enum class ButtonState { RELEASED, PRESSED, HELD };

struct ButtonInfo {
  bool current_state;
  bool previous_state;
  ButtonState button_state;
  rclcpp::Time last_press_time;
  rclcpp::Time last_release_time;
};

class JoyControllerComponent : public rclcpp::Node {
public:
  JOY_CONTROLLER_PUBLIC
  explicit JoyControllerComponent(const rclcpp::NodeOptions &options);

private:
  // Callback functions
  rcl_interfaces::msg::SetParametersResult paramCallback(
      const std::vector<rclcpp::Parameter> &params);
  void joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg);

  // Button handling
  void updateButtonStates(const sensor_msgs::msg::Joy::SharedPtr msg);
  bool isButtonJustPressed(int button_index);

  // Movement control
  void publishTwist(const sensor_msgs::msg::Joy::SharedPtr msg);

  // Parameter management
  void loadParameters();

  // ROS2 interfaces
  rclcpp::Subscription<sensor_msgs::msg::Joy>::SharedPtr joy_sub_;
  rclcpp::Publisher<geometry_msgs::msg::Twist>::SharedPtr twist_pub_;

  // Parameter callback handle
  rclcpp::node_interfaces::OnSetParametersCallbackHandle::SharedPtr param_handler_ptr_;

  // Movement parameters
  double longitudinal_input_ratio_;
  double lateral_input_ratio_;
  double angular_input_ratio_;

  // Controller mapping
  int linear_x_axis_;
  int linear_y_axis_;
  int angular_z_axis_;

  // State variables
  std::map<int, ButtonInfo> button_states_;

  // Debug and monitoring
  bool debug_mode_;
  int message_count_;
};

}  // namespace joy_controller

#endif  // JOY_CONTROLLER__JOY_CONTROLLER_COMPONENT_HPP_
