// Copyright 2026 scramble-robot
//
#include <memory>

#include "motor_control_app/drive_component.hpp"
#include "rclcpp/rclcpp.hpp"

int main(int argc, char* argv[]) {
  rclcpp::init(argc, argv);

  // NodeOptionsを作成
  rclcpp::NodeOptions options;

  // DriveComponentを作成
  auto drive_node = std::make_shared<motor_control_app::DriveComponent>(options);

  RCLCPP_INFO(drive_node->get_logger(), "Starting Drive Component Node");

  try {
    rclcpp::spin(drive_node);
  } catch (const std::exception& e) {
    RCLCPP_ERROR(drive_node->get_logger(), "Exception during execution: %s", e.what());
  }

  RCLCPP_INFO(drive_node->get_logger(), "Shutting down Drive Component Node");
  rclcpp::shutdown();
  return 0;
}
