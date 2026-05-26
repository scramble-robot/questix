// Copyright 2026 scramble-robot
//
#include <chrono>
#include <geometry_msgs/msg/point.hpp>
#include <memory>
#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/joy.hpp>
#include <std_msgs/msg/bool.hpp>
#include <std_msgs/msg/int32.hpp>

#include "motor_control_lib/servo_control.hpp"

class ServoControlNode : public rclcpp::Node {
public:
  ServoControlNode() : Node("servo_control_node"), is_shooting_(false), last_button_state_(false) {
    // パラメーター宣言
    this->declare_parameter("port", "/dev/ttyUSB0");
    this->declare_parameter("baudrate", 115200);
    this->declare_parameter("pan_servo_id", 1);
    this->declare_parameter("tilt_servo_id", 2);
    this->declare_parameter("trigger_servo_id", 3);
    this->declare_parameter("fire_button", 0);         // 射撃ボタン（Aボタンなど）
    this->declare_parameter("fire_position", 1500);    // 射撃位置
    this->declare_parameter("home_position", 2048);    // ホーム位置
    this->declare_parameter("fire_duration_ms", 300);  // 射撃持続時間（ミリ秒）

    // パラメーター取得
    std::string port = this->get_parameter("port").as_string();
    int baudrate = this->get_parameter("baudrate").as_int();
    pan_servo_id_ = this->get_parameter("pan_servo_id").as_int();
    tilt_servo_id_ = this->get_parameter("tilt_servo_id").as_int();
    trigger_servo_id_ = this->get_parameter("trigger_servo_id").as_int();
    fire_button_ = this->get_parameter("fire_button").as_int();
    fire_position_ = this->get_parameter("fire_position").as_int();
    home_position_ = this->get_parameter("home_position").as_int();
    fire_duration_ms_ = this->get_parameter("fire_duration_ms").as_int();

    // サーボコントローラー初期化
    servo_controller_ = std::make_shared<motor_control_lib::FeetechServoController>(port, baudrate);
    if (!servo_controller_->connect()) {
      RCLCPP_ERROR(this->get_logger(), "Failed to connect to servo controller");
      return;
    }

    // 射撃コントローラー初期化
    shot_controller_ = std::make_unique<motor_control_lib::ShotController>(servo_controller_);

    // joyサブスクライバー作成
    joy_subscription_ = this->create_subscription<sensor_msgs::msg::Joy>(
        "/joy", 1, std::bind(&ServoControlNode::joyCallback, this, std::placeholders::_1));

    // 既存のサブスクライバー（互換性のため）
    aim_subscription_ = this->create_subscription<geometry_msgs::msg::Point>(
        "aim_target", 1, std::bind(&ServoControlNode::aimCallback, this, std::placeholders::_1));

    fire_subscription_ = this->create_subscription<std_msgs::msg::Bool>(
        "fire_trigger", 1, std::bind(&ServoControlNode::fireCallback, this, std::placeholders::_1));

    home_subscription_ = this->create_subscription<std_msgs::msg::Bool>(
        "return_home", 1, std::bind(&ServoControlNode::homeCallback, this, std::placeholders::_1));

    // パブリッシャー作成
    current_aim_publisher_ = this->create_publisher<geometry_msgs::msg::Point>("current_aim", 1);

    // 現在位置を定期的に公開
    timer_ = this->create_wall_timer(std::chrono::milliseconds(100),
                                     std::bind(&ServoControlNode::publishCurrentAim, this));

    // 最初にホーム位置に移動
    if (!shot_controller_->returnHome(pan_servo_id_, tilt_servo_id_, trigger_servo_id_,
                                      home_position_, home_position_, home_position_)) {
      RCLCPP_WARN(this->get_logger(), "Failed to move to initial home position");
    }

    RCLCPP_INFO(this->get_logger(), "Servo control node started");
    RCLCPP_INFO(this->get_logger(), "Fire button: %d, Fire position: %d, Home position: %d",
                fire_button_, fire_position_, home_position_);
  }

  ~ServoControlNode() {
    if (servo_controller_) {
      servo_controller_->disconnect();
    }
  }

private:
  void joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg) {
    if (!msg || msg->buttons.empty() || is_shooting_) {
      return;
    }

    // 指定されたボタンの状態をチェック
    if (fire_button_ >= 0 && fire_button_ < static_cast<int>(msg->buttons.size())) {
      bool current_button_state = msg->buttons[fire_button_] == 1;

      // ボタンが押された瞬間を検出（立ち上がりエッジ）
      if (current_button_state && !last_button_state_) {
        executeShotSequence();
      }

      last_button_state_ = current_button_state;
    }
  }

  void executeShotSequence() {
    if (is_shooting_) {
      return;  // 既に射撃中の場合は無視
    }

    is_shooting_ = true;
    RCLCPP_INFO(this->get_logger(), "Starting shot sequence...");

    // 1. 射撃位置に移動
    if (servo_controller_->setPosition(trigger_servo_id_, fire_position_, true)) {
      RCLCPP_INFO(this->get_logger(), "Moved to fire position (%d)", fire_position_);

      // 射撃持続時間待機
      std::this_thread::sleep_for(std::chrono::milliseconds(fire_duration_ms_));

      // 2. ホーム位置に戻る
      if (servo_controller_->setPosition(trigger_servo_id_, home_position_, true)) {
        RCLCPP_INFO(this->get_logger(), "Returned to home position (%d)", home_position_);
      } else {
        RCLCPP_ERROR(this->get_logger(), "Failed to return to home position");
      }
    } else {
      RCLCPP_ERROR(this->get_logger(), "Failed to move to fire position");
    }

    is_shooting_ = false;
    RCLCPP_INFO(this->get_logger(), "Shot sequence completed");
  }

  void aimCallback(const geometry_msgs::msg::Point::SharedPtr msg) {
    // Point.x = pan位置 (0-4095), Point.y = tilt位置 (0-4095)
    uint16_t pan_position = static_cast<uint16_t>(std::max(0.0, std::min(4095.0, msg->x)));
    uint16_t tilt_position = static_cast<uint16_t>(std::max(0.0, std::min(4095.0, msg->y)));

    if (shot_controller_->aimAt(pan_servo_id_, tilt_servo_id_, pan_position, tilt_position)) {
      RCLCPP_INFO(this->get_logger(), "Aiming at pan=%d, tilt=%d", pan_position, tilt_position);
    } else {
      RCLCPP_ERROR(this->get_logger(), "Failed to aim at target position");
    }
  }

  void fireCallback(const std_msgs::msg::Bool::SharedPtr msg) {
    if (msg->data) {
      // 射撃実行
      uint16_t fire_position = 1500;    // 射撃位置
      uint16_t return_position = 2048;  // 復帰位置（ニュートラル）
      double fire_duration = 0.3;       // 射撃持続時間（秒）

      if (shot_controller_->fire(trigger_servo_id_, fire_position, return_position,
                                 fire_duration)) {
        RCLCPP_INFO(this->get_logger(), "Fire executed successfully");
      } else {
        RCLCPP_ERROR(this->get_logger(), "Failed to execute fire");
      }
    }
  }

  void homeCallback(const std_msgs::msg::Bool::SharedPtr msg) {
    if (msg->data) {
      // ホーム位置に戻る
      if (shot_controller_->returnHome(pan_servo_id_, tilt_servo_id_, trigger_servo_id_)) {
        RCLCPP_INFO(this->get_logger(), "Returned to home position");
      } else {
        RCLCPP_ERROR(this->get_logger(), "Failed to return home");
      }
    }
  }

  void publishCurrentAim() {
    int32_t pan_position, tilt_position;
    if (shot_controller_->getCurrentAim(pan_servo_id_, tilt_servo_id_, pan_position,
                                        tilt_position)) {
      auto msg = std::make_unique<geometry_msgs::msg::Point>();
      msg->x = static_cast<double>(pan_position);
      msg->y = static_cast<double>(tilt_position);
      msg->z = 0.0;
      current_aim_publisher_->publish(std::move(msg));
    }
  }

  std::shared_ptr<motor_control_lib::FeetechServoController> servo_controller_;
  std::unique_ptr<motor_control_lib::ShotController> shot_controller_;

  int pan_servo_id_;
  int tilt_servo_id_;
  int trigger_servo_id_;
  int fire_button_;
  int fire_position_;
  int home_position_;
  int fire_duration_ms_;

  bool is_shooting_;
  bool last_button_state_;

  rclcpp::Subscription<sensor_msgs::msg::Joy>::SharedPtr joy_subscription_;
  rclcpp::Subscription<geometry_msgs::msg::Point>::SharedPtr aim_subscription_;
  rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr fire_subscription_;
  rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr home_subscription_;
  rclcpp::Publisher<geometry_msgs::msg::Point>::SharedPtr current_aim_publisher_;
  rclcpp::TimerBase::SharedPtr timer_;
};

int main(int argc, char** argv) {
  rclcpp::init(argc, argv);
  auto node = std::make_shared<ServoControlNode>();
  rclcpp::spin(node);
  rclcpp::shutdown();
  return 0;
}
