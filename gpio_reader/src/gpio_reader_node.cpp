// Copyright 2026 scramble-robot
//
#include <memory>

#include "gpio_reader/gpio_reader_component.hpp"
#include "rclcpp/rclcpp.hpp"

int main(int argc, char* argv[]) {
  rclcpp::init(argc, argv);

  rclcpp::NodeOptions options;
  auto node = std::make_shared<gpio_reader::GpioReaderComponent>(options);

  rclcpp::spin(node);
  rclcpp::shutdown();

  return 0;
}
