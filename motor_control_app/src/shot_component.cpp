// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// ShotComponent: construction (parameters, topics, timers).
// Split into several files so the build compiles them in parallel:
// shot_component_lifecycle.cpp (auto start, recovery and lifecycle transitions) and
// shot_component_control.cpp (E-stop / teacher permission, controller, QUESTiX LAB and
// shot sequence).
#include "motor_control_app/shot_component.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <exception>
#include <functional>
#include <lifecycle_msgs/msg/state.hpp>
#include <limits>
#include <string>

#include "motor_control_app/shot_angle.hpp"
#include "motor_control_app/shot_auto_start.hpp"

namespace motor_control_app {

ShotComponent::ShotComponent(const rclcpp::NodeOptions& options)
    : rclcpp_lifecycle::LifecycleNode("shot_component", options),
      tilt_servo_id_(1),
      trigger_servo_id_(3),
      fire_button_(5),
      tilt_up_axis_(-2),
      tilt_down_axis_(-2),
      tilt_up_axis_sign_(1),
      tilt_down_axis_sign_(-1),
      tilt_up_button_index_(4),
      tilt_down_button_index_(6),
      tilt_step_angle_(5.0),
      tilt_min_angle_(0.0),
      tilt_max_angle_(70.0),
      fire_angle_(130.0),
      home_angle_(100.0),
      fire_duration_ms_(300),
      command_rate_limit_ms_(50),
      auto_start_(true),
      connect_retry_period_sec_(3.0),
      estop_timed_out_(false),
      runtime_fault_(false),
      teardown_pending_(false),
      is_shooting_(false),
      last_button_state_(false),
      current_tilt_position_(2048),
      current_tilt_angle_(0.0),
      last_command_time_(0, 0, RCL_ROS_TIME),
      accept_lab_input_(false),
      lab_joy_quiet_sec_(1.0),
      lab_min_fire_interval_sec_(2.0),
      joy_launcher_active_at_sec_(-std::numeric_limits<double>::infinity()),
      last_fire_sec_(-std::numeric_limits<double>::infinity()),
      fired_count_(0),
      last_fire_source_(shot_lab::FireSource::kNone),
      last_lab_refusal_(shot_lab::Refusal::kNone) {
  // パラメーター宣言（取得は on_configure で行い、cleanup→configure で再読込できるようにする）
  this->declare_parameter("port", "/dev/servo");
  this->declare_parameter("baudrate", 115200);
  this->declare_parameter("tilt_servo_id", 1);
  this->declare_parameter("trigger_servo_id", 3);
  this->declare_parameter("fire_button", 5);  // R button (Switch2 native index)
  // Legacy profiles still work. Explicit per-direction axes override tilt_axis.
  this->declare_parameter("tilt_axis", -1);
  this->declare_parameter("tilt_up_axis", -2);
  this->declare_parameter("tilt_down_axis", -2);
  this->declare_parameter("tilt_up_axis_sign", 1);
  this->declare_parameter("tilt_down_axis_sign", -1);
  this->declare_parameter("tilt_up_button_index", 4);    // L button (Switch2 native index)
  this->declare_parameter("tilt_down_button_index", 6);  // ZL button (Switch2 native index)
  this->declare_parameter("tilt_step_angle", 5.0);       // チルトステップサイズ（度）
  this->declare_parameter("tilt_min_angle", 0.0);        // チルト最小角度（度）
  this->declare_parameter("tilt_max_angle", 70.0);       // チルト最大角度（度）
  this->declare_parameter("fire_angle", 130.0);          // 射撃角度（度）
  this->declare_parameter("home_angle", 100.0);          // ホーム角度（度）
  this->declare_parameter("fire_duration_ms", 300);      // 射撃持続時間（ミリ秒）
  this->declare_parameter("command_rate_limit_ms", 50);  // コマンド間隔制限（ミリ秒）
  this->declare_parameter("joy_topic", "/joy");          // joyトピック名
  // Lifecycle 自動遷移。非常停止解除でサーボが通電するまで configure を再試行する。
  this->declare_parameter("auto_start", true);
  this->declare_parameter("connect_retry_period_sec", 3.0);
  // 非常停止解除などからの起動の試行期間（issue #175）: 短い周期と期間の長さ、サーボ応答の上限
  this->declare_parameter("startup_retry_period_sec", 0.2);
  this->declare_parameter("startup_window_sec", 5.0);
  this->declare_parameter("servo_response_timeout_ms", 100);
  // 非常停止連動トピック（questix_msgs/EmergencyStop、auto_start=true のときのみ有効、
  // 空文字で連動無効）
  this->declare_parameter("emergency_stop_topic", "/emergency_stop");
  this->declare_parameter("emergency_stop_timeout_sec", 1.0);
  // 未受信の /emergency_stop を非常停止として扱う（false は単体診断の明示 opt-out のみ）
  this->declare_parameter("require_emergency_stop", true);
  // 教員の許可（questix_msgs/ActuationAuthority の launcher_allowed）。非常停止とは別の
  // 概念で、練習での opt-in（既定 false）。大会起動（enable_autoreferee）では常に false。
  this->declare_parameter("require_teacher_permission", false);
  this->declare_parameter("teacher_permission_topic", "/actuation_authority");
  this->declare_parameter("teacher_permission_timeout_sec", 1.0);
  // QUESTiX LAB launcher input（練習用起動のみ true。条件は shot_lab_logic.hpp）
  this->declare_parameter("accept_lab_input", false);
  this->declare_parameter("lab_joy_quiet_sec", 1.0);
  this->declare_parameter("lab_min_fire_interval_sec", 2.0);

  accept_lab_input_ = this->get_parameter("accept_lab_input").as_bool();
  // on_configure re-reads the tilt range; reading it here too lets /shot/status report the
  // configured range while the node still waits for the servos.
  tilt_min_angle_ = this->get_parameter("tilt_min_angle").as_double();
  tilt_max_angle_ = this->get_parameter("tilt_max_angle").as_double();
  const double requested_quiet = this->get_parameter("lab_joy_quiet_sec").as_double();
  lab_joy_quiet_sec_ =
      std::isfinite(requested_quiet) && requested_quiet >= 0.0 ? requested_quiet : 1.0;
  const double requested_interval = this->get_parameter("lab_min_fire_interval_sec").as_double();
  lab_min_fire_interval_sec_ =
      std::isfinite(requested_interval) && requested_interval >= 0.0 ? requested_interval : 2.0;
  if (lab_joy_quiet_sec_ != requested_quiet || lab_min_fire_interval_sec_ != requested_interval) {
    RCLCPP_WARN(this->get_logger(),
                "Invalid lab_joy_quiet_sec=%g or lab_min_fire_interval_sec=%g; using %.1f / %.1f",
                requested_quiet, requested_interval, lab_joy_quiet_sec_,
                lab_min_fire_interval_sec_);
  }

  // /shot/status is observation only and reports in every lifecycle state.
  shot_status_pub_ =
      rclcpp::create_publisher<std_msgs::msg::String>(*this, "/shot/status", rclcpp::QoS(10));
  shot_status_timer_ = this->create_wall_timer(std::chrono::milliseconds(200),
                                               std::bind(&ShotComponent::publishShotStatus, this));
  if (accept_lab_input_) {
    // Requests are checked in the callbacks (ACTIVE, E-stop, controller, interval), never queued.
    lab_tilt_sub_ = this->create_subscription<std_msgs::msg::Float32>(
        "/shot/lab/tilt", 1,
        std::bind(&ShotComponent::labTiltCallback, this, std::placeholders::_1));
    lab_fire_sub_ = this->create_subscription<std_msgs::msg::Empty>(
        "/shot/lab/fire", 1,
        std::bind(&ShotComponent::labFireCallback, this, std::placeholders::_1));
    RCLCPP_INFO(this->get_logger(),
                "QUESTiX LAB launcher input on /shot/lab/tilt and /shot/lab/fire "
                "(controller quiet %.1f s, fire interval %.1f s)",
                lab_joy_quiet_sec_, lab_min_fire_interval_sec_);
  } else {
    RCLCPP_INFO(this->get_logger(), "QUESTiX LAB launcher input disabled (accept_lab_input=false)");
  }

  auto_start_ = this->get_parameter("auto_start").as_bool();
  const double requested_retry_period = this->get_parameter("connect_retry_period_sec").as_double();
  connect_retry_period_sec_ = shot_auto_start::normalizePositivePeriod(requested_retry_period, 3.0);
  if (!shot_auto_start::isValidPositivePeriod(requested_retry_period)) {
    RCLCPP_WARN(this->get_logger(),
                "Invalid connect_retry_period_sec=%g; using the default 3.0 seconds",
                requested_retry_period);
  }
  const double requested_startup_period =
      this->get_parameter("startup_retry_period_sec").as_double();
  startup_retry_period_sec_ = std::clamp(
      shot_auto_start::normalizePositivePeriod(requested_startup_period, 0.2), 0.05, 1.0);
  const double requested_startup_window = this->get_parameter("startup_window_sec").as_double();
  startup_window_sec_ = std::clamp(
      shot_auto_start::normalizePositivePeriod(requested_startup_window, 5.0), 0.5, 60.0);
  const int64_t requested_response_ms = this->get_parameter("servo_response_timeout_ms").as_int();
  servo_response_timeout_ms_ =
      static_cast<int>(std::clamp<int64_t>(requested_response_ms, 10, 500));
  if (startup_retry_period_sec_ != requested_startup_period ||
      startup_window_sec_ != requested_startup_window ||
      servo_response_timeout_ms_ != requested_response_ms) {
    RCLCPP_WARN(this->get_logger(),
                "Invalid startup_retry_period_sec=%g / startup_window_sec=%g / "
                "servo_response_timeout_ms=%ld; using %.2f s / %.1f s / %d ms",
                requested_startup_period, requested_startup_window,
                static_cast<long>(requested_response_ms), startup_retry_period_sec_,
                startup_window_sec_, servo_response_timeout_ms_);
  }
  // /emergency_stop は共通の EmergencyStopMonitor（questix_safety）が購読・判定する
  // （transient_local なので起動時に最新のラッチ状態を受信する。契約: questix_msgs/README.md）。
  // lifecycle の連動は auto_start=true のときだけで、手動運用でもコマンドの可否には使う。
  estop_monitor_ = std::make_unique<questix_safety::EmergencyStopMonitor>(
      *this, questix_safety::EmergencyStopMonitor::declareAndRead(*this), "launcher",
      [this](const questix_msgs::msg::EmergencyStop& msg,
             const questix_safety::EmergencyStopMonitor::Change& change) {
        onEmergencyStop(msg, change);
      });
  require_teacher_permission_ = this->get_parameter("require_teacher_permission").as_bool();
  teacher_permission_topic_ = this->get_parameter("teacher_permission_topic").as_string();
  teacher_permission_timeout_sec_ = actuation_gate::teacherPermissionLease(
      this->get_parameter("teacher_permission_timeout_sec").as_double());

  if (auto_start_) {
    const auto period = std::chrono::duration<double>(std::max(0.5, connect_retry_period_sec_));
    auto_start_timer_ =
        this->create_wall_timer(std::chrono::duration_cast<std::chrono::nanoseconds>(period),
                                std::bind(&ShotComponent::autoStartTimerCallback, this));
    // 試行期間の間だけ動かす（requestStartup で開始、endStartup で停止）
    startup_timer_ =
        this->create_wall_timer(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                    std::chrono::duration<double>(startup_retry_period_sec_)),
                                std::bind(&ShotComponent::startupTimerCallback, this));
    startup_timer_->cancel();
  }
  if (require_teacher_permission_) {
    if (teacher_permission_topic_.empty()) {
      RCLCPP_ERROR(this->get_logger(),
                   "teacher_permission_topic is empty but require_teacher_permission=true: "
                   "the launcher will never start");
    } else {
      // volatile + keep-last(1): 許可をラッチせず、発行元が止まればリース切れで閉じる。
      teacher_permission_sub_ = this->create_subscription<questix_msgs::msg::ActuationAuthority>(
          teacher_permission_topic_, rclcpp::QoS(1).reliable().durability_volatile(),
          std::bind(&ShotComponent::teacherPermissionCallback, this, std::placeholders::_1));
    }
    teacher_permission_timer_ =
        this->create_wall_timer(std::chrono::milliseconds(100),
                                std::bind(&ShotComponent::teacherPermissionTimerCallback, this));
    RCLCPP_INFO(this->get_logger(),
                "Teacher permission required on %s (lease %.2fs): the launcher waits "
                "until the teacher switches it on",
                teacher_permission_topic_.c_str(), teacher_permission_timeout_sec_);
  }

  if (auto_start_) {
    if (!estop_monitor_->topic().empty()) {
      if (estop_monitor_->timeoutSec() > 0.0) {
        emergency_stop_timeout_timer_ =
            this->create_wall_timer(std::chrono::milliseconds(100),
                                    std::bind(&ShotComponent::emergencyStopTimeoutCallback, this));
      }
    }
    RCLCPP_INFO(this->get_logger(),
                "Shot component created (auto_start=true, retry=%.1fs, startup %.2fs x %.1fs, "
                "servo response %d ms, estop_topic=%s). "
                "サーボ通電（非常停止解除）を待って自動起動します",
                connect_retry_period_sec_, startup_retry_period_sec_, startup_window_sec_,
                servo_response_timeout_ms_,
                estop_monitor_->topic().empty() ? "<disabled>" : estop_monitor_->topic().c_str());
  } else {
    RCLCPP_INFO(this->get_logger(),
                "Shot component created (auto_start=false). "
                "外部から lifecycle configure/activate してください");
  }
}

ShotComponent::~ShotComponent() {
  stopAutoStartTimers();
  if (startup_timer_) {
    startup_timer_->cancel();
  }
  if (fire_timer_) {
    fire_timer_->cancel();
  }
  try {
    disconnectServo();
  } catch (...) {
    // Destructors must not propagate hardware cleanup failures.
  }
}

}  // namespace motor_control_app

#include <rclcpp_components/register_node_macro.hpp>
RCLCPP_COMPONENTS_REGISTER_NODE(motor_control_app::ShotComponent)
