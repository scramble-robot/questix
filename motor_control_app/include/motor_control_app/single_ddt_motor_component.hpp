// Copyright 2026 scramble-robot
//
#ifndef MOTOR_CONTROL_APP__SINGLE_DDT_MOTOR_COMPONENT_HPP_
#define MOTOR_CONTROL_APP__SINGLE_DDT_MOTOR_COMPONENT_HPP_

#include <memory>
#include <string>

#include "geometry_msgs/msg/twist.hpp"
#include "motor_control_lib/ddt_motor_lib.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp_components/register_node_macro.hpp"
#include "std_msgs/msg/string.hpp"

namespace motor_control_app {

/**
 * @brief 単一のDDTモータをcmd_velメッセージのx値で制御するコンポーネント
 *
 * geometry_msgs/Twistメッセージ（cmd_vel）のlinear.xの正負値に基づいて
 * 単一のDDTモータを前進/後退制御します。
 */
class SingleDdtMotorComponent : public rclcpp::Node {
public:
  /**
   * @brief コンストラクタ
   * @param options ノードオプション
   */
  explicit SingleDdtMotorComponent(const rclcpp::NodeOptions& options);

  /**
   * @brief デストラクタ
   */
  virtual ~SingleDdtMotorComponent();

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

  /**
   * @brief 線形速度をモータRPMに変換
   * @param linear_x 線形速度 (m/s)
   * @return モータRPM
   */
  int convertLinearVelocityToRpm(double linear_x);

  // ROS 2 通信
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr twist_subscription_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr status_publisher_;
  rclcpp::TimerBase::SharedPtr status_timer_;

  // モータ制御ライブラリ
  std::shared_ptr<motor_control_lib::DdtMotorLib> motor_lib_;

  // パラメータ
  std::string serial_port_;
  int baud_rate_;
  double wheel_radius_;
  int motor_id_;
  int max_motor_rpm_;
  double velocity_scale_factor_;  // 速度スケールファクター
  double status_publish_rate_;

  // 状態フラグ
  bool motor_initialized_;
  bool emergency_stop_active_;

  // ウォッチドッグタイマー関連
  rclcpp::TimerBase::SharedPtr watchdog_timer_;
  std::chrono::steady_clock::time_point last_twist_time_;
  double watchdog_timeout_;  // ウォッチドッグタイムアウト時間 (秒)
};

}  // namespace motor_control_app

#endif  // MOTOR_CONTROL_APP__SINGLE_DDT_MOTOR_COMPONENT_HPP_