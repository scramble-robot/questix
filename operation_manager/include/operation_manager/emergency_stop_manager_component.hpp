// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#ifndef OPERATION_MANAGER__EMERGENCY_STOP_MANAGER_COMPONENT_HPP_
#define OPERATION_MANAGER__EMERGENCY_STOP_MANAGER_COMPONENT_HPP_

#include <diagnostic_msgs/msg/diagnostic_array.hpp>
#include <map>     // NOLINT(build/include_order)
#include <memory>  // NOLINT(build/include_order)
#include <questix_msgs/msg/emergency_stop.hpp>
#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/bool.hpp>
#include <string>  // NOLINT(build/include_order)

#include "operation_manager/gpio_safety_evaluator.hpp"

namespace operation_manager {

// The emergency stop (L1), a safety function and nothing else: the physical E-stop circuit's
// GPIO5 (safe-low) -> /emergency_stop (questix_msgs/EmergencyStop, reliable + transient_local +
// keep-last(1), on every GPIO update and every 100 ms). Every actuator stops while it is pressed,
// never heard or silent. The AutoReferee (GPIO27) is not an input here: a defeat is a state of the
// game, the referee's vote for the motion permission (RefereeMonitor, MotionPermissionManager).
// Keep other functions out of this component (design/safety_permission_input_refactor.md, 3.3).
//
// Without the GPIO safety path (gpio_safety_enabled=false, an explicit diagnostic launch only) it
// reads no GPIO and keeps publishing "released (no GPIO safety path)", so every subscriber keeps
// one rule whatever the robot is wired with.
class EmergencyStopManagerComponent : public rclcpp::Node {
public:
  explicit EmergencyStopManagerComponent(const rclcpp::NodeOptions& options);
  static rclcpp::QoS emergency_stop_qos();
  // /emergency_stop reason while the GPIO safety path is disabled (gpio_safety_enabled=false).
  static constexpr const char* kNoGpioReason = "released (no GPIO safety path)";
  // /emergency_stop source (kept from before the split: recorded bags and pages show it).
  static constexpr const char* kSource = "operation_manager";

private:
  void gpioCallback(const std_msgs::msg::Bool::SharedPtr msg, unsigned int pin);
  void evaluate();
  void publishWithoutGpio();

  std::map<unsigned int, rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr> gpio_subs_;
  std::unique_ptr<GpioSafetyEvaluator> safety_evaluator_;
  // 標準診断集約トピック（rqt_runtime_monitor 等がそのまま消費できる）。
  rclcpp::Publisher<diagnostic_msgs::msg::DiagnosticArray>::SharedPtr diagnostics_pub_;
  rclcpp::Publisher<questix_msgs::msg::EmergencyStop>::SharedPtr emergency_stop_pub_;
  rclcpp::TimerBase::SharedPtr eval_timer_;
  std::string emergency_stop_topic_;
  bool gpio_safety_enabled_{true};
};

}  // namespace operation_manager

#endif  // OPERATION_MANAGER__EMERGENCY_STOP_MANAGER_COMPONENT_HPP_
