// Copyright 2026 scramble-robot
//
#ifndef MOTOR_CONTROL_APP__SHOT_COMPONENT_HPP_
#define MOTOR_CONTROL_APP__SHOT_COMPONENT_HPP_

#include <chrono>
#include <memory>
#include <rclcpp/rclcpp.hpp>
#include <rclcpp_components/register_node_macro.hpp>
#include <sensor_msgs/msg/joy.hpp>

#include "motor_control_lib/servo_control.hpp"

namespace motor_control_app {

class ShotComponent : public rclcpp::Node {
public:
  explicit ShotComponent(const rclcpp::NodeOptions& options);
  virtual ~ShotComponent();

private:
  void joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg);
  void executeShotSequence();

  // 角度変換関数
  double clampAngle(double angle_deg);
  bool canSendCommand();
  int angleToServoPosition(double angle_deg);
  double servoPositionToAngle(int position);

  std::shared_ptr<motor_control_lib::FeetechServoController> servo_controller_;

  int tilt_servo_id_;
  int trigger_servo_id_;
  int fire_button_;
  int tilt_axis_;
  int tilt_up_button_index_;
  int tilt_down_button_index_;
  double tilt_step_angle_;
  double tilt_min_angle_;
  double tilt_max_angle_;
  double fire_angle_;
  double home_angle_;
  int fire_duration_ms_;
  int command_rate_limit_ms_;

  bool is_shooting_;
  bool last_button_state_;
  float last_tilt_value_;
  bool last_tilt_up_state_;
  bool last_tilt_down_state_;
  int current_tilt_position_;
  double current_tilt_angle_;
  rclcpp::Time last_command_time_;

  rclcpp::Subscription<sensor_msgs::msg::Joy>::SharedPtr joy_subscription_;
};

}  // namespace motor_control_app

#endif  // MOTOR_CONTROL_APP__SHOT_COMPONENT_HPP_
