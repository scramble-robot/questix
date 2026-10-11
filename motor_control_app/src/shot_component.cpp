// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// ShotComponent: construction (parameters, topics, timers).
// Split into several files so the build compiles them in parallel:
// shot_component_lifecycle.cpp (auto start, recovery and lifecycle transitions) and
// shot_component_control.cpp (motion permission / E-stop, controller, QUESTiX LAB and
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
      current_tilt_position_(2048),
      current_tilt_angle_(0.0),
      last_command_time_(0, 0, RCL_ROS_TIME),
      min_fire_interval_sec_(0.0),
      last_fire_sec_(-std::numeric_limits<double>::infinity()),
      fired_count_(0),
      last_fire_source_(FireSource::kNone),
      pending_tilt_(false),
      pending_tilt_deg_(0.0),
      multiple_command_publishers_(false) {
  // パラメーター宣言（取得は on_configure で行い、cleanup→configure で再読込できるようにする）
  this->declare_parameter("port", "/dev/servo");
  this->declare_parameter("baudrate", 115200);
  this->declare_parameter("tilt_servo_id", 1);
  this->declare_parameter("trigger_servo_id", 3);
  this->declare_parameter("tilt_step_angle", 5.0);       // チルトステップサイズ（度）
  this->declare_parameter("tilt_min_angle", 0.0);        // チルト最小角度（度）
  this->declare_parameter("tilt_max_angle", 70.0);       // チルト最大角度（度）
  this->declare_parameter("fire_angle", 130.0);          // 射撃角度（度）
  this->declare_parameter("home_angle", 100.0);          // ホーム角度（度）
  this->declare_parameter("fire_duration_ms", 300);      // 射撃持続時間（ミリ秒）
  this->declare_parameter("command_rate_limit_ms", 50);  // コマンド間隔制限（ミリ秒）
  // questix_msgs/LauncherCommand: joy_launcher, or command_arbiter in a lesson launch.
  this->declare_parameter("launcher_command_topic", "/launcher_command");
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
  // 走行許可（L2、questix_msgs/MotionPermission の launcher_allowed）。非常停止とは別の概念で、
  // 未受信・途絶・false は射撃・チルト・自動起動をしない。false は単体診断の明示 opt-out だけ。
  this->declare_parameter("motion_permission_topic", "/motion_permission");
  this->declare_parameter("require_motion_permission", true);
  this->declare_parameter("motion_permission_timeout_sec", 0.5);
  // The shortest time between two shots, from any source (the mechanism's limit; 0 = none).
  this->declare_parameter("min_fire_interval_sec", 0.0);

  // on_configure re-reads the tilt range; reading it here too lets /shot/status report the
  // configured range while the node still waits for the servos.
  tilt_min_angle_ = this->get_parameter("tilt_min_angle").as_double();
  tilt_max_angle_ = this->get_parameter("tilt_max_angle").as_double();
  const double requested_interval = this->get_parameter("min_fire_interval_sec").as_double();
  min_fire_interval_sec_ =
      std::isfinite(requested_interval) && requested_interval >= 0.0 ? requested_interval : 0.0;
  if (min_fire_interval_sec_ != requested_interval) {
    RCLCPP_WARN(this->get_logger(), "Invalid min_fire_interval_sec=%g; using %.1f",
                requested_interval, min_fire_interval_sec_);
  }

  // /shot/status is observation only and reports in every lifecycle state.
  shot_status_pub_ =
      rclcpp::create_publisher<std_msgs::msg::String>(*this, "/shot/status", rclcpp::QoS(10));
  shot_status_timer_ = this->create_wall_timer(std::chrono::milliseconds(200),
                                               std::bind(&ShotComponent::publishShotStatus, this));

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
  permission_monitor_ = std::make_unique<questix_safety::PermissionMonitor>(
      *this, questix_safety::PermissionMonitor::declareAndRead(*this),
      questix_safety::PermissionMonitor::Flag::kLauncher, "launcher",
      [this](const questix_msgs::msg::MotionPermission& msg,
             const questix_safety::PermissionMonitor::Change& change) {
        onMotionPermission(msg, change);
      });

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
  // /launcher_command (reliable + volatile + keep-last(1), questix_msgs/msg/LauncherCommand.msg),
  // subscribed in every lifecycle state: what arrives while the launcher may not move advances
  // the counters and is dropped (launcher_events.hpp), so nothing is replayed on activation.
  command_topic_ = this->get_parameter("launcher_command_topic").as_string();
  command_subscription_ = this->create_subscription<questix_msgs::msg::LauncherCommand>(
      command_topic_, rclcpp::QoS(1).reliable().durability_volatile(),
      std::bind(&ShotComponent::commandCallback, this, std::placeholders::_1));
  command_publisher_timer_ = this->create_wall_timer(
      std::chrono::milliseconds(500), std::bind(&ShotComponent::checkCommandPublishers, this));
  RCLCPP_INFO(this->get_logger(), "Launcher commands: %s (min fire interval %.1f s)",
              command_topic_.c_str(), min_fire_interval_sec_);
  // A lease runs out without a message: check it periodically too.
  permission_timer_ = this->create_wall_timer(std::chrono::milliseconds(100),
                                              std::bind(&ShotComponent::applyPermission, this));

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
