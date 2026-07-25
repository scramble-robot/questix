// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "motor_control_app/drive_component.hpp"

#include <algorithm>
#include <chrono>
#include <exception>
#include <filesystem>
#include <functional>
#include <lifecycle_msgs/msg/state.hpp>

#include "motor_control_app/lifecycle_auto_start.hpp"
#include "motor_control_app/motor_status_msg.hpp"

using namespace std::chrono_literals;

namespace motor_control_app {

DriveComponent::DriveComponent(const rclcpp::NodeOptions& options)
    : rclcpp_lifecycle::LifecycleNode("drive_component", options),
      last_cmd_linear_(0.0),
      last_cmd_angular_(0.0),
      last_cmd_time_(0, 0, RCL_ROS_TIME),
      has_last_cmd_(false),
      cmd_timeout_sec_(0.5),
      motor_initialized_(false),
      emergency_stop_active_(false) {
  // パラメーター宣言（取得は on_configure で行い、cleanup→configure で再読込できるようにする）
  declareParameters();

  auto_start_ = this->get_parameter("auto_start").as_bool();
  const double requested_retry_period = this->get_parameter("connect_retry_period_sec").as_double();
  connect_retry_period_sec_ =
      lifecycle_auto_start::normalizeRetryPeriod(requested_retry_period, 1.0);
  if (!lifecycle_auto_start::isValidPositiveValue(requested_retry_period)) {
    RCLCPP_WARN(this->get_logger(),
                "Invalid connect_retry_period_sec=%g; using the default 1.0 seconds",
                requested_retry_period);
  }

  // /emergency_stop 購読は lifecycle 状態に依存せず常時生かす（on_cleanup で
  // 破棄される twist 購読と異なり、unconfigured での configure リトライ中も
  // 状態を追従する）。transient_local なので起動時に最新のラッチ状態を受信する。
  emergency_stop_topic_ = this->get_parameter("emergency_stop_topic").as_string();
  if (!emergency_stop_topic_.empty()) {
    emergency_stop_sub_ = this->create_subscription<questix_msgs::msg::EmergencyStop>(
        emergency_stop_topic_, rclcpp::QoS(1).reliable().transient_local(),
        std::bind(&DriveComponent::emergencyStopCallback, this, std::placeholders::_1));
  }

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
  if (status_timer_) {
    status_timer_->cancel();
  }
  if (watchdog_timer_) {
    watchdog_timer_->cancel();
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
  RCLCPP_INFO(this->get_logger(), "  control_mode: %s", control_mode_.c_str());
  if (control_mode_ == "current") {
    RCLCPP_INFO(
        this->get_logger(),
        "  current_kp: %.4f  current_ki: %.4f  max_current_amp: %.2f  integral_limit_amp: %.2f",
        current_kp_, current_ki_, max_current_amp_, integral_limit_amp_);
    RCLCPP_INFO(this->get_logger(), "  current_zero_deadband_rpm: %d", current_zero_deadband_rpm_);
  }
  RCLCPP_INFO(this->get_logger(), "  command_rpm_hysteresis: %d", command_rpm_hysteresis_);

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

  // ステータスパブリッシュタイマー
  const auto timer_period = std::chrono::nanoseconds(
      lifecycle_auto_start::statusTimerPeriodNanoseconds(status_publish_rate_));
  status_timer_ =
      this->create_wall_timer(timer_period, std::bind(&DriveComponent::statusTimerCallback, this));

  // コマンド受信ウォッチドッグ（100ms 周期）。cmd_timeout_sec_ <= 0 で無効。
  if (drive_watchdog::isEnabled(cmd_timeout_sec_)) {
    watchdog_timer_ =
        this->create_wall_timer(100ms, std::bind(&DriveComponent::watchdogTimerCallback, this));
  } else {
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
  status_timer_.reset();
  watchdog_timer_.reset();
  // best-effort で停止指令（電流PI積分状態もリセットされる）
  if (diff_drive_) {
    diff_drive_->stop();
  }
  resetCommandState();
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
  status_timer_.reset();
  watchdog_timer_.reset();
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
  status_timer_.reset();
  watchdog_timer_.reset();
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
  status_timer_.reset();
  watchdog_timer_.reset();
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

void DriveComponent::declareParameters() {
  // DDTモータライブラリのパラメータを宣言
  this->declare_parameter("serial_port", "/dev/ttyACM0");
  this->declare_parameter("baud_rate", 57600);
  this->declare_parameter("wheel_radius", 0.1);
  this->declare_parameter("wheel_separation", 0.5);
  this->declare_parameter("left_motor_id", 4);
  this->declare_parameter("right_motor_id", 5);
  this->declare_parameter("max_motor_rpm", 1000);
  this->declare_parameter("status_publish_rate", 10.0);
  // 型付きステータストピック（questix_msgs/DriveStatus）
  this->declare_parameter("typed_status_topic", "/drive_status");

  // 制御モード関連 (後方互換のため velocity 既定)
  this->declare_parameter("control_mode", std::string("velocity"));
  this->declare_parameter("current_kp", 0.001);
  this->declare_parameter("current_ki", 0.0);
  this->declare_parameter("max_current_amp", 1.0);
  this->declare_parameter("integral_limit_amp", 0.3);
  this->declare_parameter("current_zero_deadband_rpm", 5);
  this->declare_parameter("current_invert_measured", true);
  // 送信目標RPMへのヒステリシス（velocity/current 両モード共通）。ジョイスティック等の
  // 入力ノイズによる微小な目標揺らぎが、走行中の足回り微振動になるのを防ぐ。
  this->declare_parameter("command_rpm_hysteresis", 2);
  this->declare_parameter("max_linear_accel", 1.0);
  this->declare_parameter("max_angular_accel", 2.0);

  // 停止時の電気ブレーキ（velocity モードのみ有効）
  this->declare_parameter("brake_on_stop", true);

  // コマンド受信ウォッチドッグのタイムアウト [s]（velocity/current 両モードで有効）
  this->declare_parameter("cmd_timeout_sec", 0.5);

  // 指令送信後の追加待機 [ms]。0で無効。実機の最小コマンド間隔要件用の保険
  this->declare_parameter("command_wait_ms", 0);

  // 停止継続中のブレーキ再送間隔 [ms]。高頻度でブレーキを再送し続けると、残留回転が
  // ある間は毎回新規の制動として作用し、収束せず持続的な振動を起こすことがある。
  // 0で無効（毎回送信、従来挙動）。
  this->declare_parameter("stop_resend_interval_ms", 200);

  // Lifecycle 自動遷移。非常停止解除でモータが通電するまで configure を再試行する。
  this->declare_parameter("auto_start", true);
  this->declare_parameter("connect_retry_period_sec", 1.0);

  // 統一緊急停止トピック（questix_msgs/EmergencyStop）。空文字で連動無効。
  this->declare_parameter("emergency_stop_topic", "/emergency_stop");

  // オドメトリ出力（実測 twist を積分して /odom を publish）。
  this->declare_parameter("publish_tf", true);
  this->declare_parameter("odom_topic", "/odom");
  this->declare_parameter("odom_frame_id", "odom");
  this->declare_parameter("base_frame_id", "base_link");
}

void DriveComponent::readParameters() {
  serial_port_ = this->get_parameter("serial_port").as_string();
  baud_rate_ = this->get_parameter("baud_rate").as_int();
  wheel_radius_ = this->get_parameter("wheel_radius").as_double();
  wheel_separation_ = this->get_parameter("wheel_separation").as_double();
  left_motor_id_ = this->get_parameter("left_motor_id").as_int();
  right_motor_id_ = this->get_parameter("right_motor_id").as_int();
  max_motor_rpm_ = this->get_parameter("max_motor_rpm").as_int();
  status_publish_rate_ = this->get_parameter("status_publish_rate").as_double();
  typed_status_topic_ = this->get_parameter("typed_status_topic").as_string();
  control_mode_ = this->get_parameter("control_mode").as_string();
  current_kp_ = this->get_parameter("current_kp").as_double();
  current_ki_ = this->get_parameter("current_ki").as_double();
  max_current_amp_ = this->get_parameter("max_current_amp").as_double();
  integral_limit_amp_ = this->get_parameter("integral_limit_amp").as_double();
  current_zero_deadband_rpm_ = this->get_parameter("current_zero_deadband_rpm").as_int();
  current_invert_measured_ = this->get_parameter("current_invert_measured").as_bool();
  command_rpm_hysteresis_ = this->get_parameter("command_rpm_hysteresis").as_int();
  max_linear_accel_ = this->get_parameter("max_linear_accel").as_double();
  max_angular_accel_ = this->get_parameter("max_angular_accel").as_double();
  brake_on_stop_ = this->get_parameter("brake_on_stop").as_bool();
  cmd_timeout_sec_ = this->get_parameter("cmd_timeout_sec").as_double();
  command_wait_ms_ = static_cast<int>(this->get_parameter("command_wait_ms").as_int());
  stop_resend_interval_ms_ =
      static_cast<int>(this->get_parameter("stop_resend_interval_ms").as_int());
  publish_tf_ = this->get_parameter("publish_tf").as_bool();
  odom_topic_ = this->get_parameter("odom_topic").as_string();
  odom_frame_id_ = this->get_parameter("odom_frame_id").as_string();
  base_frame_id_ = this->get_parameter("base_frame_id").as_string();
}

bool DriveComponent::initializeMotorLib() {
  try {
    // DDTモータライブラリのインスタンスを作成
    motor_lib_ = std::make_shared<motor_control_lib::DdtMotorLib>(serial_port_, baud_rate_);

    // 最大RPMを設定
    if (!motor_lib_->setMaxRpm(max_motor_rpm_)) {
      RCLCPP_ERROR(this->get_logger(), "Failed to set max RPM");
      return false;
    }

    // 停止時の電気ブレーキ設定（velocity モードのみ有効）
    motor_lib_->setBrakeOnStop(brake_on_stop_);

    // 送信目標RPMへのヒステリシス（velocity/current 両モード共通）
    motor_lib_->setCommandRpmHysteresis(command_rpm_hysteresis_);

    // 指令送信後の追加待機（既定 0 = 無効）
    motor_lib_->setCommandWaitMs(command_wait_ms_);

    // 停止継続中のブレーキ再送間隔（停止直後の持続振動の緩和用）
    motor_lib_->setStopResendIntervalMs(stop_resend_interval_ms_);

    // モータライブラリを初期化（シリアルポートを開く。未通電なら失敗して再試行に回る）
    if (!motor_lib_->initialize()) {
      return false;
    }

    // 制御モード判定
    motor_control_lib::ControlMode mode = motor_control_lib::ControlMode::Velocity;
    if (control_mode_ == "current") {
      mode = motor_control_lib::ControlMode::Current;
      motor_lib_->setCurrentControlParams(current_kp_, current_ki_, max_current_amp_,
                                          integral_limit_amp_);
      motor_lib_->setCurrentZeroDeadbandRpm(current_zero_deadband_rpm_);
      motor_lib_->setCurrentInvertMeasured(current_invert_measured_);
    } else if (control_mode_ != "velocity") {
      RCLCPP_WARN(this->get_logger(), "未知の control_mode '%s' - velocity モードにフォールバック",
                  control_mode_.c_str());
    }

    // 個別モーターを初期化
    if (!motor_lib_->initializeMotor(left_motor_id_, mode) ||
        !motor_lib_->initializeMotor(right_motor_id_, mode)) {
      RCLCPP_ERROR(this->get_logger(), "Failed to initialize individual motors");
      return false;
    }

    // 差動駆動コントローラーを作成
    diff_drive_ = std::make_unique<motor_control_lib::DifferentialDrive>(
        motor_lib_, left_motor_id_, right_motor_id_, wheel_radius_, wheel_separation_);

    motor_initialized_ = true;
    RCLCPP_INFO(this->get_logger(), "Motor library initialized successfully");
    return true;

  } catch (const std::exception& e) {
    RCLCPP_ERROR(this->get_logger(), "Exception during motor initialization: %s", e.what());
    return false;
  }
}

void DriveComponent::shutdownMotorLib() {
  if (motor_lib_ && motor_initialized_) {
    RCLCPP_INFO(this->get_logger(), "Shutting down motor library");
    if (diff_drive_) {
      diff_drive_->stop();
    }
    motor_lib_->emergencyStop();
    motor_lib_->shutdown();
  }
  diff_drive_.reset();
  motor_lib_.reset();
  motor_initialized_ = false;
}

void DriveComponent::resetCommandState() {
  has_last_cmd_ = false;
  last_cmd_linear_ = 0.0;
  last_cmd_angular_ = 0.0;
}

void DriveComponent::resetOdometry() {
  odom_publisher_.reset();
  tf_broadcaster_.reset();
  odom_pose_ = {};
  has_last_odom_time_ = false;
}

void DriveComponent::twistCallback(const geometry_msgs::msg::Twist::SharedPtr msg) {
  // inactive 中の twist は無視する（lifecycle activate 後にのみ駆動する）
  if (this->get_current_state().id() != lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE) {
    return;
  }

  bool motor_ready = motor_initialized_ && diff_drive_ != nullptr;
  switch (drive_watchdog::decideTwistAction(motor_ready, emergency_stop_active_,
                                            motor_ready && diff_drive_->isHealthy())) {
    case drive_watchdog::TwistAction::kIgnore:
      RCLCPP_WARN_THROTTLE(
          this->get_logger(), *this->get_clock(), 1000,
          "Motor not initialized or emergency stop active, ignoring twist command");
      return;
    case drive_watchdog::TwistAction::kFaultStop:
      // モータ異常中は最後の指令を保持せず、明示的に停止指令を送る。
      diff_drive_->stop();
      resetCommandState();
      RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                           "Motor not healthy: sending stop command");
      return;
    case drive_watchdog::TwistAction::kDrive:
      break;
  }

  // 加速度クランプ（スルーレート制限）。max_*_accel<=0 のとき無効。
  double target_linear = msg->linear.x;
  double target_angular = msg->angular.z;
  rclcpp::Time now = this->now();
  if (has_last_cmd_) {
    double dt = (now - last_cmd_time_).seconds();
    if (dt > 0.0 && dt < 1.0) {
      if (max_linear_accel_ > 0.0) {
        double max_delta = max_linear_accel_ * dt;
        double delta = target_linear - last_cmd_linear_;
        if (delta > max_delta)
          target_linear = last_cmd_linear_ + max_delta;
        else if (delta < -max_delta)
          target_linear = last_cmd_linear_ - max_delta;
      }
      if (max_angular_accel_ > 0.0) {
        double max_delta = max_angular_accel_ * dt;
        double delta = target_angular - last_cmd_angular_;
        if (delta > max_delta)
          target_angular = last_cmd_angular_ + max_delta;
        else if (delta < -max_delta)
          target_angular = last_cmd_angular_ - max_delta;
      }
    }
  }
  last_cmd_linear_ = target_linear;
  last_cmd_angular_ = target_angular;
  last_cmd_time_ = now;
  has_last_cmd_ = true;

  // 速度指令をモータライブラリに送信
  if (!diff_drive_->setVelocity(target_linear, target_angular)) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                          "Failed to set motor velocity");
    return;
  }

  RCLCPP_DEBUG(this->get_logger(), "Velocity command sent: linear=%.3f, angular=%.3f",
               target_linear, target_angular);
}

void DriveComponent::emergencyStopCallback(const questix_msgs::msg::EmergencyStop::SharedPtr msg) {
  const bool was_active = emergency_stop_active_;
  emergency_stop_active_ = msg->active;

  const bool motor_ready = motor_initialized_ && diff_drive_ != nullptr;
  switch (drive_watchdog::decideEstopAction(was_active, msg->active, motor_ready)) {
    case drive_watchdog::EstopAction::kStopNow:
      RCLCPP_WARN(this->get_logger(), "非常停止を受信 (source=%s, reason=%s)。モータを停止します",
                  msg->source.c_str(), msg->reason.c_str());
      // best-effort の即時停止。物理非常停止でモータ電源が落ちている場合は
      // シリアル書込みが失敗し得るが、teardown へはエスカレートしない
      // （デバイス消失は既存の configure リトライ経路が処理する）。
      diff_drive_->stop();
      resetCommandState();
      break;
    case drive_watchdog::EstopAction::kClear:
      RCLCPP_INFO(this->get_logger(),
                  "非常停止が解除されました (source=%s)。twist 受付を再開します"
                  "（モータは次の指令まで停止のまま）",
                  msg->source.c_str());
      break;
    case drive_watchdog::EstopAction::kNone:
      if (msg->active && !was_active) {
        RCLCPP_WARN(this->get_logger(),
                    "非常停止を受信 (source=%s, reason=%s)。モータ未初期化のため指令なし",
                    msg->source.c_str(), msg->reason.c_str());
      }
      break;
  }
}

void DriveComponent::watchdogTimerCallback() {
  if (!motor_initialized_ || !diff_drive_) {
    return;
  }

  // 単一スレッドエグゼキュータ（コンポーネントコンテナ／単体 spin）前提のため、
  // last_cmd_time_ / has_last_cmd_ の共有状態にミューテックスは不要。
  double elapsed = (this->now() - last_cmd_time_).seconds();
  if (drive_watchdog::shouldTimeoutStop(elapsed, cmd_timeout_sec_, has_last_cmd_)) {
    RCLCPP_WARN(this->get_logger(),
                "Command timeout: no /target_twist for %.2fs (limit %.2fs), stopping motors",
                elapsed, cmd_timeout_sec_);
    // stop() は各ホイールの stopMotor を通り電流PI積分状態をリセットする。
    diff_drive_->stop();
    // 再発火防止（イベント毎に WARN 1回）。次の /target_twist で自動的に再武装し、
    // スルーレートクランプもゼロから再スタートする。
    resetCommandState();
  }
}

void DriveComponent::statusTimerCallback() {
  if (!motor_initialized_ || !diff_drive_) {
    return;
  }

  try {
    // 型付き publish 用に、左右モータのフィードバックを（古ければ）1回ポーリングして更新する。
    // 走行中は新鮮なので実質 no-op。アイドル時のみ最後のフレームを再送して実測を取り直す。
    motor_lib_->refreshMotorFeedback(left_motor_id_);
    motor_lib_->refreshMotorFeedback(right_motor_id_);

    auto status = diff_drive_->getDriveStatus();

    // 型付きステータス（questix_msgs/DriveStatus）を publish
    rclcpp::Time now = this->now();
    motor_control_lib::DdtMotorLib::MotorFeedbackData left_fb, right_fb;
    motor_lib_->getMotorFeedbackData(left_motor_id_, left_fb);
    motor_lib_->getMotorFeedbackData(right_motor_id_, right_fb);

    questix_msgs::msg::DriveStatus typed_msg;
    typed_msg.header.stamp = now;
    typed_msg.left = toMotorFeedbackMsg(left_fb, now);
    typed_msg.right = toMotorFeedbackMsg(right_fb, now);
    typed_msg.linear_velocity = status.current_linear_velocity;
    typed_msg.angular_velocity = status.current_angular_velocity;
    typed_msg.emergency_stop = emergency_stop_active_;
    typed_status_publisher_->publish(typed_msg);

    // 左右両輪のフィードバックが新鮮なときのみ実測 twist を積分する。stale（非常停止・
    // 未通電を含む）なら twist ゼロ扱いで積分せず、現在ポーズで publish を継続する。
    const bool feedback_fresh =
        odometry::isFeedbackFresh(left_fb.has_feedback, left_fb.feedback_age_sec,
                                  odometry::kMaxFeedbackAgeSec) &&
        odometry::isFeedbackFresh(right_fb.has_feedback, right_fb.feedback_age_sec,
                                  odometry::kMaxFeedbackAgeSec);
    publishOdometry(status.current_linear_velocity, status.current_angular_velocity, feedback_fresh,
                    now);

    RCLCPP_DEBUG(this->get_logger(), "Current velocity: linear=%.3f, angular=%.3f",
                 status.current_linear_velocity, status.current_angular_velocity);

  } catch (const std::exception& e) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                          "Exception in status timer callback: %s", e.what());
  }
}

void DriveComponent::publishOdometry(double linear, double angular, bool feedback_fresh,
                                     const rclcpp::Time& now) {
  if (!odom_publisher_) {
    return;
  }

  // 初回（activate 直後）は時刻アンカーのみ設定し、現在ポーズ・ゼロ twist で publish する。
  if (has_last_odom_time_) {
    const double dt = (now - last_odom_time_).seconds();
    if (odometry::isValidDt(dt, odometry::kMaxOdomDtSec)) {
      // stale なら twist ゼロ扱いで積分しない（stale RPM によるポーズドリフト防止）。
      const double eff_linear = feedback_fresh ? linear : 0.0;
      const double eff_angular = feedback_fresh ? angular : 0.0;
      odom_pose_ = odometry::integrate(odom_pose_, eff_linear, eff_angular, dt);
    }
    // dt が無効（<=0 または kMaxOdomDtSec 超過）ならこのサンプルは積分せず再アンカーのみ。
  }
  last_odom_time_ = now;
  has_last_odom_time_ = true;

  // publish に載せる twist は stale 時ゼロ（ポーズと整合させ、下流の誤積分を防ぐ）。
  const double reported_linear = feedback_fresh ? linear : 0.0;
  const double reported_angular = feedback_fresh ? angular : 0.0;
  const odometry::YawQuaternion q = odometry::yawToQuaternion(odom_pose_.theta);

  nav_msgs::msg::Odometry odom;
  odom.header.stamp = now;
  odom.header.frame_id = odom_frame_id_;
  odom.child_frame_id = base_frame_id_;
  odom.pose.pose.position.x = odom_pose_.x;
  odom.pose.pose.position.y = odom_pose_.y;
  odom.pose.pose.position.z = 0.0;
  odom.pose.pose.orientation.x = 0.0;
  odom.pose.pose.orientation.y = 0.0;
  odom.pose.pose.orientation.z = q.z;
  odom.pose.pose.orientation.w = q.w;
  odom.twist.twist.linear.x = reported_linear;
  odom.twist.twist.angular.z = reported_angular;

  // 固定共分散（issue 指定）。z/roll/pitch は非観測、vy は非ホロノミックで非観測。
  odom.pose.covariance[0] = 0.01;    // x
  odom.pose.covariance[7] = 0.01;    // y
  odom.pose.covariance[14] = 1e6;    // z
  odom.pose.covariance[21] = 1e6;    // roll
  odom.pose.covariance[28] = 1e6;    // pitch
  odom.pose.covariance[35] = 0.05;   // yaw
  odom.twist.covariance[0] = 0.01;   // vx
  odom.twist.covariance[7] = 1e6;    // vy
  odom.twist.covariance[14] = 1e6;   // vz
  odom.twist.covariance[21] = 1e6;   // wx
  odom.twist.covariance[28] = 1e6;   // wy
  odom.twist.covariance[35] = 0.05;  // wz
  odom_publisher_->publish(odom);

  // odom->base_link TF（Odometry と同一 stamp / フレーム）。
  if (publish_tf_ && tf_broadcaster_) {
    geometry_msgs::msg::TransformStamped tf;
    tf.header.stamp = now;
    tf.header.frame_id = odom_frame_id_;
    tf.child_frame_id = base_frame_id_;
    tf.transform.translation.x = odom_pose_.x;
    tf.transform.translation.y = odom_pose_.y;
    tf.transform.translation.z = 0.0;
    tf.transform.rotation.x = 0.0;
    tf.transform.rotation.y = 0.0;
    tf.transform.rotation.z = q.z;
    tf.transform.rotation.w = q.w;
    tf_broadcaster_->sendTransform(tf);
  }
}

}  // namespace motor_control_app

// コンポーネントとして登録
RCLCPP_COMPONENTS_REGISTER_NODE(motor_control_app::DriveComponent)
