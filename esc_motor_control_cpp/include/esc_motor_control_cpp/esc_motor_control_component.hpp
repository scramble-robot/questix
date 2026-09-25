// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef ESC_MOTOR_CONTROL_CPP__ESC_MOTOR_CONTROL_COMPONENT_HPP_
#define ESC_MOTOR_CONTROL_CPP__ESC_MOTOR_CONTROL_COMPONENT_HPP_

#include <memory>
#include <mutex>
#include <string>

#include "esc_motor_control_cpp/full_speed_logic.hpp"
#include "esc_motor_control_cpp/pwm_backend.hpp"
#include "esc_motor_control_cpp/roller_lab_logic.hpp"
#include "questix_msgs/msg/emergency_stop.hpp"
#include "rclcpp/rclcpp.hpp"
#include "sensor_msgs/msg/joy.hpp"
#include "std_msgs/msg/float32.hpp"
#include "std_msgs/msg/string.hpp"

namespace esc_motor_control_cpp {

class EscMotorControlComponent : public rclcpp::Node {
public:
  explicit EscMotorControlComponent(const rclcpp::NodeOptions& options);
  ~EscMotorControlComponent() override;

private:
  // ---------- Initialisation ----------
  void initialize_esc();

  // ---------- Callbacks ----------
  void joy_callback(const sensor_msgs::msg::Joy::SharedPtr msg);
  void emergency_stop_callback(const questix_msgs::msg::EmergencyStop::SharedPtr msg);
  void safety_check();
  void publish_status();
  // QUESTiX LAB roller input (/roller/lab) and its status (/roller/status)
  void lab_callback(const std_msgs::msg::Float32::SharedPtr msg);
  void lab_tick();
  void publish_roller_status();
  static double steady_now_sec();

  // ---------- Motor control ----------
  void set_motor_speed(double speed);

  /// Convert speed value [-1.0, 1.0] → pulse width in microseconds
  int speed_to_pulse_us(double speed) const;

  // ---------- Parameters ----------
  int pwm_pin_;
  double max_speed_;
  double min_speed_;
  bool enable_safety_stop_;
  double safety_timeout_;
  int full_speed_button_;
  double full_speed_value_;
  bool test_mode_;
  std::string joy_topic_;
  std::string status_topic_;
  // 統一緊急停止トピック（questix_msgs/EmergencyStop, 入力）。空文字で連動無効。
  std::string emergency_stop_topic_;
  int min_pulse_width_us_;
  int max_pulse_width_us_;
  int neutral_pulse_width_us_;
  std::string pwm_backend_name_;  // "auto", "pigpio", "lgpio", "simulation"
  int gpio_chip_num_;             // lgpio chip number
  // QUESTiX LAB: accept /roller/lab (practice launches only; see roller_lab_logic.hpp)
  bool accept_lab_input_{false};
  std::string lab_topic_;
  double lab_max_speed_{0.8};
  double lab_joy_quiet_sec_{1.0};

  // ---------- State ----------
  double current_speed_{0.0};
  bool emergency_stop_active_{false};
  FullSpeedLogic full_speed_logic_;
  RollerLabLogic roller_lab_logic_;
  std::mutex lock_;

  // ---------- PWM ----------
  std::unique_ptr<PwmBackend> pwm_;

  // ---------- ROS I/O ----------
  rclcpp::Subscription<sensor_msgs::msg::Joy>::SharedPtr joy_sub_;
  rclcpp::Subscription<questix_msgs::msg::EmergencyStop>::SharedPtr emergency_stop_sub_;
  rclcpp::Publisher<std_msgs::msg::Float32>::SharedPtr status_pub_;
  rclcpp::Subscription<std_msgs::msg::Float32>::SharedPtr lab_sub_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr roller_status_pub_;
  rclcpp::TimerBase::SharedPtr roller_status_timer_;
  rclcpp::TimerBase::SharedPtr lab_timer_;
  rclcpp::TimerBase::SharedPtr status_timer_;
  rclcpp::TimerBase::SharedPtr safety_timer_;
};

}  // namespace esc_motor_control_cpp

#endif  // ESC_MOTOR_CONTROL_CPP__ESC_MOTOR_CONTROL_COMPONENT_HPP_
