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
#include "rclcpp_lifecycle/lifecycle_node.hpp"
#include "rclcpp_lifecycle/lifecycle_publisher.hpp"
#include "std_msgs/msg/string.hpp"

namespace motor_control_app {

/**
 * @brief DDTモータを使用したドライブコンポーネント（Lifecycle ノード）
 *
 * geometry_msgs/Twistメッセージを受信してDDTモータを制御します。
 *
 * 非常停止中はモータが通電されず、シリアル接続（/dev/ttyACM0 の USB CDC）が
 * 得られない。そのため起動時は unconfigured で待機し、通電後に
 * configure（シリアル接続 + モータ初期化）→ activate（twist 受付開始）で
 * 運用状態に遷移する。auto_start=true（既定）の場合、内蔵タイマーが
 * configure/activate を成功するまで再試行するので、外部の lifecycle manager
 * なしで systemd 起動に耐える（shot_component と同パターン）。
 */
class DriveComponent : public rclcpp_lifecycle::LifecycleNode {
public:
  using CallbackReturn = rclcpp_lifecycle::node_interfaces::LifecycleNodeInterface::CallbackReturn;

  /**
   * @brief コンストラクタ
   * @param options ノードオプション
   */
  explicit DriveComponent(const rclcpp::NodeOptions& options);

  /**
   * @brief デストラクタ
   */
  ~DriveComponent() override;

  CallbackReturn on_configure(const rclcpp_lifecycle::State& state) override;
  CallbackReturn on_activate(const rclcpp_lifecycle::State& state) override;
  CallbackReturn on_deactivate(const rclcpp_lifecycle::State& state) override;
  CallbackReturn on_cleanup(const rclcpp_lifecycle::State& state) override;
  CallbackReturn on_shutdown(const rclcpp_lifecycle::State& state) override;
  CallbackReturn on_error(const rclcpp_lifecycle::State& state) override;

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
   * @brief auto_start タイマーコールバック
   *
   * unconfigured なら configure、inactive なら activate を試行し、
   * active に到達したらタイマーを止める（手動 deactivate を自動で覆さない）。
   */
  void autoStartTimerCallback();

  /**
   * @brief パラメータを宣言（コンストラクタで一度だけ呼ぶ）
   */
  void declareParameters();

  /**
   * @brief パラメータを取得（on_configure で呼び、cleanup→configure で再読込可能にする）
   */
  void readParameters();

  /**
   * @brief DDTモータライブラリを初期化
   * @return 初期化成功/失敗
   */
  bool initializeMotorLib();

  /**
   * @brief モータライブラリを安全に停止・解放（何度呼んでも安全）
   */
  void shutdownMotorLib();

  /**
   * @brief スルーレート制限用のコマンド状態をリセット
   */
  void resetCommandState();

  // ROS 2 通信
  // Twist/status/watchdog/auto-start callbacks intentionally share the node's default
  // MutuallyExclusive callback group, so callbacks do not run concurrently. If entities are
  // split across callback groups, synchronize motor_initialized_, diff_drive_, command state,
  // timer pointers, and all motor serial operations before enabling concurrent execution.
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr twist_subscription_;
  rclcpp_lifecycle::LifecyclePublisher<std_msgs::msg::String>::SharedPtr status_publisher_;
  rclcpp::TimerBase::SharedPtr status_timer_;
  rclcpp::TimerBase::SharedPtr watchdog_timer_;
  rclcpp::TimerBase::SharedPtr auto_start_timer_;

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

  // Lifecycle 自動起動（モータ通電まで configure を再試行する）
  bool auto_start_{true};
  double connect_retry_period_sec_{1.0};

  // 状態フラグ
  bool motor_initialized_;
  bool emergency_stop_active_;
};

}  // namespace motor_control_app

#endif  // MOTOR_CONTROL_APP__DRIVE_COMPONENT_HPP_
