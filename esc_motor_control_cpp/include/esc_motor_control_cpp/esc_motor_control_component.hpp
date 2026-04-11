#ifndef ESC_MOTOR_CONTROL_CPP__ESC_MOTOR_CONTROL_COMPONENT_HPP_
#define ESC_MOTOR_CONTROL_CPP__ESC_MOTOR_CONTROL_COMPONENT_HPP_

#include <memory>
#include <mutex>
#include <string>

#include "esc_motor_control_cpp/pwm_backend.hpp"
#include "rclcpp/rclcpp.hpp"
#include "sensor_msgs/msg/joy.hpp"
#include "std_msgs/msg/bool.hpp"
#include "std_msgs/msg/float32.hpp"

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
  void safety_check();
  void publish_status();

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
  int min_pulse_width_us_;
  int max_pulse_width_us_;
  int neutral_pulse_width_us_;
  std::string pwm_backend_name_;  // "auto", "pigpio", "lgpio", "simulation"
  int gpio_chip_num_;             // lgpio chip number

  // ---------- State ----------
  double current_speed_{0.0};
  bool emergency_stop_active_{false};
  bool full_speed_active_{false};
  rclcpp::Time last_command_time_;
  std::mutex lock_;

  // ---------- PWM ----------
  std::unique_ptr<PwmBackend> pwm_;

  // ---------- ROS I/O ----------
  rclcpp::Subscription<sensor_msgs::msg::Joy>::SharedPtr joy_sub_;
  rclcpp::Publisher<std_msgs::msg::Float32>::SharedPtr status_pub_;
  rclcpp::Publisher<std_msgs::msg::Bool>::SharedPtr emergency_pub_;
  rclcpp::TimerBase::SharedPtr status_timer_;
  rclcpp::TimerBase::SharedPtr safety_timer_;
};

}  // namespace esc_motor_control_cpp

#endif  // ESC_MOTOR_CONTROL_CPP__ESC_MOTOR_CONTROL_COMPONENT_HPP_
