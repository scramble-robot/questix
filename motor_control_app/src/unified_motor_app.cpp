// Copyright 2026 scramble-robot
//
#include <chrono>
#include <geometry_msgs/msg/twist.hpp>
#include <memory>
#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/int32.hpp>
#include <std_msgs/msg/string.hpp>

#include "motor_control_lib/ddt_motor_lib.hpp"
#include "motor_control_lib/differential_drive.hpp"
#include "motor_control_lib/motor_manager.hpp"

using namespace std::chrono_literals;

class UnifiedMotorNode : public rclcpp::Node {
private:
  std::unique_ptr<motor_control_lib::MotorManager> motor_manager_;

  // ROS 2 通信
  rclcpp::Subscription<std_msgs::msg::Int32>::SharedPtr motor1_vel_sub_;
  rclcpp::Subscription<std_msgs::msg::Int32>::SharedPtr motor2_vel_sub_;
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr cmd_vel_sub_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr status_pub_;
  rclcpp::TimerBase::SharedPtr status_timer_;

  // パラメータ
  std::string serial_port_;
  int baud_rate_;
  double wheel_radius_;
  double wheel_separation_;
  int motor1_id_;
  int motor2_id_;
  int max_motor_rpm_;

public:
  UnifiedMotorNode() : Node("unified_motor_node") {
    RCLCPP_INFO(this->get_logger(), "統合モーター制御ノードを開始中...");

    // パラメータの宣言と取得
    initializeParameters();

    // モーターマネージャーの初期化
    if (!initializeMotorManager()) {
      RCLCPP_ERROR(this->get_logger(), "モーターマネージャーの初期化に失敗しました");
      return;
    }

    // ROS 2 通信の設定
    setupCommunication();

    RCLCPP_INFO(this->get_logger(), "統合モーター制御ノード初期化完了");
  }

  ~UnifiedMotorNode() {
    if (motor_manager_) {
      RCLCPP_INFO(this->get_logger(), "モーターマネージャーを停止中...");
      motor_manager_->emergencyStopAll();
      motor_manager_->shutdownAll();
    }
  }

private:
  void initializeParameters() {
    // パラメータを宣言
    this->declare_parameter("serial_port", "/dev/ttyACM0");
    this->declare_parameter("baud_rate", 115200);
    this->declare_parameter("wheel_radius", 0.1);
    this->declare_parameter("wheel_separation", 0.5);
    this->declare_parameter("motor1_id", 1);
    this->declare_parameter("motor2_id", 2);
    this->declare_parameter("max_motor_rpm", 1000);

    // パラメータを取得
    serial_port_ = this->get_parameter("serial_port").as_string();
    baud_rate_ = this->get_parameter("baud_rate").as_int();
    wheel_radius_ = this->get_parameter("wheel_radius").as_double();
    wheel_separation_ = this->get_parameter("wheel_separation").as_double();
    motor1_id_ = this->get_parameter("motor1_id").as_int();
    motor2_id_ = this->get_parameter("motor2_id").as_int();
    max_motor_rpm_ = this->get_parameter("max_motor_rpm").as_int();

    RCLCPP_INFO(this->get_logger(), "パラメータ初期化完了:");
    RCLCPP_INFO(this->get_logger(), "  モーター1 ID: %d", motor1_id_);
    RCLCPP_INFO(this->get_logger(), "  モーター2 ID: %d", motor2_id_);
    RCLCPP_INFO(this->get_logger(), "  シリアルポート: %s", serial_port_.c_str());
    RCLCPP_INFO(this->get_logger(), "  最大RPM: %d", max_motor_rpm_);
  }

  bool initializeMotorManager() {
    try {
      // モーターマネージャーを作成
      motor_manager_ = std::make_unique<motor_control_lib::MotorManager>();

      // DDTモータライブラリを作成
      auto ddt_motor = std::make_shared<motor_control_lib::DdtMotorLib>(serial_port_, baud_rate_);
      ddt_motor->setMaxRpm(max_motor_rpm_);

      // モーターマネージャーに登録
      motor_manager_->registerController("ddt_motor", ddt_motor);
      motor_manager_->registerIndividualMotorController("ddt_individual", ddt_motor);

      // 差動駆動コントローラーを作成して登録
      auto diff_drive = std::make_shared<motor_control_lib::DifferentialDrive>(
          ddt_motor, motor1_id_, motor2_id_, wheel_radius_, wheel_separation_);
      motor_manager_->registerDriveController("differential_drive", diff_drive);

      // 全コントローラーを初期化
      if (!motor_manager_->initializeAll()) {
        RCLCPP_ERROR(this->get_logger(), "コントローラーの初期化に失敗しました");
        return false;
      }

      // 個別モーターを初期化
      auto individual_controller = motor_manager_->getIndividualMotorController("ddt_individual");
      if (individual_controller) {
        if (!individual_controller->initializeMotor(motor1_id_) ||
            !individual_controller->initializeMotor(motor2_id_)) {
          RCLCPP_ERROR(this->get_logger(), "個別モーターの初期化に失敗しました");
          return false;
        }
      }

      RCLCPP_INFO(this->get_logger(), "モーターマネージャーが初期化されました");
      return true;

    } catch (const std::exception& e) {
      RCLCPP_ERROR(this->get_logger(), "モーターマネージャー初期化中に例外が発生: %s", e.what());
      return false;
    }
  }

  void setupCommunication() {
    // 個別モータ制御用サブスクライバー
    motor1_vel_sub_ = this->create_subscription<std_msgs::msg::Int32>(
        "motor1_velocity", 10,
        std::bind(&UnifiedMotorNode::motor1VelCallback, this, std::placeholders::_1));

    motor2_vel_sub_ = this->create_subscription<std_msgs::msg::Int32>(
        "motor2_velocity", 10,
        std::bind(&UnifiedMotorNode::motor2VelCallback, this, std::placeholders::_1));

    // 差動駆動用サブスクライバー
    cmd_vel_sub_ = this->create_subscription<geometry_msgs::msg::Twist>(
        "cmd_vel", 10, std::bind(&UnifiedMotorNode::cmdVelCallback, this, std::placeholders::_1));

    // パブリッシャー設定
    status_pub_ = this->create_publisher<std_msgs::msg::String>("unified_motor_status", 10);

    // ステータスタイマー
    status_timer_ =
        this->create_wall_timer(500ms, std::bind(&UnifiedMotorNode::statusCallback, this));
  }

  void motor1VelCallback(const std_msgs::msg::Int32::SharedPtr msg) {
    auto controller = motor_manager_->getIndividualMotorController("ddt_individual");
    if (!controller) {
      RCLCPP_WARN(this->get_logger(), "個別モータコントローラーが見つかりません");
      return;
    }

    int velocity_rpm = std::clamp(msg->data, -max_motor_rpm_, max_motor_rpm_);

    if (controller->setMotorVelocity(motor1_id_, velocity_rpm)) {
      RCLCPP_INFO(this->get_logger(), "モーター1速度設定: %d RPM", velocity_rpm);
    } else {
      RCLCPP_ERROR(this->get_logger(), "モーター1速度設定に失敗: %d RPM", velocity_rpm);
    }
  }

  void motor2VelCallback(const std_msgs::msg::Int32::SharedPtr msg) {
    auto controller = motor_manager_->getIndividualMotorController("ddt_individual");
    if (!controller) {
      RCLCPP_WARN(this->get_logger(), "個別モータコントローラーが見つかりません");
      return;
    }

    int velocity_rpm = std::clamp(msg->data, -max_motor_rpm_, max_motor_rpm_);

    if (controller->setMotorVelocity(motor2_id_, velocity_rpm)) {
      RCLCPP_INFO(this->get_logger(), "モーター2速度設定: %d RPM", velocity_rpm);
    } else {
      RCLCPP_ERROR(this->get_logger(), "モーター2速度設定に失敗: %d RPM", velocity_rpm);
    }
  }

  void cmdVelCallback(const geometry_msgs::msg::Twist::SharedPtr msg) {
    auto controller = motor_manager_->getDriveController("differential_drive");
    if (!controller) {
      RCLCPP_WARN(this->get_logger(), "差動駆動コントローラーが見つかりません");
      return;
    }

    if (controller->setVelocity(msg->linear.x, msg->angular.z)) {
      RCLCPP_DEBUG(this->get_logger(), "差動駆動速度設定: linear=%.3f, angular=%.3f", msg->linear.x,
                   msg->angular.z);
    } else {
      RCLCPP_ERROR(this->get_logger(), "差動駆動速度設定に失敗");
    }
  }

  void statusCallback() {
    if (!motor_manager_) {
      return;
    }

    try {
      auto system_status = motor_manager_->getSystemStatus();

      // システムステータスの作成
      std::string status_str =
          "{"
          "\"system\":{"
          "\"total_controllers\":" +
          std::to_string(system_status.total_controllers) +
          ","
          "\"healthy_controllers\":" +
          std::to_string(system_status.healthy_controllers) +
          ","
          "\"initialized_controllers\":" +
          std::to_string(system_status.initialized_controllers) +
          ","
          "\"all_healthy\":" +
          (motor_manager_->isAllHealthy() ? "true" : "false") +
          "},"
          "\"controllers\":{";

      bool first = true;
      for (const auto& [name, health] : system_status.controller_health) {
        if (!first) status_str += ",";
        status_str += "\"" + name + "\":{";
        status_str += "\"healthy\":";
        status_str += health ? "true" : "false";
        status_str += ",\"initialized\":";
        status_str += system_status.controller_initialized.at(name) ? "true" : "false";
        status_str += "}";
        first = false;
      }

      status_str += "}}";

      auto status_msg = std_msgs::msg::String();
      status_msg.data = status_str;
      status_pub_->publish(status_msg);

      RCLCPP_DEBUG(this->get_logger(), "システム状態 - 正常: %zu/%zu, 初期化済み: %zu/%zu",
                   system_status.healthy_controllers, system_status.total_controllers,
                   system_status.initialized_controllers, system_status.total_controllers);

    } catch (const std::exception& e) {
      RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                            "ステータスコールバックで例外発生: %s", e.what());
    }
  }
};

int main(int argc, char** argv) {
  rclcpp::init(argc, argv);

  auto node = std::make_shared<UnifiedMotorNode>();

  RCLCPP_INFO(node->get_logger(), "統合モーター制御アプリケーション開始");

  try {
    rclcpp::spin(node);
  } catch (const std::exception& e) {
    RCLCPP_ERROR(node->get_logger(), "実行中に例外発生: %s", e.what());
  }

  rclcpp::shutdown();
  return 0;
}
