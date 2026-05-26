// Copyright 2026 scramble-robot
//
#ifndef GPIO_READER__GPIO_READER_COMPONENT_HPP_
#define GPIO_READER__GPIO_READER_COMPONENT_HPP_

#include <gpiod.h>

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "rclcpp/rclcpp.hpp"
#include "rclcpp/time.hpp"
#include "std_msgs/msg/bool.hpp"
#include "std_msgs/msg/int32.hpp"

namespace gpio_reader {

class GpioReaderComponent : public rclcpp::Node {
public:
  explicit GpioReaderComponent(const rclcpp::NodeOptions &options);
  virtual ~GpioReaderComponent();

private:
  void timer_callback();
  bool initialize_gpio();
  void cleanup_gpio();
  int read_gpio_value(unsigned int pin);

  // Parameters
  std::string chip_name_;
  std::vector<int64_t> gpio_pins_;
  double publish_rate_;

  // GPIO
  struct gpiod_chip *chip_;
  std::map<unsigned int, struct gpiod_line *> lines_;

  // Publishers
  std::map<unsigned int, rclcpp::Publisher<std_msgs::msg::Bool>::SharedPtr> individual_pubs_;

  // Timer
  rclcpp::TimerBase::SharedPtr timer_;
};

}  // namespace gpio_reader

#endif  // GPIO_READER__GPIO_READER_COMPONENT_HPP_
