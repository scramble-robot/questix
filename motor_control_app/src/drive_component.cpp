#include "motor_control_app/drive_component.hpp"

#include <chrono>
#include <functional>

using namespace std::chrono_literals;

namespace motor_control_app {

DriveComponent::DriveComponent(const rclcpp::NodeOptions& options)
    : Node("drive_component", options), motor_initialized_(false), emergency_stop_active_(false) {
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
  RCLCPP_INFO(this->get_logger(), "  control_mode: %s", control_mode_.c_str());
  if (control_mode_ == "current") {
    RCLCPP_INFO(this->get_logger(),
                "  current_kp: %.4f  current_ki: %.4f  max_current_amp: %.2f  integral_limit_amp: %.2f",
                current_kp_, current_ki_, max_current_amp_, integral_limit_amp_);
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
    } else if (control_mode_ != "velocity") {
      RCLCPP_WARN(this->get_logger(),
                  "未知の control_mode '%s' - velocity モードにフォールバック",
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
  if (!motor_initialized_ || emergency_stop_active_ || !diff_drive_) {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                         "Motor not initialized or emergency stop active, ignoring twist command");
    return;
  }

  if (!diff_drive_->isHealthy()) {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                         "Motor not healthy, ignoring twist command");
    return;
  }

  // 速度指令をモータライブラリに送信
  if (!diff_drive_->setVelocity(msg->linear.x, msg->angular.z)) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                          "Failed to set motor velocity");
    return;
  }

  RCLCPP_DEBUG(this->get_logger(), "Velocity command sent: linear=%.3f, angular=%.3f",
               msg->linear.x, msg->angular.z);
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
