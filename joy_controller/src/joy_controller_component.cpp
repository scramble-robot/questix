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
#include <joy_controller/joy_controller_component.hpp>
#include <memory>
#include <vector>

namespace joy_controller {

JoyControllerComponent::JoyControllerComponent(const rclcpp::NodeOptions &options)
    : Node("joy_controller", options), message_count_(0) {
  // Set up parameter callback
  param_handler_ptr_ = this->add_on_set_parameters_callback(
      std::bind(&JoyControllerComponent::paramCallback, this, std::placeholders::_1));

  // Load parameters
  loadParameters();

  // Get joy input topic name (default: /joy, can be remapped to /joy_gated)
  declare_parameter("joy_topic", "/joy");
  std::string joy_topic = get_parameter("joy_topic").as_string();

  // Initialize ROS2 interfaces
  joy_sub_ = this->create_subscription<sensor_msgs::msg::Joy>(
      joy_topic, 10, std::bind(&JoyControllerComponent::joyCallback, this, std::placeholders::_1));

  twist_pub_ = this->create_publisher<geometry_msgs::msg::Twist>("/target_twist", 1);

  RCLCPP_INFO(this->get_logger(), "Joy Controller Component initialized");
  RCLCPP_INFO(this->get_logger(), "Subscribing to joy topic: %s", joy_topic.c_str());
  if (debug_mode_) {
    RCLCPP_INFO(this->get_logger(), "Debug mode enabled");
  }
}

void JoyControllerComponent::loadParameters() {
  // Movement parameters
  declare_parameter("longitudinal_input_ratio", 0.1);
  get_parameter("longitudinal_input_ratio", longitudinal_input_ratio_);

  declare_parameter("lateral_input_ratio", 0.3);
  get_parameter("lateral_input_ratio", lateral_input_ratio_);

  declare_parameter("angular_input_ratio", 0.1);
  get_parameter("angular_input_ratio", angular_input_ratio_);

  // Controller mapping
  declare_parameter("linear_x_axis", 1);
  get_parameter("linear_x_axis", linear_x_axis_);

  declare_parameter("linear_y_axis", 0);
  get_parameter("linear_y_axis", linear_y_axis_);

  declare_parameter("angular_z_axis", 3);
  get_parameter("angular_z_axis", angular_z_axis_);

  // Debug mode
  declare_parameter("debug_mode", false);
  get_parameter("debug_mode", debug_mode_);
}

void JoyControllerComponent::joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg) {
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

void JoyControllerComponent::updateButtonStates(const sensor_msgs::msg::Joy::SharedPtr msg) {
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

bool JoyControllerComponent::isButtonJustPressed(int button_index) {
  auto it = button_states_.find(button_index);
  return (it != button_states_.end()) && (it->second.button_state == ButtonState::PRESSED);
}

void JoyControllerComponent::publishTwist(const sensor_msgs::msg::Joy::SharedPtr msg) {
  // joy_to_twist style implementation - simplified and direct mapping
  if (msg->axes.size() < 4) {
    return;
  }

  auto twist = geometry_msgs::msg::Twist();

  // Direct mapping like joy_to_twist: axes[1] -> linear.x, axes[3] -> angular.z
  twist.linear.x = msg->axes[linear_x_axis_] * longitudinal_input_ratio_;
  twist.angular.z = msg->axes[angular_z_axis_] * angular_input_ratio_;

  // Optional: Apply lateral movement if configured
  if (linear_y_axis_ >= 0 && static_cast<size_t>(linear_y_axis_) < msg->axes.size()) {
    twist.linear.y = msg->axes[linear_y_axis_] * lateral_input_ratio_;
  }

  twist_pub_->publish(twist);

  if (debug_mode_ && message_count_ % 50 == 0) {
    RCLCPP_INFO(this->get_logger(),
                "Published twist: linear=[%.3f, %.3f, %.3f], angular=[%.3f, %.3f, %.3f]",
                twist.linear.x, twist.linear.y, twist.linear.z, twist.angular.x, twist.angular.y,
                twist.angular.z);
  }
}

rcl_interfaces::msg::SetParametersResult JoyControllerComponent::paramCallback(
    const std::vector<rclcpp::Parameter> &params) {
  auto result = std::make_shared<rcl_interfaces::msg::SetParametersResult>();

  try {
    for (const auto &param : params) {
      const std::string &name = param.get_name();

      if (name == "longitudinal_input_ratio") {
        longitudinal_input_ratio_ = param.get_value<double>();
      } else if (name == "lateral_input_ratio") {
        lateral_input_ratio_ = param.get_value<double>();
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
RCLCPP_COMPONENTS_REGISTER_NODE(joy_controller::JoyControllerComponent)
