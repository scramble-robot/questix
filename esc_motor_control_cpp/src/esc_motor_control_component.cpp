#include "esc_motor_control_cpp/esc_motor_control_component.hpp"

#include <chrono>
#include <functional>
#include <thread>

using namespace std::chrono_literals;

namespace esc_motor_control_cpp {

EscMotorControlComponent::EscMotorControlComponent(const rclcpp::NodeOptions& options)
    : Node("esc_motor_control", options) {
  // ---- Declare parameters (matching Python version) ----
  this->declare_parameter<int>("pwm_pin", 13);
  this->declare_parameter<double>("max_speed", 1.0);
  this->declare_parameter<double>("min_speed", -1.0);
  this->declare_parameter<bool>("enable_safety_stop", true);
  this->declare_parameter<double>("safety_timeout", 1.0);
  this->declare_parameter<int>("full_speed_button", 3);
  this->declare_parameter<double>("full_speed_value", 1.0);
  this->declare_parameter<bool>("test_mode", false);
  this->declare_parameter<std::string>("joy_topic", "/joy");
  this->declare_parameter<int>("min_pulse_width", 0);         // μs (speed=-1.0)
  this->declare_parameter<int>("max_pulse_width", 2000);      // μs (speed=1.0)
  this->declare_parameter<int>("neutral_pulse_width", 1000);  // μs (ESC arm/idle)
  this->declare_parameter<std::string>("pwm_backend",
                                       "auto");      // "auto","pigpio","lgpio","simulation"
  this->declare_parameter<int>("gpio_chip_num", 4);  // 0=Pi4, 4=Pi5

  // ---- Read parameters ----
  pwm_pin_ = this->get_parameter("pwm_pin").as_int();
  max_speed_ = this->get_parameter("max_speed").as_double();
  min_speed_ = this->get_parameter("min_speed").as_double();
  enable_safety_stop_ = this->get_parameter("enable_safety_stop").as_bool();
  safety_timeout_ = this->get_parameter("safety_timeout").as_double();
  full_speed_button_ = this->get_parameter("full_speed_button").as_int();
  full_speed_value_ = this->get_parameter("full_speed_value").as_double();
  test_mode_ = this->get_parameter("test_mode").as_bool();
  joy_topic_ = this->get_parameter("joy_topic").as_string();
  min_pulse_width_us_ = this->get_parameter("min_pulse_width").as_int();
  max_pulse_width_us_ = this->get_parameter("max_pulse_width").as_int();
  neutral_pulse_width_us_ = this->get_parameter("neutral_pulse_width").as_int();
  pwm_backend_name_ = this->get_parameter("pwm_backend").as_string();
  gpio_chip_num_ = this->get_parameter("gpio_chip_num").as_int();

  // ---- Internal state ----
  last_command_time_ = this->now();

  // ---- QoS ----
  rclcpp::QoS qos_transient(10);
  qos_transient.reliable().transient_local();

  // ---- Subscribers ----
  joy_sub_ = this->create_subscription<sensor_msgs::msg::Joy>(
      joy_topic_, 1,
      std::bind(&EscMotorControlComponent::joy_callback, this, std::placeholders::_1));

  // ---- Publishers ----
  status_pub_ = this->create_publisher<std_msgs::msg::Float32>("motor_status", 10);
  emergency_pub_ = this->create_publisher<std_msgs::msg::Bool>("emergency_status", qos_transient);

  // ---- Timers ----
  status_timer_ =
      this->create_wall_timer(100ms, std::bind(&EscMotorControlComponent::publish_status, this));

  if (enable_safety_stop_) {
    safety_timer_ =
        this->create_wall_timer(100ms, std::bind(&EscMotorControlComponent::safety_check, this));
  }

  // ---- ESC initialisation ----
  initialize_esc();

  RCLCPP_INFO(this->get_logger(), "ESC Motor Control Node (C++) initialized on pin %d", pwm_pin_);
  RCLCPP_INFO(this->get_logger(), "PWM backend: %s", pwm_ ? pwm_->name().c_str() : "none");
  RCLCPP_INFO(this->get_logger(), "Test Mode: %s", test_mode_ ? "true" : "false");
  RCLCPP_INFO(this->get_logger(), "Pulse range: %d - %d μs  (neutral %d μs)", min_pulse_width_us_,
              max_pulse_width_us_, neutral_pulse_width_us_);

  if (!test_mode_ && pwm_ && pwm_->name() != "simulation") {
    RCLCPP_WARN(this->get_logger(),
                "WARNING: Real ESC connected. Ensure propeller is removed and motor is secured!");
  }
}

EscMotorControlComponent::~EscMotorControlComponent() {
  RCLCPP_INFO(this->get_logger(), "Shutting down ESC Motor Control Node...");
  // Stop motor
  set_motor_speed(0.0);
  std::this_thread::sleep_for(500ms);

  // Release PWM
  if (pwm_) {
    pwm_->cleanup();
  }
  RCLCPP_INFO(this->get_logger(), "ESC resources released.");
}

// --------------------------------------------------------------------------
// ESC initialisation
// --------------------------------------------------------------------------
void EscMotorControlComponent::initialize_esc() {
  if (test_mode_) {
    RCLCPP_INFO(this->get_logger(), "Simulation mode (test_mode=true)");
    pwm_ = std::make_unique<SimulationBackend>();
    return;
  }

  // Create PWM backend via factory
  std::string actual_name;
  pwm_ = make_pwm_backend(pwm_backend_name_, gpio_chip_num_, actual_name);

  // Try to initialise hardware
  if (!pwm_->initialize(pwm_pin_)) {
    RCLCPP_FATAL(this->get_logger(), "Failed to initialise PWM backend '%s' on pin %d",
                 actual_name.c_str(), pwm_pin_);
    RCLCPP_FATAL(this->get_logger(),
                 "Falling back to simulation. Check: HOME env, gpio group, device permissions.");
    pwm_ = std::make_unique<SimulationBackend>();
    pwm_->initialize(pwm_pin_);
    return;
  }

  RCLCPP_INFO(this->get_logger(), "=== ESC initialization ===");
  RCLCPP_WARN(this->get_logger(), "Do NOT touch the motor during initialization!");

  // Send neutral pulse to arm the ESC
  int neutral_us = neutral_pulse_width_us_;
  if (neutral_us <= 0) {
    neutral_us = (min_pulse_width_us_ + max_pulse_width_us_) / 2;
  }
  pwm_->set_servo_pulse(pwm_pin_, neutral_us);
  std::this_thread::sleep_for(2s);  // ESC arm wait

  RCLCPP_INFO(this->get_logger(), "ESC initialized. Standing by in neutral.");
}

// --------------------------------------------------------------------------
// Motor control
// --------------------------------------------------------------------------
int EscMotorControlComponent::speed_to_pulse_us(double speed) const {
  // speed ∈ [-1.0, 1.0] → pulse ∈ [min_pulse_width_us_, max_pulse_width_us_]
  // 0.0 → neutral (midpoint)
  double t = (speed + 1.0) / 2.0;  // [0.0, 1.0]
  int pulse =
      min_pulse_width_us_ + static_cast<int>(t * (max_pulse_width_us_ - min_pulse_width_us_));
  return pulse;
}

void EscMotorControlComponent::set_motor_speed(double speed) {
  std::lock_guard<std::mutex> guard(lock_);

  if (emergency_stop_active_) {
    speed = 0.0;
  }

  // Clamp
  speed = std::max(min_speed_, std::min(max_speed_, speed));

  current_speed_ = speed;
  last_command_time_ = this->now();

  if (pwm_ && pwm_->name() != "simulation") {
    int pulse_us = speed_to_pulse_us(speed);
    pwm_->set_servo_pulse(pwm_pin_, pulse_us);
    RCLCPP_DEBUG(this->get_logger(), "ESC speed: %.3f  pulse: %d μs", speed, pulse_us);
  } else {
    RCLCPP_DEBUG(this->get_logger(), "Simulation speed: %.3f", speed);
  }
}

// --------------------------------------------------------------------------
// Joy callback
// --------------------------------------------------------------------------
void EscMotorControlComponent::joy_callback(const sensor_msgs::msg::Joy::SharedPtr msg) {
  if (static_cast<int>(msg->buttons.size()) <= full_speed_button_) {
    return;
  }

  bool full_speed_pressed = (msg->buttons[full_speed_button_] == 1);

  if (full_speed_pressed && !full_speed_active_) {
    RCLCPP_INFO(this->get_logger(), "Full-speed button PRESSED");
    full_speed_active_ = true;
    set_motor_speed(full_speed_value_);

  } else if (!full_speed_pressed && full_speed_active_) {
    RCLCPP_INFO(this->get_logger(), "Full-speed button RELEASED");
    full_speed_active_ = false;
    set_motor_speed(0.0);

  } else if (full_speed_pressed && full_speed_active_) {
    // Held – refresh timestamp to prevent safety timeout
    std::lock_guard<std::mutex> guard(lock_);
    last_command_time_ = this->now();
  }
}

// --------------------------------------------------------------------------
// Safety check
// --------------------------------------------------------------------------
void EscMotorControlComponent::safety_check() {
  if (!enable_safety_stop_) return;

  double elapsed;
  {
    std::lock_guard<std::mutex> guard(lock_);
    elapsed = (this->now() - last_command_time_).seconds();
  }

  if (elapsed > safety_timeout_ && !emergency_stop_active_) {
    RCLCPP_WARN(this->get_logger(), "Safety timeout: stopping motor");
    set_motor_speed(0.0);
  }
}

// --------------------------------------------------------------------------
// Status publishing
// --------------------------------------------------------------------------
void EscMotorControlComponent::publish_status() {
  auto status_msg = std_msgs::msg::Float32();
  status_msg.data = static_cast<float>(current_speed_);
  status_pub_->publish(status_msg);

  auto emergency_msg = std_msgs::msg::Bool();
  emergency_msg.data = emergency_stop_active_;
  emergency_pub_->publish(emergency_msg);
}

}  // namespace esc_motor_control_cpp

#include "rclcpp_components/register_node_macro.hpp"
RCLCPP_COMPONENTS_REGISTER_NODE(esc_motor_control_cpp::EscMotorControlComponent)
