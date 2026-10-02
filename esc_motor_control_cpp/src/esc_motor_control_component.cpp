// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "esc_motor_control_cpp/esc_motor_control_component.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <functional>
#include <thread>

#include "esc_motor_control_cpp/estop_logic.hpp"

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
  this->declare_parameter<int>("full_speed_button", 7);
  this->declare_parameter<double>("full_speed_value", 1.0);
  this->declare_parameter<bool>("test_mode", false);
  this->declare_parameter<std::string>("joy_topic", "/joy");
  this->declare_parameter<std::string>("status_topic", "/roller_motor_status");
  // 統一緊急停止トピック（questix_msgs/EmergencyStop, 入力）。空文字で連動無効。
  this->declare_parameter<std::string>("emergency_stop_topic", "/emergency_stop");
  this->declare_parameter<int>("min_pulse_width", 0);         // μs (speed=-1.0)
  this->declare_parameter<int>("max_pulse_width", 2000);      // μs (speed=1.0)
  this->declare_parameter<int>("neutral_pulse_width", 1000);  // μs (ESC arm/idle)
  this->declare_parameter<std::string>("pwm_backend",
                                       "auto");      // "auto","pigpio","lgpio","simulation"
  this->declare_parameter<int>("gpio_chip_num", 4);  // 0=Pi4, 4=Pi5
  // QUESTiX LAB roller input. Only practice launches set accept_lab_input=true.
  this->declare_parameter<bool>("accept_lab_input", false);
  this->declare_parameter<std::string>("lab_topic", "/roller/lab");
  this->declare_parameter<double>("lab_max_speed", 0.8);
  this->declare_parameter<double>("lab_joy_quiet_sec", 1.0);

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
  status_topic_ = this->get_parameter("status_topic").as_string();
  emergency_stop_topic_ = this->get_parameter("emergency_stop_topic").as_string();
  min_pulse_width_us_ = this->get_parameter("min_pulse_width").as_int();
  max_pulse_width_us_ = this->get_parameter("max_pulse_width").as_int();
  neutral_pulse_width_us_ = this->get_parameter("neutral_pulse_width").as_int();
  pwm_backend_name_ = this->get_parameter("pwm_backend").as_string();
  gpio_chip_num_ = this->get_parameter("gpio_chip_num").as_int();
  accept_lab_input_ = this->get_parameter("accept_lab_input").as_bool();
  lab_topic_ = this->get_parameter("lab_topic").as_string();
  lab_max_speed_ = this->get_parameter("lab_max_speed").as_double();
  lab_joy_quiet_sec_ = this->get_parameter("lab_joy_quiet_sec").as_double();

  // ---- Internal state ----
  full_speed_logic_.configure(safety_timeout_);
  RollerLabLogic::Config lab_config;
  lab_config.accept = accept_lab_input_ && !lab_topic_.empty();
  lab_config.max_speed = lab_max_speed_;
  lab_config.joy_quiet_sec = lab_joy_quiet_sec_;
  // Lab commands expire after safety_timeout even with enable_safety_stop=false.
  lab_config.timeout_sec = safety_timeout_;
  roller_lab_logic_.configure(lab_config);
  if (lab_config.accept &&
      (!std::isfinite(lab_max_speed_) || lab_max_speed_ < 0.0 || lab_max_speed_ > 1.0)) {
    RCLCPP_WARN(this->get_logger(), "lab_max_speed=%g is outside [0, 1]; using %.2f",
                lab_max_speed_, roller_lab_logic_.config().max_speed);
  }

  // ---- Subscribers ----
  joy_sub_ = this->create_subscription<sensor_msgs::msg::Joy>(
      joy_topic_, 1,
      std::bind(&EscMotorControlComponent::joy_callback, this, std::placeholders::_1));

  // 統一緊急停止トピック。transient_local なので起動時に最新のラッチ状態を受信する
  // （契約: questix_msgs/README.md）。
  if (!emergency_stop_topic_.empty()) {
    emergency_stop_sub_ = this->create_subscription<questix_msgs::msg::EmergencyStop>(
        emergency_stop_topic_, rclcpp::QoS(1).reliable().transient_local(),
        std::bind(&EscMotorControlComponent::emergency_stop_callback, this, std::placeholders::_1));
  }

  // QUESTiX LAB roller input: subscribed only when accept_lab_input (practice launches).
  if (roller_lab_logic_.config().accept) {
    lab_sub_ = this->create_subscription<std_msgs::msg::Float32>(
        lab_topic_, 1,
        std::bind(&EscMotorControlComponent::lab_callback, this, std::placeholders::_1));
  }

  // ---- Publishers ----
  status_pub_ = this->create_publisher<std_msgs::msg::Float32>(status_topic_, 10);
  roller_status_pub_ = this->create_publisher<std_msgs::msg::String>("/roller/status", 10);

  // ---- Timers ----
  status_timer_ =
      this->create_wall_timer(100ms, std::bind(&EscMotorControlComponent::publish_status, this));

  if (enable_safety_stop_) {
    safety_timer_ =
        this->create_wall_timer(100ms, std::bind(&EscMotorControlComponent::safety_check, this));
  }
  roller_status_timer_ = this->create_wall_timer(
      200ms, std::bind(&EscMotorControlComponent::publish_roller_status, this));
  if (lab_sub_) {
    lab_timer_ =
        this->create_wall_timer(100ms, std::bind(&EscMotorControlComponent::lab_tick, this));
  }

  // ---- ESC initialisation ----
  initialize_esc();

  RCLCPP_INFO(this->get_logger(), "ESC Motor Control Node (C++) initialized on pin %d", pwm_pin_);
  RCLCPP_INFO(this->get_logger(), "PWM backend: %s", pwm_ ? pwm_->name().c_str() : "none");
  RCLCPP_INFO(this->get_logger(), "Test Mode: %s", test_mode_ ? "true" : "false");
  RCLCPP_INFO(this->get_logger(), "Status topic: %s", status_topic_.c_str());
  RCLCPP_INFO(this->get_logger(), "Pulse range: %d - %d μs  (neutral %d μs)", min_pulse_width_us_,
              max_pulse_width_us_, neutral_pulse_width_us_);
  if (lab_sub_) {
    RCLCPP_INFO(this->get_logger(),
                "QUESTiX LAB roller input on %s (max %.2f, joy quiet %.1f s, timeout %.1f s)",
                lab_topic_.c_str(), roller_lab_logic_.config().max_speed,
                roller_lab_logic_.config().joy_quiet_sec, roller_lab_logic_.config().timeout_sec);
  } else {
    RCLCPP_INFO(this->get_logger(), "QUESTiX LAB roller input disabled (accept_lab_input=false)");
  }

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
  if (full_speed_button_ < 0 || static_cast<size_t>(full_speed_button_) >= msg->buttons.size()) {
    return;
  }

  FullSpeedLogic::Result r;
  bool lab_preempted = false;
  {
    std::lock_guard<std::mutex> guard(lock_);
    const bool raw_pressed = msg->buttons[full_speed_button_] == 1;
    // The controller always wins: a press hands a lab-driven roller back to the controller
    // and locks the lab out until it sends 0 (roller_lab_logic.hpp).
    lab_preempted = roller_lab_logic_.onJoyButton(raw_pressed, steady_now_sec());
    // 非常停止中はボタンを離した扱いにして、ラッチが armed になるのを防ぐ。
    // （解除後に押しっぱなしのまま再始動しないようにする。復帰には離す→押すが必要。）
    const bool full_speed_pressed = raw_pressed && !emergency_stop_active_;
    r = full_speed_logic_.onButton(full_speed_pressed, this->now().seconds());
  }
  // Lock released before set_motor_speed(), which takes lock_ itself.

  if (lab_preempted) {
    RCLCPP_WARN(this->get_logger(), "Controller took over the roller from QUESTiX LAB");
    set_motor_speed(0.0);
    publish_roller_status();
  }
  if (r.start_full_speed) {
    RCLCPP_INFO(this->get_logger(), "Full-speed button PRESSED");
    set_motor_speed(full_speed_value_);
  } else if (r.stop) {
    RCLCPP_INFO(this->get_logger(), "Full-speed button RELEASED");
    set_motor_speed(0.0);
  } else if (r.ignored_press) {
    RCLCPP_INFO_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                         "Full-speed press ignored after safety timeout: release and press again");
  }
}

// --------------------------------------------------------------------------
// Emergency stop callback
// --------------------------------------------------------------------------
void EscMotorControlComponent::emergency_stop_callback(
    const questix_msgs::msg::EmergencyStop::SharedPtr msg) {
  if (!msg) {
    return;
  }

  EstopTransition transition;
  {
    std::lock_guard<std::mutex> guard(lock_);
    // set_motor_speed() は lock_ を取り直すため、ここでは保持したまま呼ばない。
    // 保持したまま呼ぶとデッドロックする。フラグ更新だけ行い、停止指令はロック解放後。
    transition = decideEstopTransition(emergency_stop_active_, msg->active);
    emergency_stop_active_ = msg->active;
    if (transition.send_stop) {
      roller_lab_logic_.onEmergencyStop(true, steady_now_sec());
    }
  }

  if (transition.send_stop) {
    RCLCPP_WARN(this->get_logger(), "非常停止を受信 (source=%s, reason=%s)。モータを停止します",
                msg->source.c_str(), msg->reason.c_str());
    set_motor_speed(0.0);
  } else if (transition.log_release) {
    RCLCPP_INFO(this->get_logger(),
                "非常停止が解除されました (source=%s)。フルスピードボタンの再押下まで停止のまま",
                msg->source.c_str());
  }
  if (transition.send_stop || transition.log_release) {
    publish_roller_status();
  }
}

// --------------------------------------------------------------------------
// QUESTiX LAB roller input
// --------------------------------------------------------------------------
double EscMotorControlComponent::steady_now_sec() {
  return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

void EscMotorControlComponent::lab_callback(const std_msgs::msg::Float32::SharedPtr msg) {
  if (!msg) {
    return;
  }
  RollerLabLogic::LabDecision decision;
  bool source_changed = false;
  {
    std::lock_guard<std::mutex> guard(lock_);
    const bool was_active = roller_lab_logic_.labActive();
    decision = roller_lab_logic_.onLab(msg->data, steady_now_sec(), full_speed_logic_.isActive(),
                                       emergency_stop_active_);
    source_changed = was_active != roller_lab_logic_.labActive();
  }
  // Lock released before set_motor_speed(), which takes lock_ itself.

  if (decision.apply) {
    set_motor_speed(decision.command);
  } else if (decision.refusal != RollerLabLogic::Refusal::kNone) {
    RCLCPP_INFO_THROTTLE(this->get_logger(), *this->get_clock(), 2000,
                         "QUESTiX LAB roller command refused: %s",
                         RollerLabLogic::refusalName(decision.refusal));
  }
  if (source_changed) {
    RCLCPP_INFO(this->get_logger(), "QUESTiX LAB roller %s",
                decision.apply && decision.command > 0.0 ? "started" : "stopped");
    publish_roller_status();
  }
}

void EscMotorControlComponent::lab_tick() {
  bool timed_out = false;
  {
    std::lock_guard<std::mutex> guard(lock_);
    timed_out = roller_lab_logic_.onTick(steady_now_sec());
  }
  if (timed_out) {
    RCLCPP_WARN(this->get_logger(), "QUESTiX LAB roller command timed out: stopping the roller");
    set_motor_speed(0.0);
    publish_roller_status();
  }
}

void EscMotorControlComponent::publish_roller_status() {
  RollerStatus status;
  {
    std::lock_guard<std::mutex> guard(lock_);
    status.command = current_speed_;
    status.source = roller_lab_logic_.sourceName(full_speed_logic_.isActive());
    status.lab_accepted = roller_lab_logic_.config().accept;
    status.lab_locked = roller_lab_logic_.labLocked();
    status.estop = emergency_stop_active_;
    status.lab_max_speed = roller_lab_logic_.config().max_speed;
  }
  std_msgs::msg::String msg;
  msg.data = rollerStatusJson(status);
  roller_status_pub_->publish(msg);
}

// --------------------------------------------------------------------------
// Safety check
// --------------------------------------------------------------------------
void EscMotorControlComponent::safety_check() {
  if (!enable_safety_stop_) return;

  FullSpeedLogic::Result r;
  {
    std::lock_guard<std::mutex> guard(lock_);
    r = full_speed_logic_.onTimerCheck(this->now().seconds());
  }
  // Lock released before set_motor_speed(), which takes lock_ itself.

  if (r.timed_out) {
    RCLCPP_WARN(this->get_logger(), "Safety timeout: stopping motor");
  }
  if (r.stop && !emergency_stop_active_) {
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
}

}  // namespace esc_motor_control_cpp

#include "rclcpp_components/register_node_macro.hpp"
RCLCPP_COMPONENTS_REGISTER_NODE(esc_motor_control_cpp::EscMotorControlComponent)
