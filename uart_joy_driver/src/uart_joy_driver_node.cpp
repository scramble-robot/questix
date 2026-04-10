// Copyright (c) 2026 Questix Project
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

#include <uart_joy_driver/uart_joy_driver_component.hpp>
#include <memory>
#include <rclcpp/rclcpp.hpp>

int main(int argc, char * argv[])
{
  rclcpp::init(argc, argv);

  rclcpp::NodeOptions options;
  auto component = std::make_shared<uart_joy_driver::UartJoyDriverComponent>(options);

  RCLCPP_INFO(component->get_logger(), "UART Joy Driver Node started");

  rclcpp::spin(component);

  RCLCPP_INFO(component->get_logger(), "UART Joy Driver Node shutting down");

  rclcpp::shutdown();
  return 0;
}
