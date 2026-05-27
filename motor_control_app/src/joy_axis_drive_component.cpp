// Copyright 2026 scramble-robot
//
#include "motor_control_app/joy_axis_drive_component.hpp"

#include <chrono>
#include <functional>

using namespace std::chrono_literals;

namespace motor_control_app {

JoyAxisDriveComponent::JoyAxisDriveComponent(const rclcpp::NodeOptions& options)
    : Node("joy_axis_drive", options), motor_initialized_(false), emergency_stop_active_(false) {
  RCLCPP_INFO(this->get_logger(), "Initializing Joy Axis Drive Component");

  // パラメータを初期化
  initializeParameters();

  // DDTモータライブラリを初期化
  if (!initializeMotorLib()) {
    RCLCPP_ERROR(this->get_logger(), "Failed to initialize motor library");
    return;
  }

  // ROS 2 通信の設定
  joy_subscription_ = this->create_subscription<sensor_msgs::msg::Joy>(
      "/joy", 1, std::bind(&JoyAxisDriveComponent::joyCallback, this, std::placeholders::_1));

  status_publisher_ = this->create_publisher<std_msgs::msg::String>("motor_status", 10);

  // デバッグ用Twistパブリッシャー(オプション)
  if (publish_twist_) {
    twist_publisher_ = this->create_publisher<geometry_msgs::msg::Twist>("current_twist", 10);
  }

  // ステータスパブリッシュタイマー
  auto timer_period = std::chrono::duration<double>(1.0 / status_publish_rate_);
  status_timer_ =
      this->create_wall_timer(std::chrono::duration_cast<std::chrono::milliseconds>(timer_period),
                              std::bind(&JoyAxisDriveComponent::statusTimerCallback, this));

  RCLCPP_INFO(this->get_logger(), "Joy Axis Drive Component initialized successfully");
}

JoyAxisDriveComponent::~JoyAxisDriveComponent() {
  if (motor_lib_ && motor_initialized_) {
    RCLCPP_INFO(this->get_logger(), "Shutting down motor library");
    motor_lib_->stopAllMotors();
    motor_lib_->emergencyStop();
    motor_lib_->shutdown();
  }
}

void JoyAxisDriveComponent::initializeParameters() {
  // DDTモータライブラリのパラメータを宣言
  this->declare_parameter("serial_port", "/dev/ttyACM0");
  this->declare_parameter("baud_rate", 115200);
  this->declare_parameter("left_motor_id", 1);
  this->declare_parameter("right_motor_id", 2);
  this->declare_parameter("max_motor_rpm", 1000);
  this->declare_parameter("status_publish_rate", 10.0);
  this->declare_parameter("left_axis_index", 1);   // 左スティック縦軸
  this->declare_parameter("right_axis_index", 4);  // 右スティック縦軸
  this->declare_parameter("invert_left_axis", false);
  this->declare_parameter("invert_right_axis", false);
  this->declare_parameter("publish_twist", false);

  // パラメータを取得
  serial_port_ = this->get_parameter("serial_port").as_string();
  baud_rate_ = this->get_parameter("baud_rate").as_int();
  left_motor_id_ = this->get_parameter("left_motor_id").as_int();
  right_motor_id_ = this->get_parameter("right_motor_id").as_int();
  max_motor_rpm_ = this->get_parameter("max_motor_rpm").as_int();
  status_publish_rate_ = this->get_parameter("status_publish_rate").as_double();
  left_axis_index_ = this->get_parameter("left_axis_index").as_int();
  right_axis_index_ = this->get_parameter("right_axis_index").as_int();
  invert_left_axis_ = this->get_parameter("invert_left_axis").as_bool();
  invert_right_axis_ = this->get_parameter("invert_right_axis").as_bool();
  publish_twist_ = this->get_parameter("publish_twist").as_bool();

  RCLCPP_INFO(this->get_logger(), "Parameters initialized:");
  RCLCPP_INFO(this->get_logger(), "  serial_port: %s", serial_port_.c_str());
  RCLCPP_INFO(this->get_logger(), "  baud_rate: %d", baud_rate_);
  RCLCPP_INFO(this->get_logger(), "  left_motor_id: %d", left_motor_id_);
  RCLCPP_INFO(this->get_logger(), "  right_motor_id: %d", right_motor_id_);
  RCLCPP_INFO(this->get_logger(), "  max_motor_rpm: %d", max_motor_rpm_);
  RCLCPP_INFO(this->get_logger(), "  status_publish_rate: %.1f", status_publish_rate_);
  RCLCPP_INFO(this->get_logger(), "  left_axis_index: %d", left_axis_index_);
  RCLCPP_INFO(this->get_logger(), "  right_axis_index: %d", right_axis_index_);
  RCLCPP_INFO(this->get_logger(), "  invert_left_axis: %s", invert_left_axis_ ? "true" : "false");
  RCLCPP_INFO(this->get_logger(), "  invert_right_axis: %s", invert_right_axis_ ? "true" : "false");
  RCLCPP_INFO(this->get_logger(), "  publish_twist: %s", publish_twist_ ? "true" : "false");
}

bool JoyAxisDriveComponent::initializeMotorLib() {
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

    // 個別モーターを初期化
    if (!motor_lib_->initializeMotor(left_motor_id_) ||
        !motor_lib_->initializeMotor(right_motor_id_)) {
      RCLCPP_ERROR(this->get_logger(), "Failed to initialize individual motors");
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

int JoyAxisDriveComponent::axisToRpm(double axis_value) const {
  // axis値は通常 -1.0 ~ 1.0 の範囲
  // これをmax_motor_rpmの範囲にマッピング
  double clamped_value = std::max(-1.0, std::min(1.0, axis_value));
  return static_cast<int>(clamped_value * max_motor_rpm_);
}

void JoyAxisDriveComponent::joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg) {
  if (!motor_initialized_ || emergency_stop_active_) {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                         "Motor not initialized or emergency stop active, ignoring joy command");
    return;
  }

  if (!motor_lib_->isHealthy()) {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                         "Motor not healthy, ignoring joy command");
    return;
  }

  // axis値の範囲チェック
  if (static_cast<size_t>(left_axis_index_) >= msg->axes.size() ||
      static_cast<size_t>(right_axis_index_) >= msg->axes.size()) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                          "Invalid axis index. Left: %d, Right: %d, Available: %zu",
                          left_axis_index_, right_axis_index_, msg->axes.size());
    return;
  }

  // axis値を取得
  double left_axis_value = msg->axes[left_axis_index_];
  double right_axis_value = msg->axes[right_axis_index_];

  // 反転フラグを適用
  if (invert_left_axis_) {
    left_axis_value = -left_axis_value;
  }
  if (invert_right_axis_) {
    right_axis_value = -right_axis_value;
  }

  // RPMに変換
  int left_rpm = axisToRpm(left_axis_value);
  int right_rpm = axisToRpm(right_axis_value);

  // モータに速度指令を送信
  if (!motor_lib_->setMotorVelocity(left_motor_id_, left_rpm)) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                          "Failed to set left motor velocity");
    return;
  }

  if (!motor_lib_->setMotorVelocity(right_motor_id_, right_rpm)) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                          "Failed to set right motor velocity");
    return;
  }

  RCLCPP_DEBUG(this->get_logger(), "Motor command sent: left_rpm=%d, right_rpm=%d", left_rpm,
               right_rpm);

  // デバッグ用Twistメッセージをパブリッシュ(オプション)
  if (publish_twist_ && twist_publisher_) {
    auto twist_msg = geometry_msgs::msg::Twist();
    // 簡易的な変換（実際の速度ではなく、axis値を表現）
    twist_msg.linear.x = (left_axis_value + right_axis_value) / 2.0;
    twist_msg.angular.z = (right_axis_value - left_axis_value) / 2.0;
    twist_publisher_->publish(twist_msg);
  }
}

void JoyAxisDriveComponent::statusTimerCallback() {
  if (!motor_initialized_) {
    return;
  }

  try {
    // 左モータのステータスを取得
    int left_rpm = 0;
    uint8_t left_temperature = 0;
    uint8_t left_fault_code = 0;
    bool left_ok =
        motor_lib_->getMotorStatus(left_motor_id_, left_rpm, left_temperature, left_fault_code);

    // 右モータのステータスを取得
    int right_rpm = 0;
    uint8_t right_temperature = 0;
    uint8_t right_fault_code = 0;
    bool right_ok =
        motor_lib_->getMotorStatus(right_motor_id_, right_rpm, right_temperature, right_fault_code);

    bool is_healthy = left_ok && right_ok && motor_lib_->isHealthy();

    // ステータス情報をJSON風の文字列として作成
    std::string status_str =
        "{"
        "\"left_motor_id\":" +
        std::to_string(left_motor_id_) +
        ","
        "\"right_motor_id\":" +
        std::to_string(right_motor_id_) +
        ","
        "\"left_rpm\":" +
        std::to_string(left_rpm) +
        ","
        "\"right_rpm\":" +
        std::to_string(right_rpm) +
        ","
        "\"left_temperature\":" +
        std::to_string(left_temperature) +
        ","
        "\"right_temperature\":" +
        std::to_string(right_temperature) +
        ","
        "\"left_fault_code\":" +
        std::to_string(left_fault_code) +
        ","
        "\"right_fault_code\":" +
        std::to_string(right_fault_code) +
        ","
        "\"healthy\":" +
        (is_healthy ? "true" : "false") +
        ","
        "\"emergency_stop\":" +
        (emergency_stop_active_ ? "true" : "false") + "}";

    auto status_msg = std_msgs::msg::String();
    status_msg.data = status_str;
    status_publisher_->publish(status_msg);

    RCLCPP_DEBUG(this->get_logger(), "Motor status: left_rpm=%d, right_rpm=%d", left_rpm,
                 right_rpm);

  } catch (const std::exception& e) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                          "Exception in status timer callback: %s", e.what());
  }
}

}  // namespace motor_control_app

// コンポーネントとして登録
RCLCPP_COMPONENTS_REGISTER_NODE(motor_control_app::JoyAxisDriveComponent)
