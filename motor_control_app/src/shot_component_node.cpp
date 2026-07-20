// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <memory>
#include <rclcpp/rclcpp.hpp>

#include "motor_control_app/shot_component.hpp"

int main(int argc, char *argv[]) {
  rclcpp::init(argc, argv);

  rclcpp::NodeOptions options;
  auto component = std::make_shared<motor_control_app::ShotComponent>(options);

  RCLCPP_INFO(component->get_logger(), "Shot Component Node started");

  // LifecycleNode は Node を継承しないため base interface 経由で spin する
  rclcpp::spin(component->get_node_base_interface());

  RCLCPP_INFO(component->get_logger(), "Shot Component Node shutting down");
  rclcpp::shutdown();

  return 0;
}
