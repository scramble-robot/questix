// Copyright 2026 scramble-robot
//
#include <memory>

#include "motor_control_app/single_ddt_motor_component.hpp"
#include "rclcpp/rclcpp.hpp"

int main(int argc, char* argv[]) {
  rclcpp::init(argc, argv);

  // NodeOptionsを作成
  rclcpp::NodeOptions options;

  // SingleDdtMotorComponentを作成
  auto motor_node = std::make_shared<motor_control_app::SingleDdtMotorComponent>(options);

  RCLCPP_INFO(motor_node->get_logger(), "Starting Single DDT Motor Component Node");

  try {
    rclcpp::spin(motor_node);
  } catch (const std::exception& e) {
    RCLCPP_ERROR(motor_node->get_logger(), "Exception during execution: %s", e.what());
  }

  RCLCPP_INFO(motor_node->get_logger(), "Shutting down Single DDT Motor Component Node");
  rclcpp::shutdown();
  return 0;
}