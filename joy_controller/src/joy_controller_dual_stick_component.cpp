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

#include <algorithm>
#include <cmath>
#include <joy_controller/joy_controller_dual_stick_component.hpp>
#include <memory>
#include <vector>

namespace joy_controller {

JoyControllerDualStickComponent::JoyControllerDualStickComponent(const rclcpp::NodeOptions &options)
    : Node("joy_controller_dual_stick", options), message_count_(0) {
  // Set up parameter callback
  param_handler_ptr_ = this->add_on_set_parameters_callback(
      std::bind(&JoyControllerDualStickComponent::paramCallback, this, std::placeholders::_1));

  // Load parameters
  loadParameters();

  // Get joy input topic name (default: /joy, can be remapped to /joy_gated)
  declare_parameter("joy_topic", "/joy");
  std::string joy_topic = get_parameter("joy_topic").as_string();

  // Initialize ROS2 interfaces
  joy_sub_ = this->create_subscription<sensor_msgs::msg::Joy>(
      joy_topic, 10,
      std::bind(&JoyControllerDualStickComponent::joyCallback, this, std::placeholders::_1));

  twist_pub_ = this->create_publisher<geometry_msgs::msg::Twist>("/target_twist", 1);

  RCLCPP_INFO(this->get_logger(), "Joy Controller Dual Stick Component initialized");
  RCLCPP_INFO(this->get_logger(), "Subscribing to joy topic: %s", joy_topic.c_str());
  RCLCPP_INFO(
      this->get_logger(),
      "Differential drive mode: Left stick axes[%d]=left wheel, Right stick axes[%d]=right wheel",
      left_stick_vertical_axis_, right_stick_vertical_axis_);
  if (debug_mode_) {
    RCLCPP_INFO(this->get_logger(), "Debug mode enabled");
  }
}

void JoyControllerDualStickComponent::loadParameters() {
  // Movement parameters
  declare_parameter("longitudinal_input_ratio", 1.0);
  get_parameter("longitudinal_input_ratio", longitudinal_input_ratio_);

  declare_parameter("angular_input_ratio", 1.0);
  get_parameter("angular_input_ratio", angular_input_ratio_);

  // Differential drive stick mapping
  declare_parameter("left_stick_vertical_axis", 1);  // Left stick vertical = left wheel
  get_parameter("left_stick_vertical_axis", left_stick_vertical_axis_);

  declare_parameter("right_stick_vertical_axis", 4);  // Right stick vertical = right wheel
  get_parameter("right_stick_vertical_axis", right_stick_vertical_axis_);

  // Debug mode
  declare_parameter("debug_mode", false);
  get_parameter("debug_mode", debug_mode_);
}

void JoyControllerDualStickComponent::joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg) {
  if (!msg || msg->axes.empty() || msg->buttons.empty()) {
    RCLCPP_WARN(this->get_logger(), "Received invalid joy message");
    return;
  }

  message_count_++;

  if (debug_mode_ && message_count_ % 50 == 0) {
    RCLCPP_INFO(this->get_logger(), "Received %d joy messages", message_count_);
  }

  // Update button states and process button actions
  updateButtonStates(msg);

  publishTwist(msg);
}

void JoyControllerDualStickComponent::updateButtonStates(
    const sensor_msgs::msg::Joy::SharedPtr msg) {
  auto now = this->now();

  for (size_t i = 0; i < msg->buttons.size(); ++i) {
    int button_index = static_cast<int>(i);

    // Initialize button info if not exists
    if (button_states_.find(button_index) == button_states_.end()) {
      button_states_[button_index] = ButtonInfo{false, false, ButtonState::RELEASED, now, now};
    }

    auto &button_info = button_states_[button_index];
    button_info.previous_state = button_info.current_state;
    button_info.current_state = (msg->buttons[i] == 1);

    // Update button state
    if (button_info.current_state && !button_info.previous_state) {
      button_info.button_state = ButtonState::PRESSED;
      button_info.last_press_time = now;
    } else if (!button_info.current_state && button_info.previous_state) {
      button_info.button_state = ButtonState::RELEASED;
      button_info.last_release_time = now;
    } else if (button_info.current_state && button_info.previous_state) {
      button_info.button_state = ButtonState::HELD;
    } else {
      button_info.button_state = ButtonState::RELEASED;
    }
  }
}

bool JoyControllerDualStickComponent::isButtonJustPressed(int button_index) {
  auto it = button_states_.find(button_index);
  return (it != button_states_.end()) && (it->second.button_state == ButtonState::PRESSED);
}

void JoyControllerDualStickComponent::publishTwist(const sensor_msgs::msg::Joy::SharedPtr msg) {
  // Dual stick differential drive implementation:
  // - Left stick vertical axis controls left wheel speed
  // - Right stick vertical axis controls right wheel speed
  // Convert from wheel speeds to twist (linear.x and angular.z)

  // Check if we have enough axes
  int max_axis = std::max(left_stick_vertical_axis_, right_stick_vertical_axis_);

  if (static_cast<int>(msg->axes.size()) <= max_axis) {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                         "Not enough axes in joy message. Expected at least %d, got %zu",
                         max_axis + 1, msg->axes.size());
    return;
  }

  // Get left and right wheel velocities from joystick
  // Left stick vertical = left wheel, Right stick vertical = right wheel
  double left_wheel_velocity = msg->axes[left_stick_vertical_axis_] * longitudinal_input_ratio_;
  double right_wheel_velocity = msg->axes[right_stick_vertical_axis_] * longitudinal_input_ratio_;

  auto twist = geometry_msgs::msg::Twist();

  // Convert differential drive wheel speeds to twist
  // For differential drive:
  // linear.x = (left_velocity + right_velocity) / 2.0 (average of both wheels)
  // angular.z = (right_velocity - left_velocity) * angular_conversion_factor
  // The angular_input_ratio acts as a scaling factor for turning sensitivity

  twist.linear.x = (left_wheel_velocity + right_wheel_velocity) / 2.0;
  twist.angular.z = (right_wheel_velocity - left_wheel_velocity) * angular_input_ratio_;

  // linear.y is not used in differential drive (no lateral movement)
  twist.linear.y = 0.0;

  twist_pub_->publish(twist);

  if (debug_mode_ && message_count_ % 50 == 0) {
    RCLCPP_INFO(this->get_logger(), "Input axes - Left[%d]: %.3f, Right[%d]: %.3f",
                left_stick_vertical_axis_, msg->axes[left_stick_vertical_axis_],
                right_stick_vertical_axis_, msg->axes[right_stick_vertical_axis_]);
    RCLCPP_INFO(this->get_logger(), "Wheel velocities - Left: %.3f, Right: %.3f",
                left_wheel_velocity, right_wheel_velocity);
    RCLCPP_INFO(this->get_logger(), "Published twist: linear.x=%.3f, angular.z=%.3f",
                twist.linear.x, twist.angular.z);
  }
}

rcl_interfaces::msg::SetParametersResult JoyControllerDualStickComponent::paramCallback(
    const std::vector<rclcpp::Parameter> &params) {
  auto result = std::make_shared<rcl_interfaces::msg::SetParametersResult>();

  try {
    for (const auto &param : params) {
      const std::string &name = param.get_name();

      if (name == "longitudinal_input_ratio") {
        longitudinal_input_ratio_ = param.get_value<double>();
      } else if (name == "angular_input_ratio") {
        angular_input_ratio_ = param.get_value<double>();
      } else if (name == "debug_mode") {
        debug_mode_ = param.get_value<bool>();
      }
    }

    result->successful = true;
    result->reason = "Parameters updated successfully";
  } catch (const std::exception &e) {
    result->successful = false;
    result->reason = std::string("Failed to update parameters: ") + e.what();
    RCLCPP_ERROR(this->get_logger(), "%s", result->reason.c_str());
  }

  return *result;
}

}  // namespace joy_controller

#include <rclcpp_components/register_node_macro.hpp>
RCLCPP_COMPONENTS_REGISTER_NODE(joy_controller::JoyControllerDualStickComponent)
