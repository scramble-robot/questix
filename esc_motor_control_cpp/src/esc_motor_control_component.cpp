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
  // /launcher_command older than this stops the roller (a level the publisher repeats while in
  // use).
  this->declare_parameter<double>("safety_timeout", 1.0);
  this->declare_parameter<bool>("test_mode", false);
  // questix_msgs/LauncherCommand: joy_launcher, or command_arbiter in a lesson launch.
  this->declare_parameter<std::string>("launcher_command_topic", "/launcher_command");
  this->declare_parameter<std::string>("status_topic", "/roller_motor_status");
  // 統一緊急停止トピック（questix_msgs/EmergencyStop, 入力）。空文字で連動無効。
  this->declare_parameter<std::string>("emergency_stop_topic", "/emergency_stop");
  // 未受信・途絶の /emergency_stop を押下と同じに扱う（false は単体診断の明示 opt-out のみ）。
  this->declare_parameter<bool>("require_emergency_stop", true);
  // 一度受信した後、この秒数（steady clock の受信間隔）途絶えたら停止。<=0 で無効。
  this->declare_parameter<double>("emergency_stop_timeout_sec", 1.0);
  // 走行許可（L2、questix_msgs/MotionPermission の launcher_allowed）。非常停止とは別の概念で、
  // 未受信・途絶・false はローラーを 0 にする。false は単体診断の明示 opt-out だけ。
  this->declare_parameter<std::string>("motion_permission_topic", "/motion_permission");
  this->declare_parameter<bool>("require_motion_permission", true);
  this->declare_parameter<double>("motion_permission_timeout_sec", 0.5);
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
  safety_timeout_ = this->get_parameter("safety_timeout").as_double();
  test_mode_ = this->get_parameter("test_mode").as_bool();
  launcher_command_topic_ = this->get_parameter("launcher_command_topic").as_string();
  status_topic_ = this->get_parameter("status_topic").as_string();
  min_pulse_width_us_ = this->get_parameter("min_pulse_width").as_int();
  max_pulse_width_us_ = this->get_parameter("max_pulse_width").as_int();
  neutral_pulse_width_us_ = this->get_parameter("neutral_pulse_width").as_int();
  pwm_backend_name_ = this->get_parameter("pwm_backend").as_string();
  gpio_chip_num_ = this->get_parameter("gpio_chip_num").as_int();

  // ---- Internal state ----
  // The roller never reverses from a command: [0, max_speed].
  command_logic_.configure(safety_timeout_, max_speed_);
  if (command_logic_.timeoutSec() != safety_timeout_) {
    RCLCPP_WARN(this->get_logger(), "safety_timeout=%g is not usable; using %.1f s",
                safety_timeout_, command_logic_.timeoutSec());
  }

  // ---- Subscribers ----
  // reliable + volatile + keep-last(1) (questix_msgs/msg/LauncherCommand.msg).
  command_sub_ = this->create_subscription<questix_msgs::msg::LauncherCommand>(
      launcher_command_topic_, rclcpp::QoS(1).reliable().durability_volatile(),
      std::bind(&EscMotorControlComponent::command_callback, this, std::placeholders::_1));

  // 統一緊急停止トピックは共通の EmergencyStopMonitor（questix_safety）が購読・判定する
  // （transient_local なので起動時に最新のラッチ状態を受信する。契約: questix_msgs/README.md）。
  estop_monitor_ = std::make_unique<questix_safety::EmergencyStopMonitor>(
      *this, questix_safety::EmergencyStopMonitor::declareAndRead(*this), "roller",
      [this](const questix_msgs::msg::EmergencyStop& msg,
             const questix_safety::EmergencyStopMonitor::Change& change) {
        on_emergency_stop(msg, change);
      });
  // 走行許可（L2）も共通の PermissionMonitor が購読・判定する（volatile、ラッチしない）。
  permission_monitor_ = std::make_unique<questix_safety::PermissionMonitor>(
      *this, questix_safety::PermissionMonitor::declareAndRead(*this),
      questix_safety::PermissionMonitor::Flag::kLauncher, "roller",
      [this](const questix_msgs::msg::MotionPermission& msg,
             const questix_safety::PermissionMonitor::Change& change) {
        on_motion_permission(msg, change);
      });

  // ---- Publishers ----
  status_pub_ = this->create_publisher<std_msgs::msg::Float32>(status_topic_, 10);
  roller_status_pub_ = this->create_publisher<std_msgs::msg::String>("/roller/status", 10);

  // ---- Timers ----
  status_timer_ =
      this->create_wall_timer(100ms, std::bind(&EscMotorControlComponent::publish_status, this));

  command_timer_ =
      this->create_wall_timer(100ms, std::bind(&EscMotorControlComponent::command_tick, this));
  publisher_timer_ =
      this->create_wall_timer(500ms, std::bind(&EscMotorControlComponent::check_publishers, this));
  roller_status_timer_ = this->create_wall_timer(
      200ms, std::bind(&EscMotorControlComponent::publish_roller_status, this));
  // The gate as it starts (nothing heard yet), so the first change is logged against it.
  {
    std::lock_guard<std::mutex> guard(lock_);
    gate_ = evaluate_gate_locked();
  }
  // Leases (E-stop silence, the motion permission) expire without a message: check them
  // periodically.
  gate_timer_ =
      this->create_wall_timer(100ms, std::bind(&EscMotorControlComponent::apply_gate, this));

  // ---- ESC initialisation ----
  initialize_esc();

  RCLCPP_INFO(this->get_logger(), "ESC Motor Control Node (C++) initialized on pin %d", pwm_pin_);
  RCLCPP_INFO(this->get_logger(), "PWM backend: %s", pwm_ ? pwm_->name().c_str() : "none");
  RCLCPP_INFO(this->get_logger(), "Test Mode: %s", test_mode_ ? "true" : "false");
  RCLCPP_INFO(this->get_logger(), "Status topic: %s", status_topic_.c_str());
  RCLCPP_INFO(this->get_logger(), "Pulse range: %d - %d μs  (neutral %d μs)", min_pulse_width_us_,
              max_pulse_width_us_, neutral_pulse_width_us_);
  RCLCPP_INFO(this->get_logger(), "Roller command: %s (timeout %.1f s, max %.2f)",
              launcher_command_topic_.c_str(), command_logic_.timeoutSec(),
              command_logic_.maxPower());

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

  // Evaluated now, not from the last timer tick: nothing nonzero leaves while the gate is closed.
  if (evaluate_gate_locked() != RollerBlock::kNone) {
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
// Roller command (/launcher_command)
// --------------------------------------------------------------------------
void EscMotorControlComponent::command_callback(
    const questix_msgs::msg::LauncherCommand::SharedPtr msg) {
  if (!msg) {
    return;
  }
  RollerCommandLogic::Result result;
  bool source_changed = false;
  {
    std::lock_guard<std::mutex> guard(lock_);
    // While the gate is closed (no motion permission, E-stop not released), and while two nodes
    // publish the command, the roller stays at 0 and needs a 0 command before it spins again
    // (roller_command_logic.hpp).
    const bool inhibited = evaluate_gate_locked() != RollerBlock::kNone || multiple_publishers_;
    result = command_logic_.onCommand(msg->roller_power, steady_now_sec(), inhibited);
    const char* source = command_logic_.speed() > 0.0 ? rollerSourceName(msg->source) : "idle";
    source_changed = source != command_source_;
    command_source_ = source;
  }
  // Lock released before set_motor_speed(), which takes lock_ itself.
  if (result.set) {
    set_motor_speed(result.speed);
  } else if (result.needs_zero) {
    RCLCPP_INFO_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                         "Roller command ignored until a 0 arrives (release the button, or end "
                         "the lesson run, and start again)");
  }
  if (source_changed) {
    publish_roller_status();
  }
}

void EscMotorControlComponent::command_tick() {
  RollerCommandLogic::Result result;
  {
    std::lock_guard<std::mutex> guard(lock_);
    result = command_logic_.onTick(steady_now_sec());
    if (result.set) {
      command_source_ = "idle";
    }
  }
  if (result.timed_out) {
    RCLCPP_WARN(this->get_logger(), "Roller command timed out (%s silent): stopping the roller",
                launcher_command_topic_.c_str());
  }
  if (result.set) {
    set_motor_speed(result.speed);
    publish_roller_status();
  }
}

// --------------------------------------------------------------------------
// Emergency stop callback
// --------------------------------------------------------------------------
void EscMotorControlComponent::on_emergency_stop(
    const questix_msgs::msg::EmergencyStop& msg,
    const questix_safety::EmergencyStopMonitor::Change& change) {
  EstopTransition transition;
  {
    std::lock_guard<std::mutex> guard(lock_);
    // set_motor_speed() は lock_ を取り直すため、ここでは保持したまま呼ばない。
    // 保持したまま呼ぶとデッドロックする。フラグ更新だけ行い、停止指令はロック解放後。
    // 初回受信の前は「解除」から見た変化として扱う（初回の押下で停止、初回の解除はログのみ）。
    transition = decideEstopTransition(change.first ? false : change.was_active, msg.active);
    if (transition.send_stop) {
      command_logic_.inhibit();
      command_source_ = "idle";
    }
  }

  if (transition.send_stop) {
    RCLCPP_WARN(this->get_logger(), "非常停止を受信 (source=%s, reason=%s)。モータを停止します",
                msg.source.c_str(), msg.reason.c_str());
    set_motor_speed(0.0);
  } else if (transition.log_release) {
    RCLCPP_INFO(this->get_logger(),
                "非常停止が解除されました (source=%s)。0 の指令を受けてから回転を再開します",
                msg.source.c_str());
  }
  if (transition.send_stop || transition.log_release) {
    publish_roller_status();
  }
  apply_gate();
}

void EscMotorControlComponent::on_motion_permission(
    const questix_msgs::msg::MotionPermission& msg,
    const questix_safety::PermissionMonitor::Change& change) {
  if (change.first || change.was_allowed != msg.launcher_allowed) {
    RCLCPP_INFO(this->get_logger(), "Motion permission (%s): roller %s", msg.mode.c_str(),
                msg.launcher_allowed ? "allowed" : "not allowed");
  }
  apply_gate();
}

RollerBlock EscMotorControlComponent::evaluate_gate_locked() const {
  RollerGateInputs in;
  in.permission = permission_monitor_->inputs();
  in.estop = estop_monitor_->inputs();
  return evaluateRollerGate(in);
}

void EscMotorControlComponent::apply_gate() {
  RollerBlock previous = RollerBlock::kNone;
  RollerBlock now_block = RollerBlock::kNone;
  bool stop = false;
  {
    std::lock_guard<std::mutex> guard(lock_);
    previous = gate_;
    now_block = evaluate_gate_locked();
    gate_ = now_block;
    if (now_block != RollerBlock::kNone) {
      // Closing (or closed with something still spinning): stop, and require a 0 command
      // before the roller spins again (a held button, a lesson heartbeat).
      if (previous == RollerBlock::kNone || current_speed_ != 0.0 || command_logic_.speed() > 0.0) {
        command_logic_.inhibit();
        command_source_ = "idle";
        stop = true;
      }
    }
  }
  // Lock released before set_motor_speed(), which takes lock_ itself.
  if (stop) {
    set_motor_speed(0.0);
  }
  if (now_block != previous) {
    if (now_block == RollerBlock::kNone) {
      RCLCPP_INFO(this->get_logger(),
                  "Roller allowed again (was %s): it spins after a 0 command and a new one",
                  rollerBlockName(previous));
    } else {
      RCLCPP_WARN(this->get_logger(), "Roller blocked: %s (was %s); roller at 0",
                  rollerBlockName(now_block), rollerBlockName(previous));
    }
    publish_roller_status();
  }
}

void EscMotorControlComponent::check_publishers() {
  const auto publishers = this->get_publishers_info_by_topic(launcher_command_topic_);
  const bool multiple = publishers.size() > 1;
  RollerCommandLogic::Result result;
  bool changed = false;
  {
    std::lock_guard<std::mutex> guard(lock_);
    changed = multiple != multiple_publishers_;
    multiple_publishers_ = multiple;
    if (multiple) {
      result = command_logic_.inhibit();
      if (result.set) {
        command_source_ = "idle";
      }
    }
  }
  if (changed && multiple) {
    std::string names;
    for (const auto& info : publishers) {
      const std::string& ns = info.node_namespace();
      names += (names.empty() ? "" : ", ") + (ns == "/" ? "" : ns) + "/" + info.node_name();
    }
    RCLCPP_ERROR(this->get_logger(),
                 "%zu nodes publish %s (%s): the roller stays at 0 until only one is left",
                 publishers.size(), launcher_command_topic_.c_str(), names.c_str());
  } else if (changed) {
    RCLCPP_INFO(this->get_logger(), "One publisher on %s again (a 0 is needed before spinning)",
                launcher_command_topic_.c_str());
  }
  if (result.set) {
    set_motor_speed(result.speed);
    publish_roller_status();
  }
}

double EscMotorControlComponent::steady_now_sec() {
  return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

void EscMotorControlComponent::publish_roller_status() {
  RollerStatus status;
  {
    std::lock_guard<std::mutex> guard(lock_);
    status.command = current_speed_;
    status.source = current_speed_ > 0.0 ? command_source_ : "idle";
    const RollerBlock block = evaluate_gate_locked();
    status.estop = isRollerEstopBlock(block);
    status.permission = !isRollerPermissionBlock(block);
    status.max_power = command_logic_.maxPower();
  }
  std_msgs::msg::String msg;
  msg.data = rollerStatusJson(status);
  roller_status_pub_->publish(msg);
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
