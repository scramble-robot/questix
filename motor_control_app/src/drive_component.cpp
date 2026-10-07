// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// DriveComponent: construction, auto start and lifecycle transitions.
// Split into several files so the build compiles them in parallel:
// drive_component_params.cpp (parameters) and drive_component_control.cpp (control loop,
// safety gate, status and odometry).
#include "motor_control_app/drive_component.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <exception>
#include <filesystem>
#include <functional>
#include <lifecycle_msgs/msg/state.hpp>
#include <limits>
#include <stdexcept>

#include "motor_control_app/drive_control_tick.hpp"
#include "motor_control_app/drive_slew.hpp"
#include "motor_control_app/lifecycle_auto_start.hpp"
#include "motor_control_app/motor_status_msg.hpp"

using namespace std::chrono_literals;

namespace motor_control_app {

DriveComponent::DriveComponent(const rclcpp::NodeOptions& options)
    : rclcpp_lifecycle::LifecycleNode("drive_component", options),
      last_cmd_time_(0, 0, RCL_ROS_TIME),
      cmd_timeout_sec_(1.0),
      motor_initialized_(false) {
  // パラメーター宣言（取得は on_configure で行い、cleanup→configure で再読込できるようにする）
  declareParameters();

  // 走行チューニング用パラメータの実行時変更を受け付ける（実機で ros2 param set しながら
  // 加減速を詰められるようにするため）。詳細は onParameterChange。
  param_handler_ = this->add_on_set_parameters_callback(
      std::bind(&DriveComponent::onParameterChange, this, std::placeholders::_1));

  auto_start_ = this->get_parameter("auto_start").as_bool();
  const double requested_retry_period = this->get_parameter("connect_retry_period_sec").as_double();
  connect_retry_period_sec_ =
      lifecycle_auto_start::normalizeRetryPeriod(requested_retry_period, 1.0);
  if (!lifecycle_auto_start::isValidPositiveValue(requested_retry_period)) {
    RCLCPP_WARN(this->get_logger(),
                "Invalid connect_retry_period_sec=%g; using the default 1.0 seconds",
                requested_retry_period);
  }

  // /emergency_stop は共通の EmergencyStopMonitor（questix_safety）が購読・判定する。
  // lifecycle 状態に依存せず常時生かす（on_cleanup で破棄される twist 購読と異なり、
  // unconfigured での configure リトライ中も状態を追従する）。
  estop_monitor_ = std::make_unique<questix_safety::EmergencyStopMonitor>(
      *this, questix_safety::EmergencyStopMonitor::declareAndRead(*this), "drive",
      [this](const questix_msgs::msg::EmergencyStop& msg,
             const questix_safety::EmergencyStopMonitor::Change& change) {
        onEmergencyStop(msg, change);
      });

  // 教員の許可（練習時）。volatile + keep-last(1): 許可をラッチせず、発行元が止まれば
  // リース（teacher_permission_timeout_sec）切れで閉じる。
  require_teacher_permission_ = this->get_parameter("require_teacher_permission").as_bool();
  teacher_permission_topic_ = this->get_parameter("teacher_permission_topic").as_string();
  teacher_permission_timeout_sec_ = actuation_gate::teacherPermissionLease(
      this->get_parameter("teacher_permission_timeout_sec").as_double());
  if (require_teacher_permission_) {
    if (teacher_permission_topic_.empty()) {
      RCLCPP_ERROR(this->get_logger(),
                   "teacher_permission_topic is empty but require_teacher_permission=true: "
                   "the drive will never move");
    } else {
      teacher_permission_sub_ = this->create_subscription<questix_msgs::msg::ActuationAuthority>(
          teacher_permission_topic_, rclcpp::QoS(1).reliable().durability_volatile(),
          std::bind(&DriveComponent::teacherPermissionCallback, this, std::placeholders::_1));
    }
    RCLCPP_INFO(this->get_logger(),
                "Teacher permission required on %s (lease %.2fs): the drive stays "
                "stopped until the teacher switches driving on",
                teacher_permission_topic_.c_str(), teacher_permission_timeout_sec_);
  }

  // 起動時のゲート状態（何も受信していない状態）。ログの初期値で、何も送らない。
  last_block_ = actuation_gate::evaluate(gateInputs());

  if (auto_start_) {
    const auto period = std::chrono::duration<double>(std::max(0.5, connect_retry_period_sec_));
    auto_start_timer_ =
        this->create_wall_timer(std::chrono::duration_cast<std::chrono::nanoseconds>(period),
                                std::bind(&DriveComponent::autoStartTimerCallback, this));
    RCLCPP_INFO(this->get_logger(),
                "Drive component created (auto_start=true, retry=%.1fs). "
                "モータ通電（非常停止解除）を待って自動起動します",
                connect_retry_period_sec_);
  } else {
    RCLCPP_INFO(this->get_logger(),
                "Drive component created (auto_start=false). "
                "外部から lifecycle configure/activate してください");
  }
}

DriveComponent::~DriveComponent() {
  if (auto_start_timer_) {
    auto_start_timer_->cancel();
  }
  if (control_timer_) {
    control_timer_->cancel();
  }
  if (status_timer_) {
    status_timer_->cancel();
  }
  shutdownMotorLib();
}

void DriveComponent::autoStartTimerCallback() {
  using lifecycle_auto_start::AutoStartAction;
  using lifecycle_auto_start::decideAutoStartAction;

  if (!auto_start_timer_) {
    return;
  }
  try {
    uint8_t state_id = this->get_current_state().id();
    AutoStartAction action = decideAutoStartAction(state_id);
    if (action == AutoStartAction::kConfigure) {
      RCLCPP_INFO_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                           "モータ接続を試行します（未通電時は失敗し、通電後に自動復帰します）");
      state_id = this->configure().id();
      action = decideAutoStartAction(state_id);
    }
    if (action == AutoStartAction::kActivate) {
      state_id = this->activate().id();
      action = decideAutoStartAction(state_id);
    }
    if (action == AutoStartAction::kStopTimer) {
      auto_start_timer_->cancel();
    } else if (action == AutoStartAction::kNone &&
               !lifecycle_auto_start::isTransitionState(state_id)) {
      RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                           "Unexpected lifecycle state during drive auto-start: %u",
                           static_cast<unsigned int>(state_id));
    }
  } catch (const std::exception& error) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                          "Drive auto-start transition failed: %s", error.what());
  } catch (...) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                          "Drive auto-start transition failed with unknown exception");
  }
}

DriveComponent::CallbackReturn DriveComponent::on_configure(const rclcpp_lifecycle::State&) {
  readParameters();

  if (!lifecycle_auto_start::isValidStatusPublishRate(status_publish_rate_)) {
    RCLCPP_ERROR(this->get_logger(),
                 "Invalid status_publish_rate=%g; value must produce a positive, representable "
                 "nanosecond timer period",
                 status_publish_rate_);
    return CallbackReturn::FAILURE;
  }

  if (!lifecycle_auto_start::isValidStatusPublishRate(control_rate_)) {
    RCLCPP_ERROR(this->get_logger(),
                 "Invalid control_rate=%g; value must produce a positive, representable "
                 "nanosecond timer period",
                 control_rate_);
    return CallbackReturn::FAILURE;
  }

  // 未通電（非常停止中）は USB CDC デバイス自体が存在しない。ライブラリを構築する前に
  // デバイスの有無を確認し、リトライ毎のライブラリ内 ERROR ログで journald を汚さない。
  if (!std::filesystem::exists(serial_port_)) {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                         "シリアルデバイス %s がありません（モータ未通電の可能性）。"
                         "通電を待って再試行します",
                         serial_port_.c_str());
    return CallbackReturn::FAILURE;
  }

  // シリアル接続 + モータ初期化（非常停止中はポートが無い / 開けない場合がある）
  if (!initializeMotorLib()) {
    // 半構築のインスタンスを残さない（次回の configure 再試行のため）
    diff_drive_.reset();
    motor_lib_.reset();
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                         "モータ初期化に失敗しました (port=%s)。通電を待って再試行します",
                         serial_port_.c_str());
    return CallbackReturn::FAILURE;
  }

  RCLCPP_INFO(this->get_logger(), "Parameters:");
  RCLCPP_INFO(this->get_logger(), "  serial_port: %s", serial_port_.c_str());
  RCLCPP_INFO(this->get_logger(), "  baud_rate: %d", baud_rate_);
  RCLCPP_INFO(this->get_logger(), "  wheel_radius: %.3f", wheel_radius_);
  RCLCPP_INFO(this->get_logger(), "  wheel_separation: %.3f", wheel_separation_);
  RCLCPP_INFO(this->get_logger(), "  left_motor_id: %d", left_motor_id_);
  RCLCPP_INFO(this->get_logger(), "  right_motor_id: %d", right_motor_id_);
  RCLCPP_INFO(this->get_logger(), "  max_motor_rpm: %d", max_motor_rpm_);
  RCLCPP_INFO(this->get_logger(), "  status_publish_rate: %.1f", status_publish_rate_);
  RCLCPP_INFO(this->get_logger(), "  typed_status_topic: %s", typed_status_topic_.c_str());
  RCLCPP_INFO(this->get_logger(), "  publish_tf: %s", publish_tf_ ? "true" : "false");
  RCLCPP_INFO(this->get_logger(), "  odom_topic: %s", odom_topic_.c_str());
  RCLCPP_INFO(this->get_logger(), "  odom_frame_id: %s", odom_frame_id_.c_str());
  RCLCPP_INFO(this->get_logger(), "  base_frame_id: %s", base_frame_id_.c_str());
  RCLCPP_INFO(this->get_logger(), "  cmd_timeout_sec: %.2f", cmd_timeout_sec_);
  RCLCPP_INFO(this->get_logger(), "  control_rate: %.1f", control_rate_);
  RCLCPP_INFO(this->get_logger(), "  control_mode: %s", control_mode_.c_str());
  if (control_mode_ == "current") {
    RCLCPP_INFO(
        this->get_logger(),
        "  current_kp: %.4f  current_ki: %.4f  max_current_amp: %.2f  integral_limit_amp: %.2f",
        current_kp_, current_ki_, max_current_amp_, integral_limit_amp_);
    RCLCPP_INFO(this->get_logger(), "  current_zero_deadband_rpm: %d", current_zero_deadband_rpm_);
  }
  RCLCPP_INFO(this->get_logger(), "  max_linear_accel: %.3f  max_angular_accel: %.3f",
              max_linear_accel_, max_angular_accel_);
  RCLCPP_INFO(this->get_logger(), "  slew_taper_band_linear: %.3f  slew_taper_band_angular: %.3f",
              slew_taper_band_linear_, slew_taper_band_angular_);
  RCLCPP_INFO(this->get_logger(), "  min_command_rpm: %d", min_command_rpm_);
  RCLCPP_INFO(this->get_logger(), "  drive_fsm_run_enter_rpm: %d  drive_fsm_run_exit_rpm: %d%s",
              drive_fsm_run_enter_rpm_, drive_fsm_run_exit_rpm_,
              (drive_fsm_run_enter_rpm_ <= 0 && drive_fsm_run_exit_rpm_ <= 0)
                  ? " (RUN 閾値無効 = 停止/走行の 2 状態)"
                  : "");
  if (velocity_run_lqr_enabled_ && control_mode_ != "velocity") {
    RCLCPP_WARN(this->get_logger(),
                "velocity_run_lqr_enabled=true は velocity モード専用のため control_mode='%s' "
                "では無視します",
                control_mode_.c_str());
  }
  if (velocityRunLqrLacksRunThreshold()) {
    RCLCPP_WARN(this->get_logger(),
                "velocity_run_lqr_enabled=true ですが drive_fsm_run_enter_rpm / "
                "drive_fsm_run_exit_rpm が両方 0 のため LQR+FF は適用しません（FF のみ）。"
                "同定で決めた RUN 閾値を設定してください");
  }
  RCLCPP_INFO(this->get_logger(),
              "  velocity_run_lqr: %s  tau=%.3fs delay=%d ticks q=%.3f r=%.3f lead=%.2f dist=%.2f "
              "obs[l_x=%.2f l_d=%.3f] max_corr=%.1f rpm invert=%s fb_max_age=%.2fs",
              (velocity_run_lqr_enabled_ && control_mode_ == "velocity" &&
               !velocityRunLqrLacksRunThreshold())
                  ? "enabled"
                  : "disabled",
              velocity_run_model_tau_sec_, velocity_run_model_delay_ticks_, velocity_run_q_,
              velocity_run_r_, velocity_run_lead_gain_, velocity_run_disturbance_gain_,
              velocity_run_observer_l_x_, velocity_run_observer_l_d_,
              velocity_run_max_correction_rpm_, velocity_run_invert_measured_ ? "true" : "false",
              velocity_run_feedback_max_age_sec_);

  // twist 購読（コールバックは ACTIVE のときのみ処理する）
  twist_subscription_ = this->create_subscription<geometry_msgs::msg::Twist>(
      "/target_twist", 1, std::bind(&DriveComponent::twistCallback, this, std::placeholders::_1));

  // LifecyclePublisher のため on_activate まで publish は無効
  typed_status_publisher_ =
      this->create_publisher<questix_msgs::msg::DriveStatus>(typed_status_topic_, 1);

  // オドメトリ publisher（LifecyclePublisher が ACTIVE ゲートを担う）と TF broadcaster。
  odom_publisher_ = this->create_publisher<nav_msgs::msg::Odometry>(odom_topic_, 10);
  if (publish_tf_) {
    tf_broadcaster_ = std::make_unique<tf2_ros::TransformBroadcaster>(*this);
  }

  RCLCPP_INFO(this->get_logger(), "Drive component configured");
  return CallbackReturn::SUCCESS;
}

DriveComponent::CallbackReturn DriveComponent::on_activate(const rclcpp_lifecycle::State& state) {
  if (!motor_initialized_ || !diff_drive_) {
    RCLCPP_ERROR(this->get_logger(), "Motor library not initialized, cannot activate");
    return CallbackReturn::FAILURE;
  }

  // LifecyclePublisher を有効化（ステータスタイマー作成より先に呼ぶ）
  rclcpp_lifecycle::LifecycleNode::on_activate(state);

  // inactive 中の残留指令でスルーレートクランプが誤動作しないようリセット
  resetCommandState();

  // オドメトリの時刻アンカーをクリアする（ポーズは維持 = 一時停止でありテレポート
  // ではない）。deactivate 中のギャップを次サンプルで積分しないため。
  has_last_odom_time_ = false;

  // 制御 tick タイマー（固定周期）。スルーレート制限・タイムアウト判定・シリアル送信を
  // ここに集約する（twistCallback は目標保存のみ）。
  const auto control_period =
      std::chrono::nanoseconds(lifecycle_auto_start::statusTimerPeriodNanoseconds(control_rate_));
  control_timer_ = this->create_wall_timer(control_period,
                                           std::bind(&DriveComponent::controlTimerCallback, this));

  // ステータスパブリッシュタイマー（フィードバック快照の publish のみ。シリアル非使用）
  const auto timer_period = std::chrono::nanoseconds(
      lifecycle_auto_start::statusTimerPeriodNanoseconds(status_publish_rate_));
  status_timer_ =
      this->create_wall_timer(timer_period, std::bind(&DriveComponent::statusTimerCallback, this));

  // コマンド受信タイムアウトは制御 tick 内で判定する。cmd_timeout_sec_ <= 0 で無効。
  if (!drive_watchdog::isEnabled(cmd_timeout_sec_)) {
    RCLCPP_WARN(this->get_logger(),
                "Command timeout watchdog disabled (cmd_timeout_sec <= 0); motors will keep the "
                "last command if /target_twist stops");
  }

  RCLCPP_INFO(this->get_logger(), "Drive component activated");
  // 稼働状態に到達。以降は自動再遷移を止めて手動 deactivate/cleanup を尊重する。
  if (auto_start_timer_) {
    auto_start_timer_->cancel();
  }
  return CallbackReturn::SUCCESS;
}

DriveComponent::CallbackReturn DriveComponent::on_deactivate(const rclcpp_lifecycle::State& state) {
  control_timer_.reset();
  status_timer_.reset();
  // 停止指令（電流PI積分状態もリセットされる）。失敗は stop fault として残す
  safetyStop("deactivate");
  // 実走セッションの往復レイテンシ統計を記録に残す（制御周期引き上げの判断材料）。
  if (motor_lib_) {
    const auto stats = motor_lib_->getSerialLatencyStats();
    if (stats.samples > 0 || stats.timeouts > 0) {
      RCLCPP_INFO(this->get_logger(),
                  "シリアル往復レイテンシ統計: ema=%.2fms max=%.2fms samples=%lu timeouts=%lu",
                  stats.ema_ms, stats.max_ms, static_cast<unsigned long>(stats.samples),
                  static_cast<unsigned long>(stats.timeouts));
    }
  }
  rclcpp_lifecycle::LifecycleNode::on_deactivate(state);
  // 手動 deactivate を含め、deactivate では自動再遷移を必ず止める
  // （shot_component bc037d1 と同じ扱い）。
  if (auto_start_timer_) {
    auto_start_timer_->cancel();
  }
  RCLCPP_INFO(this->get_logger(), "Drive component deactivated (twist input ignored)");
  return CallbackReturn::SUCCESS;
}

DriveComponent::CallbackReturn DriveComponent::on_cleanup(const rclcpp_lifecycle::State&) {
  control_timer_.reset();
  status_timer_.reset();
  twist_subscription_.reset();
  typed_status_publisher_.reset();
  resetOdometry();
  shutdownMotorLib();
  RCLCPP_INFO(this->get_logger(), "Drive component cleaned up");
  return CallbackReturn::SUCCESS;
}

DriveComponent::CallbackReturn DriveComponent::on_shutdown(const rclcpp_lifecycle::State&) {
  if (auto_start_timer_) {
    auto_start_timer_->cancel();
  }
  control_timer_.reset();
  status_timer_.reset();
  twist_subscription_.reset();
  typed_status_publisher_.reset();
  resetOdometry();
  shutdownMotorLib();
  RCLCPP_INFO(this->get_logger(), "Drive component shut down");
  return CallbackReturn::SUCCESS;
}

DriveComponent::CallbackReturn DriveComponent::on_error(const rclcpp_lifecycle::State&) {
  // 遷移中に ERROR / 例外が発生したときの後始末。リソースを解放して unconfigured
  // に戻し、auto_start 有効時はタイマーを再開して自動復帰に委ねる。
  control_timer_.reset();
  status_timer_.reset();
  twist_subscription_.reset();
  typed_status_publisher_.reset();
  resetOdometry();
  shutdownMotorLib();
  if (auto_start_ && auto_start_timer_) {
    auto_start_timer_->reset();
  }
  RCLCPP_WARN(this->get_logger(), "Drive component error handled, returning to unconfigured");
  return CallbackReturn::SUCCESS;
}

}  // namespace motor_control_app

// コンポーネントとして登録
RCLCPP_COMPONENTS_REGISTER_NODE(motor_control_app::DriveComponent)
