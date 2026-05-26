// Copyright 2026 scramble-robot
//
#ifndef MOTOR_CONTROL_APP__DRIVE_COMPONENT_HPP_
#define MOTOR_CONTROL_APP__DRIVE_COMPONENT_HPP_

#include <memory>
#include <string>

#include "geometry_msgs/msg/twist.hpp"
#include "motor_control_lib/ddt_motor_lib.hpp"
#include "motor_control_lib/differential_drive.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp_components/register_node_macro.hpp"
#include "std_msgs/msg/string.hpp"

namespace motor_control_app {

/**
 * @brief DDTモータを使用したドライブコンポーネント
 *
 * geometry_msgs/Twistメッセージを受信してDDTモータを制御します。
 * ROS 2のコンポーネントシステムを使用して実装されています。
 */
class DriveComponent : public rclcpp::Node {
public:
  /**
   * @brief コンストラクタ
   * @param options ノードオプション
   */
  explicit DriveComponent(const rclcpp::NodeOptions& options);

  /**
   * @brief デストラクタ
   */
  virtual ~DriveComponent();

private:
  /**
   * @brief Twistメッセージのコールバック関数
   * @param msg 受信したTwistメッセージ
   */
  void twistCallback(const geometry_msgs::msg::Twist::SharedPtr msg);

  /**
   * @brief モータステータスをパブリッシュするタイマーコールバック
   */
  void statusTimerCallback();

  /**
   * @brief パラメータを初期化
   */
  void initializeParameters();

  /**
   * @brief DDTモータライブラリを初期化
   * @return 初期化成功/失敗
   */
  bool initializeMotorLib();

  // ROS 2 通信
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr twist_subscription_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr status_publisher_;
  rclcpp::TimerBase::SharedPtr status_timer_;

  // モータ制御ライブラリ
  std::shared_ptr<motor_control_lib::DdtMotorLib> motor_lib_;
  std::unique_ptr<motor_control_lib::DifferentialDrive> diff_drive_;

  // パラメータ
  std::string serial_port_;
  int baud_rate_;
  double wheel_radius_;
  double wheel_separation_;
  int left_motor_id_;
  int right_motor_id_;
  int max_motor_rpm_;
  double status_publish_rate_;
  std::string status_topic_;

  // 状態フラグ
  bool motor_initialized_;
  bool emergency_stop_active_;
};

}  // namespace motor_control_app

#endif  // MOTOR_CONTROL_APP__DRIVE_COMPONENT_HPP_
