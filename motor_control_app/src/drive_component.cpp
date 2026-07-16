// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "motor_control_app/drive_component.hpp"

#include <chrono>
#include <functional>

using namespace std::chrono_literals;

namespace motor_control_app {

DriveComponent::DriveComponent(const rclcpp::NodeOptions& options)
    : Node("drive_component", options),
      last_cmd_linear_(0.0),
      last_cmd_angular_(0.0),
      last_cmd_time_(0, 0, RCL_ROS_TIME),
      has_last_cmd_(false),
      cmd_timeout_sec_(0.5),
      motor_initialized_(false),
      emergency_stop_active_(false) {
  RCLCPP_INFO(this->get_logger(), "Initializing Drive Component");

  // パラメータを初期化
  initializeParameters();

  // DDTモータライブラリを初期化
  if (!initializeMotorLib()) {
    RCLCPP_ERROR(this->get_logger(), "Failed to initialize motor library");
    return;
  }

  // ROS 2 通信の設定
  twist_subscription_ = this->create_subscription<geometry_msgs::msg::Twist>(
      "/target_twist", 1, std::bind(&DriveComponent::twistCallback, this, std::placeholders::_1));

  status_publisher_ = this->create_publisher<std_msgs::msg::String>(status_topic_, 1);

  // ステータスパブリッシュタイマー
  auto timer_period = std::chrono::duration<double>(1.0 / status_publish_rate_);
  status_timer_ =
      this->create_wall_timer(std::chrono::duration_cast<std::chrono::milliseconds>(timer_period),
                              std::bind(&DriveComponent::statusTimerCallback, this));

  // コマンド受信ウォッチドッグ（100ms 周期）。cmd_timeout_sec_ <= 0 で無効。
  if (drive_watchdog::isEnabled(cmd_timeout_sec_)) {
    watchdog_timer_ =
        this->create_wall_timer(100ms, std::bind(&DriveComponent::watchdogTimerCallback, this));
  } else {
    RCLCPP_WARN(this->get_logger(),
                "Command timeout watchdog disabled (cmd_timeout_sec <= 0); motors will keep the "
                "last command if /target_twist stops");
  }

  RCLCPP_INFO(this->get_logger(), "Drive Component initialized successfully");
}

DriveComponent::~DriveComponent() {
  if (motor_lib_ && motor_initialized_) {
    RCLCPP_INFO(this->get_logger(), "Shutting down motor library");
    if (diff_drive_) {
      diff_drive_->stop();
    }
    motor_lib_->emergencyStop();
    motor_lib_->shutdown();
  }
}

void DriveComponent::initializeParameters() {
  // DDTモータライブラリのパラメータを宣言
  this->declare_parameter("serial_port", "/dev/ttyACM0");
  this->declare_parameter("baud_rate", 115200);
  this->declare_parameter("wheel_radius", 0.1);
  this->declare_parameter("wheel_separation", 0.5);
  this->declare_parameter("left_motor_id", 1);
  this->declare_parameter("right_motor_id", 2);
  this->declare_parameter("max_motor_rpm", 1000);
  this->declare_parameter("status_publish_rate", 10.0);
  this->declare_parameter("status_topic", "/drive_motor_status");

  // 制御モード関連 (後方互換のため velocity 既定)
  this->declare_parameter("control_mode", std::string("velocity"));
  this->declare_parameter("current_kp", 0.005);
  this->declare_parameter("current_ki", 0.02);
  this->declare_parameter("max_current_amp", 2.0);
  this->declare_parameter("integral_limit_amp", 1.5);
  this->declare_parameter("current_zero_deadband_rpm", 5);
  this->declare_parameter("current_invert_measured", false);
  this->declare_parameter("max_linear_accel", 0.0);
  this->declare_parameter("max_angular_accel", 0.0);

  // 停止時の電気ブレーキ（velocity モードのみ有効）
  this->declare_parameter("brake_on_stop", true);

  // コマンド受信ウォッチドッグのタイムアウト [s]（velocity/current 両モードで有効）
  this->declare_parameter("cmd_timeout_sec", 0.5);

  // パラメータを取得
  serial_port_ = this->get_parameter("serial_port").as_string();
  baud_rate_ = this->get_parameter("baud_rate").as_int();
  wheel_radius_ = this->get_parameter("wheel_radius").as_double();
  wheel_separation_ = this->get_parameter("wheel_separation").as_double();
  left_motor_id_ = this->get_parameter("left_motor_id").as_int();
  right_motor_id_ = this->get_parameter("right_motor_id").as_int();
  max_motor_rpm_ = this->get_parameter("max_motor_rpm").as_int();
  status_publish_rate_ = this->get_parameter("status_publish_rate").as_double();
  status_topic_ = this->get_parameter("status_topic").as_string();
  control_mode_ = this->get_parameter("control_mode").as_string();
  current_kp_ = this->get_parameter("current_kp").as_double();
  current_ki_ = this->get_parameter("current_ki").as_double();
  max_current_amp_ = this->get_parameter("max_current_amp").as_double();
  integral_limit_amp_ = this->get_parameter("integral_limit_amp").as_double();
  current_zero_deadband_rpm_ = this->get_parameter("current_zero_deadband_rpm").as_int();
  current_invert_measured_ = this->get_parameter("current_invert_measured").as_bool();
  max_linear_accel_ = this->get_parameter("max_linear_accel").as_double();
  max_angular_accel_ = this->get_parameter("max_angular_accel").as_double();
  brake_on_stop_ = this->get_parameter("brake_on_stop").as_bool();
  cmd_timeout_sec_ = this->get_parameter("cmd_timeout_sec").as_double();

  RCLCPP_INFO(this->get_logger(), "Parameters initialized:");
  RCLCPP_INFO(this->get_logger(), "  serial_port: %s", serial_port_.c_str());
  RCLCPP_INFO(this->get_logger(), "  baud_rate: %d", baud_rate_);
  RCLCPP_INFO(this->get_logger(), "  wheel_radius: %.3f", wheel_radius_);
  RCLCPP_INFO(this->get_logger(), "  wheel_separation: %.3f", wheel_separation_);
  RCLCPP_INFO(this->get_logger(), "  left_motor_id: %d", left_motor_id_);
  RCLCPP_INFO(this->get_logger(), "  right_motor_id: %d", right_motor_id_);
  RCLCPP_INFO(this->get_logger(), "  max_motor_rpm: %d", max_motor_rpm_);
  RCLCPP_INFO(this->get_logger(), "  status_publish_rate: %.1f", status_publish_rate_);
  RCLCPP_INFO(this->get_logger(), "  status_topic: %s", status_topic_.c_str());
  RCLCPP_INFO(this->get_logger(), "  cmd_timeout_sec: %.2f", cmd_timeout_sec_);
  RCLCPP_INFO(this->get_logger(), "  control_mode: %s", control_mode_.c_str());
  if (control_mode_ == "current") {
    RCLCPP_INFO(
        this->get_logger(),
        "  current_kp: %.4f  current_ki: %.4f  max_current_amp: %.2f  integral_limit_amp: %.2f",
        current_kp_, current_ki_, max_current_amp_, integral_limit_amp_);
    RCLCPP_INFO(this->get_logger(), "  current_zero_deadband_rpm: %d", current_zero_deadband_rpm_);
  }
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

    // モータライブラリを初期化
    if (!motor_lib_->initialize()) {
      RCLCPP_ERROR(this->get_logger(), "Failed to initialize motor library");
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

void DriveComponent::twistCallback(const geometry_msgs::msg::Twist::SharedPtr msg) {
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
      has_last_cmd_ = false;
      last_cmd_linear_ = 0.0;
      last_cmd_angular_ = 0.0;
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
    has_last_cmd_ = false;
    last_cmd_linear_ = 0.0;
    last_cmd_angular_ = 0.0;
  }
}

void DriveComponent::statusTimerCallback() {
  if (!motor_initialized_ || !diff_drive_) {
    return;
  }

  try {
    auto status = diff_drive_->getDriveStatus();

    // ステータス情報をJSON風の文字列として作成
    std::string status_str =
        "{"
        "\"left_motor_id\":" +
        std::to_string(status.left_motor_id) +
        ","
        "\"right_motor_id\":" +
        std::to_string(status.right_motor_id) +
        ","
        "\"left_rpm\":" +
        std::to_string(status.left_rpm) +
        ","
        "\"right_rpm\":" +
        std::to_string(status.right_rpm) +
        ","
        "\"linear_velocity\":" +
        std::to_string(status.current_linear_velocity) +
        ","
        "\"angular_velocity\":" +
        std::to_string(status.current_angular_velocity) +
        ","
        "\"left_temperature\":" +
        std::to_string(status.left_temperature) +
        ","
        "\"right_temperature\":" +
        std::to_string(status.right_temperature) +
        ","
        "\"left_fault_code\":" +
        std::to_string(status.left_fault_code) +
        ","
        "\"right_fault_code\":" +
        std::to_string(status.right_fault_code) +
        ","
        "\"healthy\":" +
        (status.is_healthy ? "true" : "false") +
        ","
        "\"emergency_stop\":" +
        (emergency_stop_active_ ? "true" : "false") + "}";

    auto status_msg = std_msgs::msg::String();
    status_msg.data = status_str;
    status_publisher_->publish(status_msg);

    RCLCPP_DEBUG(this->get_logger(), "Current velocity: linear=%.3f, angular=%.3f",
                 status.current_linear_velocity, status.current_angular_velocity);

  } catch (const std::exception& e) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                          "Exception in status timer callback: %s", e.what());
  }
}

}  // namespace motor_control_app

// コンポーネントとして登録
RCLCPP_COMPONENTS_REGISTER_NODE(motor_control_app::DriveComponent)
