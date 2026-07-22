// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#ifndef OPERATION_MANAGER__OPERATION_MANAGER_COMPONENT_HPP_
#define OPERATION_MANAGER__OPERATION_MANAGER_COMPONENT_HPP_

#include <diagnostic_msgs/msg/diagnostic_array.hpp>
#include <map>
#include <questix_msgs/msg/emergency_stop.hpp>
#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/bool.hpp>
#include <string>
#include <vector>

namespace operation_manager {

class OperationManagerComponent : public rclcpp::Node {
public:
  explicit OperationManagerComponent(const rclcpp::NodeOptions& options);
  virtual ~OperationManagerComponent();

private:
  void gpio_callback(const std_msgs::msg::Bool::SharedPtr msg, unsigned int pin);
  void evaluate_controllability();

  std::map<unsigned int, bool> gpio_states_;
  std::map<unsigned int, rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr> gpio_subs_;
  std::map<unsigned int, rclcpp::Time> gpio_last_update_;

  rclcpp::Publisher<std_msgs::msg::Bool>::SharedPtr controllable_pub_;
  // 標準診断集約トピック（rqt_runtime_monitor 等がそのまま消費できる）。
  rclcpp::Publisher<diagnostic_msgs::msg::DiagnosticArray>::SharedPtr diagnostics_pub_;
  rclcpp::Publisher<questix_msgs::msg::EmergencyStop>::SharedPtr emergency_stop_pub_;

  rclcpp::TimerBase::SharedPtr eval_timer_;

  double timeout_seconds_;
  std::vector<int64_t> monitored_pins_;
  std::string emergency_stop_topic_;
};

}  // namespace operation_manager

#endif  // OPERATION_MANAGER__OPERATION_MANAGER_COMPONENT_HPP_
