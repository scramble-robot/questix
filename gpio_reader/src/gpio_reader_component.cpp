// Copyright 2026 scramble-robot
//
#include "gpio_reader/gpio_reader_component.hpp"

#include <chrono>

namespace gpio_reader {

GpioReaderComponent::GpioReaderComponent(const rclcpp::NodeOptions& options)
    : Node("gpio_reader_node", options), chip_(nullptr) {
  // Declare parameters
  this->declare_parameter<std::string>("chip_name", "/dev/gpiochip4");
  this->declare_parameter<std::vector<int64_t>>("gpio_pins", std::vector<int64_t>{17, 27, 22});
  this->declare_parameter<double>("publish_rate", 10.0);

  // Get parameters
  chip_name_ = this->get_parameter("chip_name").as_string();
  gpio_pins_ = this->get_parameter("gpio_pins").as_integer_array();
  publish_rate_ = this->get_parameter("publish_rate").as_double();

  RCLCPP_INFO(this->get_logger(), "GPIO Reader Component initialized");
  RCLCPP_INFO(this->get_logger(), "Chip: %s", chip_name_.c_str());
  RCLCPP_INFO(this->get_logger(), "Publish rate: %.2f Hz", publish_rate_);

  for (const auto& pin : gpio_pins_) {
    RCLCPP_INFO(this->get_logger(), "Monitoring GPIO pin: %ld", pin);
  }

  // Initialize GPIO
  if (!initialize_gpio()) {
    RCLCPP_ERROR(this->get_logger(), "Failed to initialize GPIO");
    return;
  }

  // Create publishers
  for (const auto& pin : gpio_pins_) {
    std::string topic_name = "gpio_" + std::to_string(pin);
    individual_pubs_[pin] = this->create_publisher<std_msgs::msg::Bool>(topic_name, 10);
  }

  // Create timer
  auto timer_interval = std::chrono::duration<double>(1.0 / publish_rate_);
  timer_ = this->create_wall_timer(timer_interval,
                                   std::bind(&GpioReaderComponent::timer_callback, this));

  RCLCPP_INFO(this->get_logger(), "GPIO Reader Component started");
}

GpioReaderComponent::~GpioReaderComponent() {
  cleanup_gpio();
  RCLCPP_INFO(this->get_logger(), "GPIO Reader Component destroyed");
}

bool GpioReaderComponent::initialize_gpio() {
  // Open GPIO chip
  chip_ = gpiod_chip_open(chip_name_.c_str());
  if (!chip_) {
    RCLCPP_ERROR(this->get_logger(), "Failed to open GPIO chip: %s", chip_name_.c_str());
    return false;
  }

  // Open and configure GPIO lines
  for (const auto& pin : gpio_pins_) {
    struct gpiod_line* line = gpiod_chip_get_line(chip_, pin);
    if (!line) {
      RCLCPP_ERROR(this->get_logger(), "Failed to get GPIO line %ld", pin);
      cleanup_gpio();
      return false;
    }

    // Request line as input
    int ret = gpiod_line_request_input(line, "gpio_reader");
    if (ret < 0) {
      RCLCPP_ERROR(this->get_logger(), "Failed to request GPIO line %ld as input", pin);
      cleanup_gpio();
      return false;
    }

    lines_[pin] = line;
    RCLCPP_INFO(this->get_logger(), "GPIO pin %ld configured as input", pin);
  }

  return true;
}

void GpioReaderComponent::cleanup_gpio() {
  // Release all lines
  for (auto& pair : lines_) {
    if (pair.second) {
      gpiod_line_release(pair.second);
    }
  }
  lines_.clear();

  // Close chip
  if (chip_) {
    gpiod_chip_close(chip_);
    chip_ = nullptr;
  }
}

int GpioReaderComponent::read_gpio_value(unsigned int pin) {
  auto it = lines_.find(pin);
  if (it == lines_.end() || !it->second) {
    RCLCPP_WARN(this->get_logger(), "GPIO line %u not found", pin);
    return -1;
  }

  int value = gpiod_line_get_value(it->second);
  if (value < 0) {
    RCLCPP_WARN(this->get_logger(), "Failed to read GPIO pin %u", pin);
    return -1;
  }

  return value;
}

void GpioReaderComponent::timer_callback() {
  // Read all GPIO values and publish individual topics
  for (const auto& pin : gpio_pins_) {
    int value = read_gpio_value(pin);

    if (value >= 0) {
      auto msg = std_msgs::msg::Bool();
      msg.data = (value == 1);
      individual_pubs_[pin]->publish(msg);
    }
  }
}

}  // namespace gpio_reader

#include "rclcpp_components/register_node_macro.hpp"
RCLCPP_COMPONENTS_REGISTER_NODE(gpio_reader::GpioReaderComponent)
