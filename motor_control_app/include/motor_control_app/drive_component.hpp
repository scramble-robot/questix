// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__DRIVE_COMPONENT_HPP_
#define MOTOR_CONTROL_APP__DRIVE_COMPONENT_HPP_

#include <memory>
#include <string>

#include "geometry_msgs/msg/twist.hpp"
#include "motor_control_app/drive_watchdog.hpp"
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
   * @brief コマンド受信ウォッチドッグのタイマーコールバック
   *
   * /target_twist が cmd_timeout_sec_ 秒以上途絶えたらモータを停止します。
   */
  void watchdogTimerCallback();

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
  rclcpp::TimerBase::SharedPtr watchdog_timer_;

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

  // 制御モード関連
  std::string control_mode_;  // "velocity" | "current"
  double current_kp_;
  double current_ki_;
  double max_current_amp_;
  double integral_limit_amp_;
  int current_zero_deadband_rpm_;
  bool current_invert_measured_;

  // 加速度制限（スルーレート）
  double max_linear_accel_;   // [m/s^2] 負値または0で制限無効
  double max_angular_accel_;  // [rad/s^2] 負値または0で制限無効
  double last_cmd_linear_;
  double last_cmd_angular_;
  rclcpp::Time last_cmd_time_;
  bool has_last_cmd_;

  // コマンド受信ウォッチドッグ（velocity/current 両モードで有効）
  // /target_twist がこの秒数途絶えたら走行モータを停止する。0 以下で無効。
  double cmd_timeout_sec_;

  // 停止時の電気ブレーキ（velocity モードのみ）
  bool brake_on_stop_{true};

  // 指令送信後の追加待機 [ms]。0で無効（DDT M0602C の間隔要件用の保険）
  int command_wait_ms_{0};

  // 状態フラグ
  bool motor_initialized_;
  bool emergency_stop_active_;
};

}  // namespace motor_control_app

#endif  // MOTOR_CONTROL_APP__DRIVE_COMPONENT_HPP_
