// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <memory>
#include <rclcpp/rclcpp.hpp>

#include "joy_controller/joy_launcher_component.hpp"

int main(int argc, char* argv[]) {
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<joy_controller::JoyLauncherComponent>(rclcpp::NodeOptions()));
  rclcpp::shutdown();
  return 0;
}
