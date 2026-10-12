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

#include "esc_motor_control_cpp/pwm_backend.hpp"
#include "esc_motor_control_cpp/roller_command_logic.hpp"
#include "esc_motor_control_cpp/roller_gate.hpp"
#include "questix_msgs/msg/emergency_stop.hpp"
#include "questix_msgs/msg/launcher_command.hpp"
#include "questix_msgs/msg/motion_permission.hpp"
#include "questix_safety/emergency_stop_monitor.hpp"
#include "questix_safety/permission_monitor.hpp"
#include "rclcpp/rclcpp.hpp"
#include "std_msgs/msg/float32.hpp"
#include "std_msgs/msg/string.hpp"

namespace esc_motor_control_cpp {

// The roller follows /launcher_command roller_power (questix_msgs/LauncherCommand: joy_launcher in
// practice and competition, command_arbiter's choice of the controller or QUESTiX LAB in a lesson;
// roller_command_logic.hpp) and spins only while roller_gate.hpp says so: the motion permission
// (L2, /motion_permission launcher_allowed: the referee, the teacher, or always in practice) is
// fresh and allows it, and the E-stop (L1) is known and released (require_emergency_stop; unknown
// and silent count as pressed, and operation_manager always publishes it in questix_core). When it
// closes the roller goes to 0 and needs a 0 command before it spins again; nothing restarts by
// itself. The node reads no /joy and no QUESTiX LAB topic.
class EscMotorControlComponent : public rclcpp::Node {
public:
  explicit EscMotorControlComponent(const rclcpp::NodeOptions& options);
  ~EscMotorControlComponent() override;

private:
  // ---------- Initialisation ----------
  void initialize_esc();

  // ---------- Callbacks ----------
  void command_callback(const questix_msgs::msg::LauncherCommand::SharedPtr msg);
  // A spinning roller whose commands stopped for safety_timeout is stopped.
  void command_tick();
  // More than one node on launcher_command_topic: their counters and levels would mix (one
  // publisher's 0 and the other's power in turn), so the roller stops until only one is left.
  void check_publishers();
  // /emergency_stop を受信したとき（estop_monitor_ から呼ばれる）。
  void on_emergency_stop(const questix_msgs::msg::EmergencyStop& msg,
                         const questix_safety::EmergencyStopMonitor::Change& change);
  // /motion_permission を受信したとき（permission_monitor_ から呼ばれる）。
  void on_motion_permission(const questix_msgs::msg::MotionPermission& msg,
                            const questix_safety::PermissionMonitor::Change& change);
  // Re-evaluates the gate (100 ms timer and every E-stop / permission message); on closing it stops
  // the roller and requires a 0 command before it spins again.
  void apply_gate();
  // The current gate (lock_ held).
  RollerBlock evaluate_gate_locked() const;
  void publish_status();
  // The mechanism's state on /roller/status.
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
  double safety_timeout_;
  bool test_mode_;
  std::string launcher_command_topic_;
  std::string status_topic_;
  int min_pulse_width_us_;
  int max_pulse_width_us_;
  int neutral_pulse_width_us_;
  std::string pwm_backend_name_;  // "auto", "pigpio", "lgpio", "simulation"
  int gpio_chip_num_;             // lgpio chip number

  // ---------- State ----------
  double current_speed_{0.0};
  RollerBlock gate_{RollerBlock::kEstopUnknown};
  RollerCommandLogic command_logic_;
  // The source of the last command (rollerSourceName), shown in /roller/status while spinning.
  const char* command_source_{"idle"};
  // More than one publisher on launcher_command_topic (check_publishers).
  bool multiple_publishers_{false};
  std::mutex lock_;

  // ---------- PWM ----------
  std::unique_ptr<PwmBackend> pwm_;

  // ---------- ROS I/O ----------
  rclcpp::Subscription<questix_msgs::msg::LauncherCommand>::SharedPtr command_sub_;
  // /emergency_stop: subscription and state (the shared questix_safety check)
  std::unique_ptr<questix_safety::EmergencyStopMonitor> estop_monitor_;
  // /motion_permission (launcher_allowed): subscription and state (the shared questix_safety
  // check; volatile + keep-last(1), never latched)
  std::unique_ptr<questix_safety::PermissionMonitor> permission_monitor_;
  rclcpp::TimerBase::SharedPtr gate_timer_;
  rclcpp::Publisher<std_msgs::msg::Float32>::SharedPtr status_pub_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr roller_status_pub_;
  rclcpp::TimerBase::SharedPtr roller_status_timer_;
  rclcpp::TimerBase::SharedPtr status_timer_;
  rclcpp::TimerBase::SharedPtr command_timer_;
  rclcpp::TimerBase::SharedPtr publisher_timer_;
};

}  // namespace esc_motor_control_cpp

#endif  // ESC_MOTOR_CONTROL_CPP__ESC_MOTOR_CONTROL_COMPONENT_HPP_
