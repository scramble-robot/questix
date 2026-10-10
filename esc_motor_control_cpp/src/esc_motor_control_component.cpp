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
#include <stdexcept>
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
  // 未受信・途絶の /emergency_stop を押下と同じに扱う（false は単体診断の明示 opt-out のみ）。
  this->declare_parameter<bool>("require_emergency_stop", true);
  // 一度受信した後、この秒数（steady clock の受信間隔）途絶えたら停止。<=0 で無効。
  this->declare_parameter<double>("emergency_stop_timeout_sec", 1.0);
  // 教員の許可（questix_msgs/ActuationAuthority の launcher_allowed）。非常停止とは別の
  // 概念で、練習での opt-in（既定 false）。大会起動（enable_autoreferee）では常に false。
  this->declare_parameter<bool>("require_teacher_permission", false);
  this->declare_parameter<std::string>("teacher_permission_topic", "/actuation_authority");
  this->declare_parameter<double>("teacher_permission_timeout_sec", 1.0);
  this->declare_parameter<int>("min_pulse_width", 0);         // μs (speed=-1.0)
  this->declare_parameter<int>("max_pulse_width", 2000);      // μs (speed=1.0)
  this->declare_parameter<int>("neutral_pulse_width", 1000);  // μs (ESC arm/idle)
  this->declare_parameter<std::string>("pwm_backend",
                                       "auto");  // "auto","pigpio","lgpio","simulation"
  this->declare_parameter<std::string>("rp1_guard_socket", "/run/questix_pwm_guard/control.sock");
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
  require_teacher_permission_ = this->get_parameter("require_teacher_permission").as_bool();
  teacher_permission_topic_ = this->get_parameter("teacher_permission_topic").as_string();
  teacher_permission_timeout_sec_ = rollerTeacherPermissionLease(
      this->get_parameter("teacher_permission_timeout_sec").as_double());
  min_pulse_width_us_ = this->get_parameter("min_pulse_width").as_int();
  max_pulse_width_us_ = this->get_parameter("max_pulse_width").as_int();
  neutral_pulse_width_us_ = this->get_parameter("neutral_pulse_width").as_int();
  pwm_backend_name_ = this->get_parameter("pwm_backend").as_string();
  rp1_guard_socket_ = this->get_parameter("rp1_guard_socket").as_string();
  gpio_chip_num_ = this->get_parameter("gpio_chip_num").as_int();
  accept_lab_input_ = this->get_parameter("accept_lab_input").as_bool();
  lab_topic_ = this->get_parameter("lab_topic").as_string();
  lab_max_speed_ = this->get_parameter("lab_max_speed").as_double();
  lab_joy_quiet_sec_ = this->get_parameter("lab_joy_quiet_sec").as_double();

  if (pwm_backend_name_ == "rp1_hw" && !test_mode_) {
    if (pwm_pin_ != 13 || min_pulse_width_us_ != 0 || max_pulse_width_us_ != 2000 ||
        neutral_pulse_width_us_ != 1000 || !enable_safety_stop_ ||
        !std::isfinite(safety_timeout_) || safety_timeout_ <= 0 || safety_timeout_ > 1.0 ||
        !std::isfinite(min_speed_) || !std::isfinite(max_speed_) || min_speed_ < -1.0 ||
        max_speed_ > 1.0 || min_speed_ > 0 || max_speed_ < 0 || !std::isfinite(full_speed_value_) ||
        full_speed_value_ < 0 || full_speed_value_ > 1) {
      throw std::invalid_argument(
          "rp1_hw requires GPIO13, 0/2000/1000 us and a safety timeout in (0,1]");
    }
  }

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

  // 統一緊急停止トピックは共通の EmergencyStopMonitor（questix_safety）が購読・判定する
  // （transient_local なので起動時に最新のラッチ状態を受信する。契約: questix_msgs/README.md）。
  estop_monitor_ = std::make_unique<questix_safety::EmergencyStopMonitor>(
      *this, questix_safety::EmergencyStopMonitor::declareAndRead(*this), "roller",
      [this](const questix_msgs::msg::EmergencyStop& msg,
             const questix_safety::EmergencyStopMonitor::Change& change) {
        on_emergency_stop(msg, change);
      });
  if (require_teacher_permission_) {
    if (teacher_permission_topic_.empty()) {
      RCLCPP_ERROR(this->get_logger(),
                   "teacher_permission_topic is empty but require_teacher_permission=true: "
                   "the roller will never spin");
    } else {
      teacher_permission_sub_ = this->create_subscription<questix_msgs::msg::ActuationAuthority>(
          teacher_permission_topic_, rclcpp::QoS(1).reliable().durability_volatile(),
          std::bind(&EscMotorControlComponent::teacher_permission_callback, this,
                    std::placeholders::_1));
    }
    RCLCPP_INFO(this->get_logger(),
                "Teacher permission required on %s (lease %.2fs): the roller stays at 0 "
                "until the teacher switches the launcher on",
                teacher_permission_topic_.c_str(), teacher_permission_timeout_sec_);
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
  // The gate as it starts (nothing heard yet), so the first change is logged against it.
  {
    std::lock_guard<std::mutex> guard(lock_);
    gate_ = evaluate_gate_locked();
  }
  // Leases (E-stop silence, teacher permission) expire without a message: check them periodically.
  gate_timer_ =
      this->create_wall_timer(100ms, std::bind(&EscMotorControlComponent::apply_gate, this));
  if (lab_sub_) {
    lab_timer_ =
        this->create_wall_timer(100ms, std::bind(&EscMotorControlComponent::lab_tick, this));
  }

  // Diagnostic only: do not rewrite pulse settings or their existing mapping.
  for (const auto& entry :
       {std::make_pair("min_speed", speed_to_pulse_us(min_speed_)),
        std::make_pair("max_speed", speed_to_pulse_us(max_speed_)),
        std::make_pair("speed=0", speed_to_pulse_us(0.0)),
        std::make_pair("neutral", neutral_pulse_width_us_ > 0
                                      ? neutral_pulse_width_us_
                                      : (min_pulse_width_us_ + max_pulse_width_us_) / 2)}) {
    if (!PwmCommand::valid_pulse(entry.second)) {
      RCLCPP_ERROR(this->get_logger(),
                   "ESC pulse configuration: %s maps to %d us; lgpio accepts 0 or 500-2500 us",
                   entry.first, entry.second);
    }
  }

  const int range_min = std::min(speed_to_pulse_us(min_speed_), speed_to_pulse_us(max_speed_));
  const int range_max = std::max(speed_to_pulse_us(min_speed_), speed_to_pulse_us(max_speed_));
  if (range_min < 500 && range_max > 0) {
    RCLCPP_ERROR(this->get_logger(),
                 "ESC pulse configuration: continuous speed interval intersects 1-499 us; "
                 "such requests fail closed without changing the legacy mapping");
  }

  // ---- ESC initialisation ----
  initialize_esc();
  if (pwm_ && pwm_->name() == "rp1_hw") {
    pwm_lease_timer_ = this->create_wall_timer(100ms, [this] { renew_pwm_lease(); });
  }

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

EscMotorControlComponent::~EscMotorControlComponent() { begin_shutdown(); }

void EscMotorControlComponent::begin_shutdown() {
  {
    std::lock_guard<std::mutex> guard(lock_);
    if (stopping_) return;
    stopping_ = true;
    current_speed_ = 0.0;
    if (pwm_lease_timer_) pwm_lease_timer_->cancel();
    if (gate_timer_) gate_timer_->cancel();
    if (safety_timer_) safety_timer_->cancel();
    if (lab_timer_) lab_timer_->cancel();
  }
  RCLCPP_INFO(this->get_logger(), "ESC shutdown_begin");
  // Serialize backend state/Client updates with status reads as well as command callbacks.
  // The guard drains independently while this lock is held; no ROS heartbeat is required.
  std::lock_guard<std::mutex> guard(lock_);
  if (pwm_ && pwm_->name() == "rp1_hw") {
    const bool low = pwm_->graceful_shutdown();
    if (low)
      RCLCPP_INFO(this->get_logger(), "ESC low_api_accepted (not a physical measurement)");
    else
      RCLCPP_ERROR(this->get_logger(), "ESC Low request failed; output not confirmed safe");
    pwm_->cleanup();
  } else {
    if (pwm_) {
      // Use the same latched/terminal policy; a destructor must not re-emit neutral after Low.
      if (send_pulse(speed_to_pulse_us(0.0), 0.0)) std::this_thread::sleep_for(500ms);
      pwm_->cleanup();
    }
  }
}

void EscMotorControlComponent::renew_pwm_lease() {
  // These callbacks execute on the ROS executor, never an unconditional heartbeat thread.
  safety_check();
  lab_tick();
  apply_gate();
  std::lock_guard<std::mutex> guard(lock_);
  if (stopping_ || !pwm_ || pwm_->terminal()) return;
  double speed =
      evaluate_gate_locked() == RollerBlock::kNone && !pwm_command_.fault() ? current_speed_ : 0.0;
  send_pulse(speed_to_pulse_us(speed), speed);
}

// --------------------------------------------------------------------------
// ESC initialisation
// --------------------------------------------------------------------------
void EscMotorControlComponent::initialize_esc() {
  if (test_mode_) {
    RCLCPP_INFO(this->get_logger(), "Simulation mode (test_mode=true)");
    pwm_ = std::make_unique<SimulationBackend>();
    pwm_->initialize(pwm_pin_);
    send_pulse(speed_to_pulse_us(0.0), 0.0, true);
    return;
  }

  // Create PWM backend via factory
  std::string actual_name;
  pwm_ = make_pwm_backend(pwm_backend_name_, gpio_chip_num_, actual_name, rp1_guard_socket_);

  // Try to initialise hardware
  if (!pwm_->initialize(pwm_pin_)) {
    RCLCPP_FATAL(this->get_logger(), "Failed to initialise PWM backend '%s' on pin %d",
                 actual_name.c_str(), pwm_pin_);
    if (pwm_backend_name_ == "rp1_hw") {
      pwm_->cleanup();
      throw std::runtime_error("rp1_hw initialization failed; no simulation fallback");
    }
    RCLCPP_FATAL(this->get_logger(),
                 "Falling back to simulation. Check: HOME env, gpio group, device permissions.");
    pwm_ = std::make_unique<SimulationBackend>();
    pwm_->initialize(pwm_pin_);
    send_pulse(speed_to_pulse_us(0.0), 0.0, true);
    return;
  }

  RCLCPP_INFO(this->get_logger(), "=== ESC initialization ===");
  RCLCPP_WARN(this->get_logger(), "Do NOT touch the motor during initialization!");

  // Send neutral pulse to arm the ESC
  int neutral_us = neutral_pulse_width_us_;
  if (neutral_us <= 0) {
    neutral_us = (min_pulse_width_us_ + max_pulse_width_us_) / 2;
  }
  if (!send_pulse(neutral_us, 0.0, true)) {
    RCLCPP_ERROR(this->get_logger(), "ESC initialization failed; PWM fault latched");
    if (pwm_backend_name_ == "rp1_hw") {
      pwm_->cleanup();
      throw std::runtime_error("rp1_hw arm request failed");
    }
    return;
  }
  std::this_thread::sleep_for(2s);  // ESC arm wait

  if (!pwm_->complete_arm()) {
    pwm_command_.latch_fault();
    pwm_->cleanup();
    throw std::runtime_error("rp1_hw arm deadline/lease transition failed");
  }
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

bool EscMotorControlComponent::set_motor_speed(double speed) {
  std::lock_guard<std::mutex> guard(lock_);

  if (stopping_ || !std::isfinite(speed)) return false;

  // Evaluated now, not from the last timer tick: nothing nonzero leaves while the gate is closed.
  if (evaluate_gate_locked() != RollerBlock::kNone) {
    speed = 0.0;
  }

  // Clamp nonzero requests only: a stop must remain zero even with unusual speed limits.
  if (speed != 0.0) speed = std::max(min_speed_, std::min(max_speed_, speed));
  if (pwm_command_.fault()) speed = 0.0;

  current_speed_ = speed;

  return send_pulse(speed_to_pulse_us(speed), speed);
}

bool EscMotorControlComponent::send_pulse(int pulse_us, double speed, bool initializing) {
  if (!pwm_) return false;
  const auto changed = [this](int before, int after, double value) {
    RCLCPP_INFO(this->get_logger(), "ESC pulse: %d -> %d us (speed=%.3f)", before, after, value);
  };
  const auto error = [this](int code) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                          "ESC PWM operation failed (backend=%s, error=%d); PWM fault latched",
                          pwm_->name().c_str(), code);
  };
  return initializing ? pwm_command_.initialize(*pwm_, pwm_pin_, pulse_us, changed, error)
                      : pwm_command_.send(*pwm_, pwm_pin_, pulse_us, speed, changed, error);
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
    // 非常停止（押下・未受信・途絶）または実行時許可なしの間は、押されているボタンでラッチを
    // 解除して「離す」を要求する。解除・許可の復帰後も押しっぱなしでは再始動せず、離す→押すが
    // 必要（押下を「離した」扱いにすると、その時点で再アームされてしまうため使わない）。
    const bool inhibited = evaluate_gate_locked() != RollerBlock::kNone;
    r = full_speed_logic_.onButton(
        raw_pressed, pwm_backend_name_ == "rp1_hw" ? steady_now_sec() : this->now().seconds(),
        inhibited);
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
      roller_lab_logic_.onEmergencyStop(true, steady_now_sec());
    }
  }

  if (transition.send_stop) {
    RCLCPP_WARN(this->get_logger(), "非常停止を受信 (source=%s, reason=%s)。モータを停止します",
                msg.source.c_str(), msg.reason.c_str());
    set_motor_speed(0.0);
  } else if (transition.log_release) {
    RCLCPP_INFO(this->get_logger(),
                "非常停止が解除されました (source=%s)。フルスピードボタンの再押下まで停止のまま",
                msg.source.c_str());
  }
  if (transition.send_stop || transition.log_release) {
    publish_roller_status();
  }
  apply_gate();
}

void EscMotorControlComponent::teacher_permission_callback(
    const questix_msgs::msg::ActuationAuthority::SharedPtr msg) {
  if (!msg) {
    return;
  }
  {
    std::lock_guard<std::mutex> guard(lock_);
    have_teacher_permission_msg_ = true;
    teacher_permission_allowed_ = msg->launcher_allowed;
    last_teacher_permission_rx_sec_ = steady_now_sec();
  }
  apply_gate();
}

RollerBlock EscMotorControlComponent::evaluate_gate_locked() const {
  const double now = steady_now_sec();
  RollerGateInputs in;
  in.estop = estop_monitor_->inputs();
  // The teacher's permission is a separate permission; disabled (the default) it is not looked at.
  in.teacher_permission.required = require_teacher_permission_;
  if (require_teacher_permission_) {
    in.teacher_permission.known = have_teacher_permission_msg_;
    in.teacher_permission.allowed = teacher_permission_allowed_;
    in.teacher_permission.age_sec =
        have_teacher_permission_msg_ ? now - last_teacher_permission_rx_sec_ : 0.0;
    in.teacher_permission.timeout_sec = teacher_permission_timeout_sec_;
  }
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
    if (now_block != RollerBlock::kNone || pwm_command_.fault()) {
      // Closing (or closed with something still spinning): stop, clear the latch so a held
      // button needs a release, and lock a lab run until it sends 0.
      if ((previous == RollerBlock::kNone && now_block != RollerBlock::kNone) ||
          pwm_command_.needs_stop(speed_to_pulse_us(0.0)) || full_speed_logic_.isActive() ||
          roller_lab_logic_.labActive()) {
        full_speed_logic_.inhibit();
        roller_lab_logic_.onBlocked(steady_now_sec());
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
                  "Roller allowed again (was %s): press the full-speed button again (or send a "
                  "new lab run) to spin",
                  rollerBlockName(previous));
    } else {
      RCLCPP_WARN(this->get_logger(), "Roller blocked: %s (was %s); stop requested",
                  rollerBlockName(now_block), rollerBlockName(previous));
    }
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
    const RollerBlock block = evaluate_gate_locked();
    decision =
        roller_lab_logic_.onLab(msg->data, steady_now_sec(), full_speed_logic_.isActive(),
                                isRollerEstopBlock(block), !isRollerTeacherPermissionBlock(block));
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
    if (stopping_) return;
    status.command = current_speed_;
    status.pwm_fault = pwm_command_.fault();
    status.applied_pulse_us =
        pwm_ && pwm_->name() == "rp1_hw" ? pwm_->applied_hint() : pwm_command_.applied_pulse_us();
    status.pwm_output_state = pwm_ ? pwm_->output_state() : "UNKNOWN";
    status.pwm_error = pwm_ ? pwm_->last_error() : 0;
    status.pwm_backend = pwm_ ? pwm_->name() : "none";
    status.source = roller_lab_logic_.sourceName(full_speed_logic_.isActive());
    status.lab_accepted = roller_lab_logic_.config().accept;
    status.lab_locked = roller_lab_logic_.labLocked();
    const RollerBlock block = evaluate_gate_locked();
    status.estop = isRollerEstopBlock(block);
    status.authority = !isRollerTeacherPermissionBlock(block);
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
    r = full_speed_logic_.onTimerCheck(pwm_backend_name_ == "rp1_hw" ? steady_now_sec()
                                                                     : this->now().seconds());
  }
  // Lock released before set_motor_speed(), which takes lock_ itself.

  if (r.timed_out) {
    RCLCPP_WARN(this->get_logger(), "Safety timeout: stopping motor");
  }
  if (r.stop) {
    set_motor_speed(0.0);
  }
}

// --------------------------------------------------------------------------
// Status publishing
// --------------------------------------------------------------------------
void EscMotorControlComponent::publish_status() {
  auto status_msg = std_msgs::msg::Float32();
  {
    std::lock_guard<std::mutex> guard(lock_);
    status_msg.data = static_cast<float>(current_speed_);
  }
  status_pub_->publish(status_msg);
}

}  // namespace esc_motor_control_cpp

#include "rclcpp_components/register_node_macro.hpp"
RCLCPP_COMPONENTS_REGISTER_NODE(esc_motor_control_cpp::EscMotorControlComponent)
