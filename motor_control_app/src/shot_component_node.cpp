// Copyright 2026 scramble-robot
//
#include <memory>
#include <rclcpp/rclcpp.hpp>

#include "motor_control_app/shot_component.hpp"

int main(int argc, char *argv[]) {
  rclcpp::init(argc, argv);

  rclcpp::NodeOptions options;
  auto component = std::make_shared<motor_control_app::ShotComponent>(options);

  RCLCPP_INFO(component->get_logger(), "Shot Component Node started");

  rclcpp::spin(component);

  RCLCPP_INFO(component->get_logger(), "Shot Component Node shutting down");
  rclcpp::shutdown();

  return 0;
}
