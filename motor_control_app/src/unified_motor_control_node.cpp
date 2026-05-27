// Copyright 2026 scramble-robot
//
#include <geometry_msgs/msg/twist.hpp>
#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/joy.hpp>
#include <std_msgs/msg/bool.hpp>
#include <std_msgs/msg/float64.hpp>

#include "motor_control_lib/motor_control_lib.hpp"

class UnifiedMotorControlNode : public rclcpp::Node {
public:
  UnifiedMotorControlNode() : Node("unified_motor_control_node") {
    // パラメータの宣言
    this->declare_parameter("drive_port", "/dev/ttyACM0");
    this->declare_parameter("esc_pin", 13);
    this->declare_parameter("servo_port", "/dev/ttyUSB0");
    this->declare_parameter("auto_setup", true);

    // パラメータの取得
    std::string drive_port = this->get_parameter("drive_port").as_string();
    int esc_pin = this->get_parameter("esc_pin").as_int();
    std::string servo_port = this->get_parameter("servo_port").as_string();
    bool auto_setup = this->get_parameter("auto_setup").as_bool();

    // モータコントローラーのセットアップ
    if (auto_setup) {
      // 簡単セットアップ
      if (!motor_control_lib::QuickSetup::setupStandardRobot(controller_, drive_port, esc_pin,
                                                             servo_port)) {
        RCLCPP_ERROR(this->get_logger(), "標準ロボット構成のセットアップに失敗しました");
        return;
      }
    } else {
      // 手動セットアップの例
      setupMotorsManually();
    }

    // モータの初期化
    if (!controller_.initialize()) {
      RCLCPP_ERROR(this->get_logger(), "モータコントローラーの初期化に失敗しました");
      return;
    }

    // ROS2通信の設定
    setupRosCommunication();

    // ステータス表示
    std::string status = motor_control_lib::SystemMonitor::getSystemStatus(controller_);
    RCLCPP_INFO(this->get_logger(), "システム初期化完了:\n%s", status.c_str());

    // タイマーの設定
    status_timer_ = this->create_wall_timer(
        std::chrono::seconds(5), std::bind(&UnifiedMotorControlNode::statusCallback, this));
  }

  ~UnifiedMotorControlNode() { controller_.shutdown(); }

private:
  motor_control_lib::UnifiedMotorController controller_;

  // ROS2 Subscribers
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr cmd_vel_sub_;
  rclcpp::Subscription<sensor_msgs::msg::Joy>::SharedPtr joy_sub_;
  rclcpp::Subscription<std_msgs::msg::Float64>::SharedPtr shot_speed_sub_;
  rclcpp::Subscription<std_msgs::msg::Float64>::SharedPtr shot_angle_sub_;
  rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr fire_sub_;

  // ROS2 Publishers
  rclcpp::Publisher<std_msgs::msg::Bool>::SharedPtr health_pub_;

  // Timer
  rclcpp::TimerBase::SharedPtr status_timer_;

  void setupMotorsManually() {
    // DDTモータ（Drive用）の手動設定例
    auto ddt_config = motor_control_lib::MotorFactory::createConfig("ddt", "main_drive", "drive");
    ddt_config.string_params["serial_port"] = "/dev/ttyACM0";
    ddt_config.int_params["baud_rate"] = 115200;
    ddt_config.double_params["wheel_radius"] = 0.1;
    ddt_config.double_params["wheel_separation"] = 0.5;
    controller_.addMotor(ddt_config);

    // ESCモータ（Shot用）の手動設定例
    auto esc_config = motor_control_lib::MotorFactory::createConfig("esc", "launcher", "shot");
    esc_config.int_params["pwm_pin"] = 13;
    esc_config.bool_params["test_mode"] = true;
    controller_.addMotor(esc_config);

    // サーボモータ（Shot用）の手動設定例
    auto servo_config = motor_control_lib::MotorFactory::createConfig("servo", "turret", "shot");
    servo_config.string_params["port"] = "/dev/ttyUSB0";
    servo_config.int_params["servo_id"] = 1;
    controller_.addMotor(servo_config);

    RCLCPP_INFO(this->get_logger(), "手動でモータ構成をセットアップしました");
  }

  void setupRosCommunication() {
    // Subscribers
    cmd_vel_sub_ = this->create_subscription<geometry_msgs::msg::Twist>(
        "cmd_vel", 10,
        std::bind(&UnifiedMotorControlNode::cmdVelCallback, this, std::placeholders::_1));

    joy_sub_ = this->create_subscription<sensor_msgs::msg::Joy>(
        "joy", 10, std::bind(&UnifiedMotorControlNode::joyCallback, this, std::placeholders::_1));

    shot_speed_sub_ = this->create_subscription<std_msgs::msg::Float64>(
        "shot_speed", 10,
        std::bind(&UnifiedMotorControlNode::shotSpeedCallback, this, std::placeholders::_1));

    shot_angle_sub_ = this->create_subscription<std_msgs::msg::Float64>(
        "shot_angle", 10,
        std::bind(&UnifiedMotorControlNode::shotAngleCallback, this, std::placeholders::_1));

    fire_sub_ = this->create_subscription<std_msgs::msg::Bool>(
        "fire_command", 10,
        std::bind(&UnifiedMotorControlNode::fireCallback, this, std::placeholders::_1));

    // Publishers
    health_pub_ = this->create_publisher<std_msgs::msg::Bool>("system_health", 10);

    RCLCPP_INFO(this->get_logger(), "ROS2通信が設定されました");
  }

  void cmdVelCallback(const geometry_msgs::msg::Twist::SharedPtr msg) {
    bool success = controller_.setVelocity(msg->linear.x, msg->angular.z);
    if (!success) {
      RCLCPP_WARN(this->get_logger(), "速度指令の送信に失敗しました");
    }
  }

  void joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg) {
    // ジョイスティック制御例
    if (msg->buttons.size() > 0 && msg->axes.size() > 1) {
      // 緊急停止ボタン（ボタン0）
      if (msg->buttons[0] == 1) {
        controller_.emergencyStopAll();
        RCLCPP_WARN(this->get_logger(), "ジョイスティックからの緊急停止");
        return;
      }

      // 移動制御（左スティック）
      double linear_x = msg->axes[1] * 1.0;   // 最大1.0 m/s
      double angular_z = msg->axes[0] * 1.0;  // 最大1.0 rad/s
      controller_.setVelocity(linear_x, angular_z);

      // 発射ボタン（ボタン1）
      if (msg->buttons.size() > 1 && msg->buttons[1] == 1) {
        controller_.executeFire();
        RCLCPP_INFO(this->get_logger(), "ジョイスティックから発射指令");
      }
    }
  }

  void shotSpeedCallback(const std_msgs::msg::Float64::SharedPtr msg) {
    // 現在の角度を保持して速度のみ更新
    bool success = controller_.setShotParameters(msg->data, 0.0, "");
    if (!success) {
      RCLCPP_WARN(this->get_logger(), "発射速度の設定に失敗しました");
    }
  }

  void shotAngleCallback(const std_msgs::msg::Float64::SharedPtr msg) {
    // 現在の速度を保持して角度のみ更新
    bool success = controller_.setShotParameters(0.0, msg->data, "");
    if (!success) {
      RCLCPP_WARN(this->get_logger(), "発射角度の設定に失敗しました");
    }
  }

  void fireCallback(const std_msgs::msg::Bool::SharedPtr msg) {
    if (msg->data) {
      bool success = controller_.executeFire();
      if (success) {
        RCLCPP_INFO(this->get_logger(), "発射を実行しました");
      } else {
        RCLCPP_WARN(this->get_logger(), "発射の実行に失敗しました");
      }
    }
  }

  void statusCallback() {
    // システム健康状態の配信
    auto health_msg = std_msgs::msg::Bool();
    health_msg.data = controller_.isHealthy();
    health_pub_->publish(health_msg);

    // ログでの状態表示
    if (controller_.isHealthy()) {
      RCLCPP_DEBUG(this->get_logger(), "システム正常動作中");
    } else {
      RCLCPP_WARN(this->get_logger(), "システムにエラーが検出されました");
    }
  }
  int main(int argc, char** argv) {
    rclcpp::init(argc, argv);

    try {
      auto node = std::make_shared<UnifiedMotorControlNode>();
      rclcpp::spin(node);
    } catch (const std::exception& e) {
      RCLCPP_ERROR(rclcpp::get_logger("main"), "ノードの実行中にエラーが発生しました: %s",
                   e.what());
      return 1;
    }

    rclcpp::shutdown();
    return 0;
  }
