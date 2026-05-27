// Copyright 2026 scramble-robot
//
#include <memory>
#include <rclcpp/rclcpp.hpp>

#include "motor_control_app/joy_axis_drive_component.hpp"

int main(int argc, char* argv[]) {
  rclcpp::init(argc, argv);
  rclcpp::executors::SingleThreadedExecutor executor;

  auto node = std::make_shared<motor_control_app::JoyAxisDriveComponent>(rclcpp::NodeOptions());
  executor.add_node(node);

  executor.spin();

  rclcpp::shutdown();
  return 0;
}
