#include <memory>

#include "esc_motor_control_cpp/esc_motor_control_component.hpp"
#include "rclcpp/rclcpp.hpp"

int main(int argc, char* argv[]) {
  rclcpp::init(argc, argv);

  rclcpp::NodeOptions options;
  auto node = std::make_shared<esc_motor_control_cpp::EscMotorControlComponent>(options);

  rclcpp::spin(node);

  try {
    rclcpp::shutdown();
  } catch (...) {
    // Guard against double shutdown (e.g. SIGINT handler already called it)
  }

  return 0;
}
