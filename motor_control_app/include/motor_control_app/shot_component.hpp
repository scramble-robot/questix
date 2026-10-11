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
#include <questix_msgs/msg/launcher_command.hpp>
#include <questix_msgs/msg/motion_permission.hpp>
#include <questix_safety/emergency_stop_monitor.hpp>
#include <questix_safety/permission_monitor.hpp>
#include <rclcpp/rclcpp.hpp>
#include <rclcpp_components/register_node_macro.hpp>
#include <rclcpp_lifecycle/lifecycle_node.hpp>
#include <std_msgs/msg/string.hpp>
#include <string>

#include "motor_control_app/actuation_gate.hpp"
#include "motor_control_app/launcher_events.hpp"
#include "motor_control_app/shot_auto_start.hpp"
#include "motor_control_lib/servo_control.hpp"

namespace motor_control_app {

// Lifecycle node for the shot (tilt + trigger servo) subsystem.
//
// 非常停止中はサーボバスが通電されず、シリアル接続やサーボ応答が得られない。
// そのため起動時は unconfigured で待機し、通電後に configure（接続 + サーボ応答確認）
// → activate（ホーム移動 + 指令の受付開始）で運用状態に遷移する。
// auto_start=true（既定）の場合、内蔵タイマーが configure/activate を成功するまで
// 再試行するので、外部の lifecycle manager なしで systemd 起動に耐える。
//
// さらに emergency_stop_topic（既定 /emergency_stop、questix_msgs/EmergencyStop、
// operation_manager が配信。契約は questix_msgs/README.md）を購読し、非常停止解除
// （active true→false）で起動の試行期間を始め、押下（false→true）で deactivate→cleanup する。
// 試行期間（startup_window_sec）の間は startup_retry_period_sec の短い周期で configure
// （接続 + サーボ 1 回の応答確認、上限 servo_response_timeout_ms）と activate を 1 段ずつ
// 試す。解除のコールバックでは待たないので、サーボが通電直後に応答しなくても /emergency_stop
// の受信処理を止めない（issue #175）。期限後は connect_retry_period_sec の周期リトライに戻る。
// トピック未受信の環境では従来の周期リトライにフォールバック。
// 連動は auto_start=true のときのみ有効で、手動 deactivate 済み（タイマー停止中）の
// ノードは非常停止解除でも再 activate しない。
// require_emergency_stop=true（既定。false は単体診断の明示 opt-out）では、/emergency_stop を
// 一度も受信していない間・受信が途絶えた間も非常停止として扱い、自動起動もコマンドもしない
// （operation_manager は questix_core で常に起動し、GPIO 安全系なしでも解除を出す）。
//
// 走行許可（L2、/motion_permission の launcher_allowed、questix_msgs/MotionPermission、volatile、
// motion_permission_timeout_sec のリース）は非常停止とは別の概念で、大会の審判・教材の先生の許可を
// MotionPermissionManager がまとめたもの。許可がない間は自動起動（configure/activate とホーム移動）
// を保留し、射撃とチルトを断る。ACTIVE 中に許可がなくなったら、射撃中のシーケンスだけ止めて home
// に戻し、サーボバスは解放しない（電源は入ったまま。復帰で再接続とホーム移動を待たない）。非常停止
// （電源が切れる）は従来どおり deactivate→cleanup。両方が閉じているときは非常停止の反応と理由が
// 優先する。止まっている間に届いた射撃・チルトは捨てる（後から動かない）。
//
// 指令は launcher_command_topic（既定 /launcher_command、questix_msgs/LauncherCommand）だけから
// 受け取る。練習・大会は joy_launcher、教材は command_arbiter（コントローラーか QUESTiX LAB）が
// 出す。誰が操作してよいかはそちらで決まり、このノードは /joy も教材のトピックも読まない。
// fire_seq の増加で 1 発、tilt_steps の変化で tilt_step_angle ずつ、tilt_deg の新しい値でその角度
// （範囲に切り詰め）へ動かす（launcher_events.hpp）。射撃の間隔は min_fire_interval_sec（機構の
// 制限、既定 0）。状態は /shot/status（std_msgs/String, JSON）に 5 Hz と変化時に出す。
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
  // /launcher_command: shots, tilt steps and tilt targets (launcher_events.hpp).
  void commandCallback(const questix_msgs::msg::LauncherCommand::SharedPtr msg);
  // Whether the launcher may move now: ACTIVE, servos connected, permission and E-stop open.
  bool readyToMove();
  // A tilt target kept while the tilt servo was rate limited, tried again on the next command.
  void applyPendingTilt();
  void executeShotSequence(FireSource source);
  // Moves the tilt servo to angle_deg (clamped to the tilt range). Returns false when rate limited
  // or the servo write failed.
  bool moveTiltTo(double angle_deg, const char* label);
  void publishShotStatus();
  static double steadyNowSec();
  void fireTimerCallback();
  void cancelShotSequence();
  void autoStartTimerCallback();
  // 起動の試行期間を始める（非常停止解除・許可・構成成功から）。待たずに戻る。
  void requestStartup();
  // 試行期間を終える（押下・途絶・許可なし・ACTIVE 到達・deactivate・shutdown）。
  void endStartup();
  // 試行期間中の短い周期のタイマー。configure か activate を 1 段だけ試す。
  void startupTimerCallback();
  // /emergency_stop を受信したとき（estop_monitor_ から呼ばれる）。エッジで teardown / 自動起動。
  void onEmergencyStop(const questix_msgs::msg::EmergencyStop& msg,
                       const questix_safety::EmergencyStopMonitor::Change& change);
  void emergencyStopTimeoutCallback();
  // /motion_permission を受信したとき（permission_monitor_ から呼ばれる）。
  void onMotionPermission(const questix_msgs::msg::MotionPermission& msg,
                          const questix_safety::PermissionMonitor::Change& change);
  // 100 ms 周期と受信ごと: 走行許可のリース切れ・変化を検出し、閉じたら射撃・チルトを止め
  // （バスは保持）、開いたら自動起動を再開する。
  void applyPermission();
  // 非常停止として扱うか（押下・途絶、require_emergency_stop なら未受信も）。
  bool estopBlocks() const;
  // 走行許可の拒否理由（kNone で許可あり、require_motion_permission=false の診断起動でも kNone）。
  actuation_gate::Block permissionBlock() const;
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
  double tilt_step_angle_;
  double tilt_min_angle_;
  double tilt_max_angle_;
  double fire_angle_;
  double home_angle_;
  int fire_duration_ms_;
  int command_rate_limit_ms_;
  bool auto_start_;
  double connect_retry_period_sec_;
  // 起動の試行期間（issue #175）: 短い周期、期間の長さ、サーボ応答の上限。
  double startup_retry_period_sec_{0.2};
  double startup_window_sec_{5.0};
  int servo_response_timeout_ms_{100};
  shot_auto_start::StartupEpisode startup_episode_{};
  // /emergency_stop の途絶で teardown した（次の受信まで押下扱い）。受信状態そのものは
  // estop_monitor_ が持つ。
  bool estop_timed_out_;
  // 前回の判定で走行許可があったか（変化の検出用）。起動時は許可なし
  bool permission_was_allowed_{false};
  // ACTIVE 中に検出したサーボ通信故障のフラグ。autoStartTimerCallback が拾って
  // deactivate→cleanup→再接続の自動復帰を行う。
  std::atomic<bool> runtime_fault_;
  // 非常停止や通信故障によるdeactivate/cleanupが完了していない状態。
  // ACTIVEではdeactivate、INACTIVEではcleanupをtimerから再試行する。
  std::atomic<bool> teardown_pending_;

  bool is_shooting_;
  int current_tilt_position_;
  double current_tilt_angle_;
  rclcpp::Time last_command_time_;

  // The shortest time between two shots (the mechanism's limit; QUESTiX LAB's own interval is
  // command_arbiter's). Timing uses steady_clock seconds.
  double min_fire_interval_sec_;
  // Last shot (-inf = none yet), shots since start, and the source of the command that fired last.
  double last_fire_sec_;
  long fired_count_;
  FireSource last_fire_source_;
  // The /launcher_command stream's events, and a tilt target waiting for the rate limit.
  LauncherEvents launcher_events_;
  bool pending_tilt_;
  double pending_tilt_deg_;

  // /launcher_command: subscribed for the node's whole life (events received while it may not
  // move only advance the counters and are dropped, never replayed).
  rclcpp::Subscription<questix_msgs::msg::LauncherCommand>::SharedPtr command_subscription_;
  // All callbacks intentionally use the node's default MutuallyExclusive callback group:
  // auto-start, emergency-stop input/timeout, launcher commands, and the fire timer (issue #83). If
  // these entities are split across callback groups, synchronize lifecycle/emergency-stop
  // state, timer pointers, runtime_fault_, teardown_pending_, is_shooting_, servo_controller_,
  // and servo serial I/O.
  // /emergency_stop の購読と判定（questix_safety の共通チェック）。lifecycle 状態に依存せず
  // 常時生かす（unconfigured でも非常停止解除を検知するため）
  std::unique_ptr<questix_safety::EmergencyStopMonitor> estop_monitor_;
  rclcpp::TimerBase::SharedPtr auto_start_timer_;
  // 起動の試行期間だけ動く短い周期のタイマー（auto_start=true のときだけ作る）
  rclcpp::TimerBase::SharedPtr startup_timer_;
  rclcpp::TimerBase::SharedPtr emergency_stop_timeout_timer_;
  // /motion_permission（launcher_allowed）の購読と判定（volatile、ラッチしない）と、
  // リース切れを検出するタイマー
  std::unique_ptr<questix_safety::PermissionMonitor> permission_monitor_;
  rclcpp::TimerBase::SharedPtr permission_timer_;
  // 射撃シーケンス用ワンショットタイマー。fire 位置到達後 fire_duration_ms で
  // 発火し home 復帰する。executor をブロックしないための置き換え（issue #83）。
  rclcpp::TimerBase::SharedPtr fire_timer_;
  // /shot/status: a plain rclcpp publisher so it also reports while the node is not ACTIVE.
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr shot_status_pub_;
  rclcpp::TimerBase::SharedPtr shot_status_timer_;
};

}  // namespace motor_control_app

#endif  // MOTOR_CONTROL_APP__SHOT_COMPONENT_HPP_
