// Copyright 2026 scramble-robot
//
#ifndef MOTOR_CONTROL_APP__JOY_AXIS_DRIVE_COMPONENT_HPP_
#define MOTOR_CONTROL_APP__JOY_AXIS_DRIVE_COMPONENT_HPP_

#include <memory>
#include <string>

#include "geometry_msgs/msg/twist.hpp"
#include "motor_control_lib/ddt_motor_lib.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp_components/register_node_macro.hpp"
#include "sensor_msgs/msg/joy.hpp"
#include "std_msgs/msg/string.hpp"

namespace motor_control_app {

/**
 * @brief Joyのaxis値で直接モータを制御するコンポーネント
 *
 * sensor_msgs/Joyメッセージのaxis値を受信し、
 * 左右のモータを独立して制御します。
 * 作動二輪型の足回り制御に使用します。
 */
class JoyAxisDriveComponent : public rclcpp::Node {
public:
  /**
   * @brief コンストラクタ
   * @param options ノードオプション
   */
  explicit JoyAxisDriveComponent(const rclcpp::NodeOptions& options);

  /**
   * @brief デストラクタ
   */
  virtual ~JoyAxisDriveComponent();

private:
  /**
   * @brief Joyメッセージのコールバック関数
   * @param msg 受信したJoyメッセージ
   */
  void joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg);

  /**
   * @brief モータステータスをパブリッシュするタイマーコールバック
   */
  void statusTimerCallback();

  /**
   * @brief パラメータを初期化
   */
  void initializeParameters();

  /**
   * @brief モータライブラリを初期化
   * @return 成功した場合はtrue
   */
  bool initializeMotorLib();

  /**
   * @brief axis値をRPMに変換
   * @param axis_value Joyのaxis値 (-1.0 ~ 1.0)
   * @return モータRPM値
   */
  int axisToRpm(double axis_value) const;

  // DDTモータライブラリ
  std::shared_ptr<motor_control_lib::DdtMotorLib> motor_lib_;

  // ROS 2パブリッシャー/サブスクライバー
  rclcpp::Subscription<sensor_msgs::msg::Joy>::SharedPtr joy_subscription_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr status_publisher_;
  rclcpp::Publisher<geometry_msgs::msg::Twist>::SharedPtr twist_publisher_;  // デバッグ用

  // タイマー
  rclcpp::TimerBase::SharedPtr status_timer_;

  // パラメータ
  std::string serial_port_;
  int baud_rate_;
  int left_motor_id_;
  int right_motor_id_;
  int max_motor_rpm_;
  double status_publish_rate_;
  int left_axis_index_;     // 左モータを制御するaxis番号
  int right_axis_index_;    // 右モータを制御するaxis番号
  bool invert_left_axis_;   // 左axisの反転フラグ
  bool invert_right_axis_;  // 右axisの反転フラグ
  bool publish_twist_;      // Twistメッセージをパブリッシュするか

  // 状態フラグ
  bool motor_initialized_;
  bool emergency_stop_active_;
};

}  // namespace motor_control_app

#endif  // MOTOR_CONTROL_APP__JOY_AXIS_DRIVE_COMPONENT_HPP_
