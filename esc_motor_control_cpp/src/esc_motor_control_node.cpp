// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <memory>

#include "esc_motor_control_cpp/esc_motor_control_component.hpp"
#include "rclcpp/rclcpp.hpp"

int main(int argc, char* argv[]) {
  rclcpp::init(argc, argv);

  int result = 0;
  try {
    rclcpp::NodeOptions options;
    auto node = std::make_shared<esc_motor_control_cpp::EscMotorControlComponent>(options);
    rclcpp::spin(node);
    node->begin_shutdown();
  } catch (const std::exception& error) {
    RCLCPP_FATAL(rclcpp::get_logger("esc_motor_control"), "ESC configuration/startup failed: %s",
                 error.what());
    result = 1;
  }

  try {
    rclcpp::shutdown();
  } catch (...) {
    // Guard against double shutdown (e.g. SIGINT handler already called it)
  }

  return result;
}
