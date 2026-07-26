// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__DRIVE_COMPONENT_HPP_
#define MOTOR_CONTROL_APP__DRIVE_COMPONENT_HPP_

#include <memory>
#include <string>

#include "geometry_msgs/msg/transform_stamped.hpp"
#include "geometry_msgs/msg/twist.hpp"
#include "motor_control_app/drive_watchdog.hpp"
#include "motor_control_app/odometry_integrator.hpp"
#include "motor_control_lib/ddt_motor_lib.hpp"
#include "motor_control_lib/differential_drive.hpp"
#include "nav_msgs/msg/odometry.hpp"
#include "questix_msgs/msg/drive_status.hpp"
#include "questix_msgs/msg/emergency_stop.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp_components/register_node_macro.hpp"
#include "rclcpp_lifecycle/lifecycle_node.hpp"
#include "rclcpp_lifecycle/lifecycle_publisher.hpp"
#include "tf2_ros/transform_broadcaster.h"

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
 *
 * /emergency_stop（questix_msgs/EmergencyStop、契約は questix_msgs/README.md）を
 * 常時購読し、active=true で即時停止 + 以後の twist を無視、active=false で
 * twist 受付を再開する（モータは次の twist まで停止のまま = 自動復帰）。
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
   * @brief 実測 twist を積分して /odom を publish し、odom->base_link TF を broadcast する。
   *
   * statusTimerCallback から呼ばれる。初回は時刻アンカーのみ設定し、現在ポーズ・
   * ゼロ twist で publish する。dt が無効（<=0 または kMaxOdomDtSec 超過）なら積分を
   * スキップして再アンカー。フィードバックが stale なら twist をゼロ扱いで積分せず、
   * 現在ポーズで publish を継続する（RViz でフレームが消えないため）。
   * @param linear 実測前進速度 [m/s]
   * @param angular 実測角速度 [rad/s]
   * @param feedback_fresh 左右両輪のフィードバックが新鮮か
   * @param now 積分・publish に使う共通タイムスタンプ
   */
  void publishOdometry(double linear, double angular, bool feedback_fresh, const rclcpp::Time& now);

  /**
   * @brief /emergency_stop メッセージのコールバック関数
   *
   * ライフサイクル状態に依存せず常時受信する。立ち上がりエッジで即時停止
   * （best-effort）、立ち下がりエッジで twist 受付を再開する。
   * @param msg 受信した EmergencyStop メッセージ
   */
  void emergencyStopCallback(const questix_msgs::msg::EmergencyStop::SharedPtr msg);

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

  /**
   * @brief オドメトリの publisher / TF broadcaster を解放し、ポーズと時刻アンカーを
   * ゼロにリセットする（cleanup / shutdown / error のフル解体時に呼ぶ）。
   */
  void resetOdometry();

  // ROS 2 通信
  // Twist/status/watchdog/auto-start callbacks intentionally share the node's default
  // MutuallyExclusive callback group, so callbacks do not run concurrently. If entities are
  // split across callback groups, synchronize motor_initialized_, diff_drive_, command state,
  // timer pointers, and all motor serial operations before enabling concurrent execution.
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr twist_subscription_;
  // lifecycle 状態に依存せず常時生かす（コンストラクタで作成、on_cleanup でも破棄しない）
  rclcpp::Subscription<questix_msgs::msg::EmergencyStop>::SharedPtr emergency_stop_sub_;
  // 型付きステータス（questix_msgs/DriveStatus）。契約は questix_msgs/README.md。
  rclcpp_lifecycle::LifecyclePublisher<questix_msgs::msg::DriveStatus>::SharedPtr
      typed_status_publisher_;
  // ホイールオドメトリ（nav_msgs/Odometry）と odom->base_link TF。
  rclcpp_lifecycle::LifecyclePublisher<nav_msgs::msg::Odometry>::SharedPtr odom_publisher_;
  std::unique_ptr<tf2_ros::TransformBroadcaster> tf_broadcaster_;
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
  std::string typed_status_topic_;  // 型付き DriveStatus トピック
  // 統一緊急停止トピック（空文字で連動無効）。コンストラクタで一度だけ読む。
  std::string emergency_stop_topic_;

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
  // デマンド適応加速度の下限。スティックをゆっくり/わずかに倒したときの加速度上限。
  // 0 以下で適応無効＝max_*_accel の一定クランプ（従来挙動）。詳細は
  // drive_slew::demandScaledAccel。
  double min_linear_accel_{0.0};   // [m/s^2]
  double min_angular_accel_{0.0};  // [rad/s^2]
  // 加速度が min から max へ達するデマンド基準（残差 = |目標 - 前回指令|）。
  // 0 以下で適応無効。詳細は drive_slew::demandScaledAccel。
  double accel_demand_ref_linear_{0.0};   // [m/s]
  double accel_demand_ref_angular_{0.0};  // [rad/s]
  // 目標接近時のレート絞り幅（実効的なジャーク制限）。残差がこの幅に入ると 1 ステップの
  // 上限を残差比例で縮め、飽和点で加速度がステップで 0 に落ちないようにする。0 で無効
  // （従来の一次レート制限）。詳細は drive_slew::clampRateTapered。
  double slew_taper_band_linear_{0.15};  // [m/s]
  double slew_taper_band_angular_{0.3};  // [rad/s]
  double last_cmd_linear_;
  double last_cmd_angular_;
  rclcpp::Time last_cmd_time_;
  bool has_last_cmd_;

  // コマンド受信ウォッチドッグ（velocity/current 両モードで有効）
  // /target_twist がこの秒数途絶えたら走行モータを停止する。0 以下で無効。
  double cmd_timeout_sec_;

  // 停止時の電気ブレーキ（velocity モードのみ）
  bool brake_on_stop_{true};

  // ファーム側加速時間 [0.1ms/rpm]（velocity モードのみ）
  int accel_time_0p1ms_per_rpm_{50};

  // 指令を許す最低車輪 RPM（低速不感帯）。0 で不感帯なし
  int min_command_rpm_{8};

  // 指令送信後の追加待機 [ms]。0で無効（DDT M0602C の間隔要件用の保険）
  int command_wait_ms_{0};

  // 停止継続中のブレーキ再送間隔 [ms]。0で無効（毎回送信、従来挙動）
  int stop_resend_interval_ms_{200};

  // 実測RPMローパスの時定数 [s]。<=0で無効（生値）。レポート/オドメトリ経路のみ平滑化する
  double measured_lpf_tau_sec_{0.0};

  // Lifecycle 自動起動（モータ通電まで configure を再試行する）
  bool auto_start_{true};
  double connect_retry_period_sec_{1.0};

  // オドメトリ（実測 twist を積分）。パラメータは on_configure で読む。
  bool publish_tf_{true};      // odom->base_link TF を broadcast するか
  std::string odom_topic_;     // Odometry publish 先
  std::string odom_frame_id_;  // Odometry header / TF 親フレーム
  std::string base_frame_id_;  // child_frame_id（URDF ルートと一致）
  // 積分状態。deactivate->activate ではポーズ維持（時刻アンカーのみクリア）、
  // cleanup/shutdown/error ではゼロにリセットする（詳細は publishOdometry 参照）。
  odometry::Pose2D odom_pose_{};
  rclcpp::Time last_odom_time_{0, 0, RCL_ROS_TIME};
  bool has_last_odom_time_{false};

  // 状態フラグ
  bool motor_initialized_;
  bool emergency_stop_active_;
};

}  // namespace motor_control_app

#endif  // MOTOR_CONTROL_APP__DRIVE_COMPONENT_HPP_
