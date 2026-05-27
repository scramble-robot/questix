// Copyright 2026 scramble-robot
//
#include "motor_control_app/single_ddt_motor_component.hpp"

#include <chrono>
#include <cmath>

using namespace std::chrono_literals;

namespace motor_control_app {

SingleDdtMotorComponent::SingleDdtMotorComponent(const rclcpp::NodeOptions& options)
    : Node("single_ddt_motor_component", options),
      motor_initialized_(false),
      emergency_stop_active_(false) {
  RCLCPP_INFO(this->get_logger(), "Initializing Single DDT Motor Component");

  // パラメータ初期化
  initializeParameters();

  // モータライブラリ初期化
  if (!initializeMotorLib()) {
    RCLCPP_ERROR(this->get_logger(), "Failed to initialize motor library");
    return;
  }

  // Twistメッセージのサブスクライバーを作成
  twist_subscription_ = this->create_subscription<geometry_msgs::msg::Twist>(
      "cmd_vel",  // 標準的なcmd_velトピックを使用
      rclcpp::QoS(10),
      std::bind(&SingleDdtMotorComponent::twistCallback, this, std::placeholders::_1));

  // ステータスパブリッシャーを作成
  status_publisher_ = this->create_publisher<std_msgs::msg::String>("motor_status", 10);

  // ステータスタイマーを作成
  auto status_timer_period = std::chrono::duration<double>(1.0 / status_publish_rate_);
  status_timer_ = this->create_wall_timer(
      std::chrono::duration_cast<std::chrono::nanoseconds>(status_timer_period),
      std::bind(&SingleDdtMotorComponent::statusTimerCallback, this));

  // ウォッチドッグタイマーを作成
  watchdog_timer_ = this->create_wall_timer(
      std::chrono::duration_cast<std::chrono::nanoseconds>(
          std::chrono::duration<double>(watchdog_timeout_)),
      [this]() {
        auto now = std::chrono::steady_clock::now();
        auto time_since_last_twist =
            std::chrono::duration_cast<std::chrono::duration<double>>(now - last_twist_time_)
                .count();

        if (time_since_last_twist > watchdog_timeout_) {
          RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 2000,
                               "No twist message received for %.2f seconds, stopping motor",
                               time_since_last_twist);
          if (motor_lib_) {
            motor_lib_->stopMotor(motor_id_);
          }
        }
      });

  last_twist_time_ = std::chrono::steady_clock::now();

  RCLCPP_INFO(this->get_logger(), "Single DDT Motor Component initialized successfully");
  RCLCPP_INFO(this->get_logger(), "Motor ID: %d, Serial Port: %s", motor_id_, serial_port_.c_str());
  RCLCPP_INFO(this->get_logger(), "Listening for cmd_vel messages...");
}

SingleDdtMotorComponent::~SingleDdtMotorComponent() {
  if (motor_lib_) {
    motor_lib_->stopMotor(motor_id_);
    motor_lib_->shutdown();
  }
  RCLCPP_INFO(this->get_logger(), "Single DDT Motor Component destroyed");
}

void SingleDdtMotorComponent::initializeParameters() {
  // パラメータの宣言とデフォルト値の設定
  this->declare_parameter("serial_port", "/dev/ttyACM0");
  this->declare_parameter("baud_rate", 57600);
  this->declare_parameter("wheel_radius", 0.1);
  this->declare_parameter("motor_id", 1);
  this->declare_parameter("max_motor_rpm", 100);
  this->declare_parameter("velocity_scale_factor", 60.0);  // デフォルトのスケールファクター
  this->declare_parameter("status_publish_rate", 5.0);
  this->declare_parameter("watchdog_timeout", 1.0);

  // パラメータ値を取得
  serial_port_ = this->get_parameter("serial_port").as_string();
  baud_rate_ = this->get_parameter("baud_rate").as_int();
  wheel_radius_ = this->get_parameter("wheel_radius").as_double();
  motor_id_ = this->get_parameter("motor_id").as_int();
  max_motor_rpm_ = this->get_parameter("max_motor_rpm").as_int();
  velocity_scale_factor_ = this->get_parameter("velocity_scale_factor").as_double();
  status_publish_rate_ = this->get_parameter("status_publish_rate").as_double();
  watchdog_timeout_ = this->get_parameter("watchdog_timeout").as_double();

  //   RCLCPP_INFO(this->get_logger(), "Parameters initialized:");
  //   RCLCPP_INFO(this->get_logger(), "  serial_port: %s", serial_port_.c_str());
  //   RCLCPP_INFO(this->get_logger(), "  baud_rate: %d", baud_rate_);
  //   RCLCPP_INFO(this->get_logger(), "  motor_id: %d", motor_id_);
  //   RCLCPP_INFO(this->get_logger(), "  max_motor_rpm: %d", max_motor_rpm_);
  //   RCLCPP_INFO(this->get_logger(), "  velocity_scale_factor: %.2f", velocity_scale_factor_);
}

bool SingleDdtMotorComponent::initializeMotorLib() {
  try {
    motor_lib_ = std::make_shared<motor_control_lib::DdtMotorLib>(serial_port_, baud_rate_);

    if (!motor_lib_->setMaxRpm(max_motor_rpm_)) {
      RCLCPP_ERROR(this->get_logger(), "Failed to set max RPM");
      return false;
    }

    if (!motor_lib_->initialize()) {
      RCLCPP_ERROR(this->get_logger(), "Failed to initialize DDT motor library");
      return false;
    }

    if (!motor_lib_->initializeMotor(motor_id_)) {
      RCLCPP_ERROR(this->get_logger(), "Failed to initialize motor %d", motor_id_);
      return false;
    }

    motor_initialized_ = true;
    RCLCPP_INFO(this->get_logger(), "Motor library initialized successfully");
    return true;

  } catch (const std::exception& e) {
    RCLCPP_ERROR(this->get_logger(), "Exception during motor initialization: %s", e.what());
    return false;
  }
}

int SingleDdtMotorComponent::convertLinearVelocityToRpm(double linear_x) {
  // 線形速度をRPMに変換
  // linear_x (m/s) * velocity_scale_factor = RPM
  double rpm_double = linear_x * velocity_scale_factor_;

  // RPMを整数に変換し、最大値でクランプ
  int rpm = static_cast<int>(std::round(rpm_double));

  if (rpm > max_motor_rpm_) {
    rpm = max_motor_rpm_;
  } else if (rpm < -max_motor_rpm_) {
    rpm = -max_motor_rpm_;
  }

  return rpm;
}

void SingleDdtMotorComponent::twistCallback(const geometry_msgs::msg::Twist::SharedPtr msg) {
  if (!motor_initialized_ || emergency_stop_active_) {
    return;
  }

  last_twist_time_ = std::chrono::steady_clock::now();

  // linear.xの値を取得
  double linear_x = msg->linear.x;

  // RPMに変換
  int target_rpm = convertLinearVelocityToRpm(linear_x);

  // モータに速度指令を送信
  if (!motor_lib_->setMotorVelocity(motor_id_, target_rpm)) {
    RCLCPP_ERROR(this->get_logger(), "Failed to set motor velocity: %d RPM", target_rpm);
    return;
  }

  RCLCPP_DEBUG(this->get_logger(), "Twist received - linear.x: %.3f m/s -> Motor %d: %d RPM",
               linear_x, motor_id_, target_rpm);
}

void SingleDdtMotorComponent::statusTimerCallback() {
  if (!motor_initialized_) {
    return;
  }

  int velocity_rpm = 0;
  uint8_t temperature = 0;
  uint8_t fault_code = 0;

  if (motor_lib_->getMotorStatus(motor_id_, velocity_rpm, temperature, fault_code)) {
    auto status_msg = std_msgs::msg::String();
    status_msg.data =
        "Motor ID: " + std::to_string(motor_id_) + ", RPM: " + std::to_string(velocity_rpm) +
        ", Temp: " + std::to_string(temperature) + "°C" + ", Fault: " + std::to_string(fault_code);

    status_publisher_->publish(status_msg);

    // 故障コードをチェック
    if (fault_code != 0) {
      RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 2000,
                           "Motor %d fault detected: code %d", motor_id_, fault_code);
    }
  } else {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                         "Failed to get motor status for motor %d", motor_id_);
  }
}

}  // namespace motor_control_app

// コンポーネントとして登録
RCLCPP_COMPONENTS_REGISTER_NODE(motor_control_app::SingleDdtMotorComponent)