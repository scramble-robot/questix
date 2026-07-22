// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__SHOT_COMPONENT_HPP_
#define MOTOR_CONTROL_APP__SHOT_COMPONENT_HPP_

#include <atomic>
#include <chrono>
#include <memory>
#include <questix_msgs/msg/emergency_stop.hpp>
#include <rclcpp/rclcpp.hpp>
#include <rclcpp_components/register_node_macro.hpp>
#include <rclcpp_lifecycle/lifecycle_node.hpp>
#include <sensor_msgs/msg/joy.hpp>
#include <string>

#include "motor_control_lib/servo_control.hpp"

namespace motor_control_app {

// Lifecycle node for the shot (tilt + trigger servo) subsystem.
//
// 非常停止中はサーボバスが通電されず、シリアル接続やサーボ応答が得られない。
// そのため起動時は unconfigured で待機し、通電後に configure（接続 + サーボ応答確認）
// → activate（ホーム移動 + joy 受付開始）で運用状態に遷移する。
// auto_start=true（既定）の場合、内蔵タイマーが configure/activate を成功するまで
// 再試行するので、外部の lifecycle manager なしで systemd 起動に耐える。
//
// さらに emergency_stop_topic（既定 /emergency_stop、questix_msgs/EmergencyStop、
// operation_manager が配信。契約は questix_msgs/README.md）を購読し、非常停止解除
// （active true→false）で即時に configure→activate、押下（false→true）で
// deactivate→cleanup する。トピック未受信の環境では従来の周期リトライにフォールバック。
// 連動は auto_start=true のときのみ有効で、手動 deactivate 済み（タイマー停止中）の
// ノードは非常停止解除でも再 activate しない。
// なお joy_gate は従来どおり /gpio/controllable（std_msgs/Bool）を購読する。
class ShotComponent : public rclcpp_lifecycle::LifecycleNode {
public:
  using CallbackReturn = rclcpp_lifecycle::node_interfaces::LifecycleNodeInterface::CallbackReturn;

  explicit ShotComponent(const rclcpp::NodeOptions& options);
  ~ShotComponent() override;

  CallbackReturn on_configure(const rclcpp_lifecycle::State& state) override;
  CallbackReturn on_activate(const rclcpp_lifecycle::State& state) override;
  CallbackReturn on_deactivate(const rclcpp_lifecycle::State& state) override;
  CallbackReturn on_cleanup(const rclcpp_lifecycle::State& state) override;
  CallbackReturn on_shutdown(const rclcpp_lifecycle::State& state) override;
  CallbackReturn on_error(const rclcpp_lifecycle::State& state) override;

private:
  void joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg);
  void executeShotSequence();
  void fireTimerCallback();
  void cancelShotSequence();
  void autoStartTimerCallback();
  void emergencyStopCallback(const questix_msgs::msg::EmergencyStop::SharedPtr msg);
  void emergencyStopTimeoutCallback();
  void tryAutoStart();
  void transitionToUnconfiguredForAutoRecovery(const char* reason) noexcept;
  void handleSafetyTeardownState(const char* reason, uint8_t state_id) noexcept;
  uint8_t currentStateIdOrUnknown(const char* reason) noexcept;
  void stopAutoStartTimers();
  void triggerAutoRecovery();
  void disconnectServo();

  // 角度変換関数
  double clampAngle(double angle_deg);
  bool canSendCommand();
  int angleToServoPosition(double angle_deg);
  double servoPositionToAngle(int position);

  std::shared_ptr<motor_control_lib::FeetechServoController> servo_controller_;

  int tilt_servo_id_;
  int trigger_servo_id_;
  int fire_button_;
  int tilt_axis_;
  int tilt_up_button_index_;
  int tilt_down_button_index_;
  double tilt_step_angle_;
  double tilt_min_angle_;
  double tilt_max_angle_;
  double fire_angle_;
  double home_angle_;
  int fire_duration_ms_;
  int command_rate_limit_ms_;
  bool auto_start_;
  double connect_retry_period_sec_;
  double emergency_stop_timeout_sec_;
  // 非常停止連動トピック（空文字で連動無効、周期リトライのみ）
  std::string emergency_stop_topic_;
  // /emergency_stop の受信状況。未受信（have_estop_msg_=false）なら
  // 非常停止状態が分からないため周期リトライにフォールバックする。
  bool have_estop_msg_;
  // 最終受信の active 値。true = 非常停止発動（旧 /gpio/controllable の否定に相当）
  bool estop_active_;
  bool estop_timed_out_;
  std::chrono::steady_clock::time_point last_estop_msg_time_;
  // ACTIVE 中に検出したサーボ通信故障のフラグ。autoStartTimerCallback が拾って
  // deactivate→cleanup→再接続の自動復帰を行う。
  std::atomic<bool> runtime_fault_;
  // 非常停止や通信故障によるdeactivate/cleanupが完了していない状態。
  // ACTIVEではdeactivate、INACTIVEではcleanupをtimerから再試行する。
  std::atomic<bool> teardown_pending_;

  bool is_shooting_;
  bool last_button_state_;
  float last_tilt_value_;
  bool last_tilt_up_state_;
  bool last_tilt_down_state_;
  int current_tilt_position_;
  double current_tilt_angle_;
  rclcpp::Time last_command_time_;

  rclcpp::Subscription<sensor_msgs::msg::Joy>::SharedPtr joy_subscription_;
  // All callbacks intentionally use the node's default MutuallyExclusive callback group:
  // auto-start, emergency-stop input/timeout, joy input, and the fire timer (issue #83). If
  // these entities are split across callback groups, synchronize lifecycle/emergency-stop
  // state, timer pointers, runtime_fault_, teardown_pending_, is_shooting_, servo_controller_,
  // and servo serial I/O.
  // lifecycle 状態に依存せず常時生かす（unconfigured でも非常停止解除を検知するため）
  rclcpp::Subscription<questix_msgs::msg::EmergencyStop>::SharedPtr emergency_stop_sub_;
  rclcpp::TimerBase::SharedPtr auto_start_timer_;
  rclcpp::TimerBase::SharedPtr emergency_stop_timeout_timer_;
  // 射撃シーケンス用ワンショットタイマー。fire 位置到達後 fire_duration_ms で
  // 発火し home 復帰する。executor をブロックしないための置き換え（issue #83）。
  rclcpp::TimerBase::SharedPtr fire_timer_;
};

}  // namespace motor_control_app

#endif  // MOTOR_CONTROL_APP__SHOT_COMPONENT_HPP_
