// Copyright 2026 scramble-robot
//
#include <geometry_msgs/msg/twist.hpp>
#include <iostream>
#include <memory>
#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/bool.hpp>
#include <std_msgs/msg/float64.hpp>

// シンプルなヘッダーオンリーライブラリの例
namespace motor_lib {

// シンプルなモーター制御クラス
class SimpleMotorController {
private:
  bool initialized_ = false;
  double velocity_x_ = 0.0;
  double velocity_z_ = 0.0;
  double shot_speed_ = 0.0;
  bool is_firing_ = false;

public:
  bool initialize() {
    initialized_ = true;
    std::cout << "モーター制御システム初期化完了" << std::endl;
    return true;
  }

  bool setVelocity(double linear_x, double angular_z) {
    if (!initialized_) return false;

    velocity_x_ = linear_x;
    velocity_z_ = angular_z;

    std::cout << "速度設定: linear=" << linear_x << ", angular=" << angular_z << std::endl;
    return true;
  }

  bool setShotSpeed(double speed) {
    if (!initialized_) return false;

    shot_speed_ = speed;
    std::cout << "射撃速度設定: " << speed << std::endl;
    return true;
  }

  bool fire() {
    if (!initialized_) return false;

    is_firing_ = true;
    std::cout << "射撃実行! 速度: " << shot_speed_ << std::endl;
    return true;
  }

  bool isHealthy() const { return initialized_ && !is_firing_; }

  void shutdown() {
    initialized_ = false;
    std::cout << "モーターシステム停止" << std::endl;
  }
};
}  // namespace motor_lib

class SimpleMotorNode : public rclcpp::Node {
private:
  motor_lib::SimpleMotorController controller_;

  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr cmd_vel_sub_;
  rclcpp::Subscription<std_msgs::msg::Float64>::SharedPtr shot_speed_sub_;
  rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr fire_sub_;
  rclcpp::Publisher<std_msgs::msg::Bool>::SharedPtr health_pub_;
  rclcpp::TimerBase::SharedPtr status_timer_;

public:
  SimpleMotorNode() : Node("simple_motor_node") {
    RCLCPP_INFO(this->get_logger(), "簡単なモーターノードを開始中...");

    // モーターコントローラー初期化
    if (!controller_.initialize()) {
      RCLCPP_ERROR(this->get_logger(), "モーター初期化に失敗しました");
      return;
    }

    // サブスクライバー設定
    cmd_vel_sub_ = this->create_subscription<geometry_msgs::msg::Twist>(
        "cmd_vel", 10, std::bind(&SimpleMotorNode::cmdVelCallback, this, std::placeholders::_1));

    shot_speed_sub_ = this->create_subscription<std_msgs::msg::Float64>(
        "shot_speed", 10,
        std::bind(&SimpleMotorNode::shotSpeedCallback, this, std::placeholders::_1));

    fire_sub_ = this->create_subscription<std_msgs::msg::Bool>(
        "fire", 10, std::bind(&SimpleMotorNode::fireCallback, this, std::placeholders::_1));

    // パブリッシャー設定
    health_pub_ = this->create_publisher<std_msgs::msg::Bool>("motor_health", 10);

    // ステータスタイマー
    status_timer_ = this->create_wall_timer(std::chrono::milliseconds(1000),
                                            std::bind(&SimpleMotorNode::statusCallback, this));

    RCLCPP_INFO(this->get_logger(), "SimpleMotorNode初期化完了");
  }

  ~SimpleMotorNode() { controller_.shutdown(); }

private:
  void cmdVelCallback(const geometry_msgs::msg::Twist::SharedPtr msg) {
    bool success = controller_.setVelocity(msg->linear.x, msg->angular.z);

    if (success) {
      RCLCPP_INFO(this->get_logger(), "速度コマンド受信: %.2f, %.2f", msg->linear.x,
                  msg->angular.z);
    } else {
      RCLCPP_WARN(this->get_logger(), "速度設定に失敗しました");
    }
  }

  void shotSpeedCallback(const std_msgs::msg::Float64::SharedPtr msg) {
    bool success = controller_.setShotSpeed(msg->data);

    if (success) {
      RCLCPP_INFO(this->get_logger(), "射撃速度設定: %.2f", msg->data);
    } else {
      RCLCPP_WARN(this->get_logger(), "射撃速度設定に失敗しました");
    }
  }

  void fireCallback(const std_msgs::msg::Bool::SharedPtr msg) {
    if (msg->data) {
      bool success = controller_.fire();

      if (success) {
        RCLCPP_INFO(this->get_logger(), "射撃実行!");
      } else {
        RCLCPP_WARN(this->get_logger(), "射撃実行に失敗しました");
      }
    }
  }

  void statusCallback() {
    auto health_msg = std_msgs::msg::Bool();
    health_msg.data = controller_.isHealthy();
    health_pub_->publish(health_msg);

    RCLCPP_DEBUG(this->get_logger(), "ヘルスステータス: %s", health_msg.data ? "OK" : "NG");
  }
};

int main(int argc, char** argv) {
  rclcpp::init(argc, argv);

  auto node = std::make_shared<SimpleMotorNode>();

  RCLCPP_INFO(node->get_logger(), "シンプルなモーターアプリケーション開始");

  rclcpp::spin(node);

  rclcpp::shutdown();
  return 0;
}
