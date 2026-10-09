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
#include "esc_motor_control_cpp/pwm_command.hpp"
#include "esc_motor_control_cpp/roller_gate.hpp"
#include "esc_motor_control_cpp/roller_lab_logic.hpp"
#include "questix_msgs/msg/actuation_authority.hpp"
#include "questix_msgs/msg/emergency_stop.hpp"
#include "questix_safety/emergency_stop_monitor.hpp"
#include "rclcpp/rclcpp.hpp"
#include "sensor_msgs/msg/joy.hpp"
#include "std_msgs/msg/float32.hpp"
#include "std_msgs/msg/string.hpp"

namespace esc_motor_control_cpp {

// The roller spins only while roller_gate.hpp says so: the E-stop is known and released
// (require_emergency_stop; unknown and silent count as pressed, and operation_manager always
// publishes it in questix_core) and, only when a practice launch opts in to
// (require_teacher_permission, default false), the teacher's launcher permission is fresh.
// When it closes the roller goes to 0 and the full-speed latch needs a release; nothing restarts
// by itself.
class EscMotorControlComponent : public rclcpp::Node {
public:
  explicit EscMotorControlComponent(const rclcpp::NodeOptions& options);
  ~EscMotorControlComponent() override;

private:
  // ---------- Initialisation ----------
  void initialize_esc();

  // ---------- Callbacks ----------
  void joy_callback(const sensor_msgs::msg::Joy::SharedPtr msg);
  // /emergency_stop を受信したとき（estop_monitor_ から呼ばれる）。
  void on_emergency_stop(const questix_msgs::msg::EmergencyStop& msg,
                         const questix_safety::EmergencyStopMonitor::Change& change);
  void teacher_permission_callback(const questix_msgs::msg::ActuationAuthority::SharedPtr msg);
  // Re-evaluates the gate (100 ms timer and every E-stop / teacher permission message); on closing
  // it stops the roller, clears the latch and locks the lab.
  void apply_gate();
  // The current gate (lock_ held).
  RollerBlock evaluate_gate_locked() const;
  void safety_check();
  void publish_status();
  // QUESTiX LAB roller input (/roller/lab) and its status (/roller/status)
  void lab_callback(const std_msgs::msg::Float32::SharedPtr msg);
  void lab_tick();
  void publish_roller_status();
  static double steady_now_sec();

  // ---------- Motor control ----------
  bool set_motor_speed(double speed);
  bool send_pulse(int pulse_us, double speed, bool initializing = false);

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

  // The teacher's permission (a practice opt-in; never in competition)
  bool require_teacher_permission_{false};
  std::string teacher_permission_topic_{"/actuation_authority"};
  double teacher_permission_timeout_sec_{1.0};

  // ---------- State ----------
  double current_speed_{0.0};
  bool have_teacher_permission_msg_{false};
  bool teacher_permission_allowed_{false};
  double last_teacher_permission_rx_sec_{0.0};  // steady clock
  RollerBlock gate_{RollerBlock::kEstopUnknown};
  FullSpeedLogic full_speed_logic_;
  RollerLabLogic roller_lab_logic_;
  std::mutex lock_;

  // ---------- PWM ----------
  std::unique_ptr<PwmBackend> pwm_;
  PwmCommand pwm_command_;

  // ---------- ROS I/O ----------
  rclcpp::Subscription<sensor_msgs::msg::Joy>::SharedPtr joy_sub_;
  // /emergency_stop: subscription and state (the shared questix_safety check)
  std::unique_ptr<questix_safety::EmergencyStopMonitor> estop_monitor_;
  // volatile + keep-last(1): the teacher permission is never latched
  rclcpp::Subscription<questix_msgs::msg::ActuationAuthority>::SharedPtr teacher_permission_sub_;
  rclcpp::TimerBase::SharedPtr gate_timer_;
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
