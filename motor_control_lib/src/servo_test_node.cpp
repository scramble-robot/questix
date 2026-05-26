// Copyright 2026 scramble-robot
//
#include <chrono>
#include <geometry_msgs/msg/point.hpp>
#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/bool.hpp>
#include <std_msgs/msg/int32.hpp>

class ServoTestNode : public rclcpp::Node {
public:
  ServoTestNode() : Node("servo_test_node") {
    // パブリッシャー作成
    aim_publisher_ = this->create_publisher<geometry_msgs::msg::Point>("aim_target", 1);
    fire_publisher_ = this->create_publisher<std_msgs::msg::Bool>("fire_trigger", 1);
    home_publisher_ = this->create_publisher<std_msgs::msg::Bool>("return_home", 1);

    // サブスクライバー作成（現在位置確認用）
    current_aim_subscription_ = this->create_subscription<geometry_msgs::msg::Point>(
        "current_aim", 1,
        std::bind(&ServoTestNode::currentAimCallback, this, std::placeholders::_1));

    // テストシーケンス実行タイマー
    test_timer_ = this->create_wall_timer(std::chrono::seconds(1),
                                          std::bind(&ServoTestNode::executeTestSequence, this));

    test_step_ = 0;
    RCLCPP_INFO(this->get_logger(), "Servo test node started - will execute test sequence");
  }

private:
  void currentAimCallback(const geometry_msgs::msg::Point::SharedPtr msg) {
    RCLCPP_INFO(this->get_logger(), "Current aim: pan=%.0f, tilt=%.0f", msg->x, msg->y);
  }

  void executeTestSequence() {
    switch (test_step_) {
      case 0:
        RCLCPP_INFO(this->get_logger(), "Step 1: Moving to home position");
        returnHome();
        break;
      case 5:
        RCLCPP_INFO(this->get_logger(), "Step 2: Aiming at target position 1");
        aimAt(1800, 1800);  // 左上
        break;
      case 10:
        RCLCPP_INFO(this->get_logger(), "Step 3: Firing");
        fire();
        break;
      case 12:
        RCLCPP_INFO(this->get_logger(), "Step 4: Aiming at target position 2");
        aimAt(2300, 2300);  // 右下
        break;
      case 17:
        RCLCPP_INFO(this->get_logger(), "Step 5: Firing");
        fire();
        break;
      case 19:
        RCLCPP_INFO(this->get_logger(), "Step 6: Returning to home");
        returnHome();
        break;
      case 24:
        RCLCPP_INFO(this->get_logger(), "Test sequence completed!");
        test_timer_->cancel();
        break;
    }
    test_step_++;
  }

  void aimAt(double pan, double tilt) {
    auto msg = std::make_unique<geometry_msgs::msg::Point>();
    msg->x = pan;
    msg->y = tilt;
    msg->z = 0.0;
    aim_publisher_->publish(std::move(msg));
  }

  void fire() {
    auto msg = std::make_unique<std_msgs::msg::Bool>();
    msg->data = true;
    fire_publisher_->publish(std::move(msg));
  }

  void returnHome() {
    auto msg = std::make_unique<std_msgs::msg::Bool>();
    msg->data = true;
    home_publisher_->publish(std::move(msg));
  }

  rclcpp::Publisher<geometry_msgs::msg::Point>::SharedPtr aim_publisher_;
  rclcpp::Publisher<std_msgs::msg::Bool>::SharedPtr fire_publisher_;
  rclcpp::Publisher<std_msgs::msg::Bool>::SharedPtr home_publisher_;
  rclcpp::Subscription<geometry_msgs::msg::Point>::SharedPtr current_aim_subscription_;
  rclcpp::TimerBase::SharedPtr test_timer_;
  int test_step_;
};

int main(int argc, char** argv) {
  rclcpp::init(argc, argv);
  auto node = std::make_shared<ServoTestNode>();
  rclcpp::spin(node);
  rclcpp::shutdown();
  return 0;
}
