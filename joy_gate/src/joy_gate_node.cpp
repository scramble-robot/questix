// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <rclcpp/rclcpp.hpp>

#include "joy_gate/joy_gate_component.hpp"

int main(int argc, char* argv[]) {
  rclcpp::init(argc, argv);

  rclcpp::NodeOptions options;
  auto node = std::make_shared<joy_gate::JoyGateComponent>(options);

  rclcpp::spin(node);

  rclcpp::shutdown();
  return 0;
}
