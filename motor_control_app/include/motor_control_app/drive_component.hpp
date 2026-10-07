// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__DRIVE_COMPONENT_HPP_
#define MOTOR_CONTROL_APP__DRIVE_COMPONENT_HPP_

#include <chrono>
#include <memory>
#include <string>
#include <vector>

#include "geometry_msgs/msg/transform_stamped.hpp"
#include "geometry_msgs/msg/twist.hpp"
#include "motor_control_app/actuation_gate.hpp"
#include "motor_control_app/control_core.hpp"
#include "motor_control_app/drive_control_tick.hpp"
#include "motor_control_app/drive_watchdog.hpp"
#include "motor_control_app/odometry_integrator.hpp"
#include "motor_control_lib/ddt_motor_lib.hpp"
#include "motor_control_lib/differential_drive.hpp"
#include "nav_msgs/msg/odometry.hpp"
#include "questix_msgs/msg/actuation_authority.hpp"
#include "questix_msgs/msg/drive_status.hpp"
#include "questix_msgs/msg/emergency_stop.hpp"
#include "questix_safety/emergency_stop_monitor.hpp"
#include "rcl_interfaces/msg/set_parameters_result.hpp"
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
 * 制御は固定周期の制御 tick（control_rate、既定 50 Hz）で実行する。
 * twistCallback は最新目標の保存のみを行い、スルーレート制限・シリアル送信・
 * コマンドタイムアウト判定はすべて controlTimerCallback に集約されている。
 * これにより制御周期（= スルーレートの dt）が上流の publish レートから独立し、
 * シリアルバスの利用者が制御 tick の1箇所になる。
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
 * 未受信（起動直後）と、受信後に emergency_stop_timeout_sec 途絶えた状態も動かさない
 * （operation_manager は questix_core で常に起動し、GPIO 安全系なしでも解除を出す。
 * require_emergency_stop=false は単体診断の明示 opt-out で、そのときも押下の受信では止まる）。
 *
 * 教員の許可は非常停止とは別の概念で、require_teacher_permission=true
 * （練習での opt-in、既定 false、大会では使わない）の時だけ、教員の許可
 * （questix_msgs/ActuationAuthority の drive_allowed、volatile、1.0 s のリース）がある間だけ
 * 動かす。許可も E-stop も actuation_gate.hpp の純粋関数で判定し、閉じたら即時停止 + 目標破棄、
 * 開いても次の /target_twist まで停止のまま。停止指令を送れなかったら stop fault として閉じ、
 * 両輪へのゼロ送信が成功するまで一定間隔で再送する。ゲートはライフサイクルとは別で、閉じて
 * いる間もフィードバックの取得（送信に成功したゼロの再送だけ）は続ける。
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
  friend struct DriveParamPolicyAccess;
  /**
   * @brief Twistメッセージのコールバック関数
   *
   * 最新目標と受信時刻の保存のみを行う（I/O・スルーレート計算なし）。
   * 制御実行は controlTimerCallback（固定周期）に集約されている。
   * @param msg 受信したTwistメッセージ
   */
  void twistCallback(const geometry_msgs::msg::Twist::SharedPtr msg);

  /**
   * @brief 制御 tick（固定周期 control_rate）のタイマーコールバック
   *
   * コマンドタイムアウト判定（旧ウォッチドッグ）、フォールト停止、
   * 固定 dt のスルーレート制限、シリアル送信（指令+フィードバック往復）を
   * 1箇所で実行する。シリアルバスの利用者はこの tick のみ。
   * 未武装（目標未受信）の間は駆動指令を送らず、フィードバックが古ければ
   * 低頻度で再取得のみ行う。
   */
  void controlTimerCallback();

  /**
   * @brief モータステータスをパブリッシュするタイマーコールバック
   *
   * 制御 tick が取り込んだフィードバック快照を読んで publish するだけで、
   * シリアルには触らない。
   */
  void statusTimerCallback();

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
   * @brief /emergency_stop を受信したとき（estop_monitor_ から呼ばれる）
   *
   * ライフサイクル状態に依存せず常時受信する。立ち上がりエッジで即時停止
   * （best-effort）、立ち下がりエッジで twist 受付を再開する。
   * @param msg 受信した EmergencyStop メッセージ
   * @param change 初回受信か・直前の active（未受信の間は true）
   */
  void onEmergencyStop(const questix_msgs::msg::EmergencyStop& msg,
                       const questix_safety::EmergencyStopMonitor::Change& change);

  /**
   * @brief 教員の許可（/actuation_authority）のコールバック
   *
   * 受信時刻（steady clock）と drive_allowed を記録し、閉じる方向の変化なら即座に停止する。
   */
  void teacherPermissionCallback(const questix_msgs::msg::ActuationAuthority::SharedPtr msg);

  /**
   * @brief 非常停止（/emergency_stop）の入力を組み立てる（age は steady clock）
   */
  actuation_gate::EstopInputs estopInputs() const;

  /**
   * @brief 教員の許可（/actuation_authority）の入力を組み立てる。非常停止とは別の概念。
   *
   * require_teacher_permission=false（既定）では required=false だけを返し、
   * 受信状態は一切見ない（購読も作らない）。
   */
  actuation_gate::TeacherPermissionInputs teacherPermissionInputs() const;

  /**
   * @brief 非常停止・実行時許可・stop fault をまとめたゲート入力
   */
  actuation_gate::Inputs gateInputs() const;

  /**
   * @brief ゲートを評価し、閉じる変化（または閉じているのに武装が残る）なら停止する
   * @param stopped_now 呼び出し側がこの直前に safetyStop 済み（二重送信しない）
   * @return 現在の拒否理由（kNone で動かしてよい）
   */
  actuation_gate::Block applyGate(bool stopped_now = false);

  /**
   * @brief 非常停止として扱っている状態か（押下、require_emergency_stop の時は未受信・途絶も。
   *        実行時許可・stop fault とは別）
   */
  bool estopEngaged() const;

  /**
   * @brief 安全停止: スロットル無しで両輪へゼロを送り、目標を破棄する。
   *
   * 送信に失敗したら stop_fault_ を立てる（キャッシュをゼロに偽装しない）。
   * @return 両輪への送信が成功したか（モータ未初期化は送る相手がないので false）
   */
  bool safetyStop(const char* reason);

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
   * @brief 現在のパラメータから制御コアの設定を組み立てる（readParameters の後に呼ぶ）
   */
  control_core::Config makeControlCoreConfig() const;
  // velocity_run_lqr_enabled=true（velocity モード）なのに RUN 閾値が両方 0 で、
  // LQR+FF が適用されない設定か（ControlCore::velocityRunLqrApplicable() の WARN 用）。
  bool velocityRunLqrLacksRunThreshold() const;

  /**
   * @brief 走行チューニング用パラメータの実行時変更コールバック。
   *
   * 実機で `ros2 param set` しながら加減速の詰めができるようにするためのもの。
   * 対象はスルーレート系・不感帯・停止ブレーキ・平滑化など「再初期化なしで
   * 反映できる」パラメータに限る。シリアルポート・モータ ID・control_mode・
   * control_rate などの構造的パラメータは実行時変更を拒否する。
   * 全値の検証に成功した要求だけを反映する。
   */
  rcl_interfaces::msg::SetParametersResult onParameterChange(
      const std::vector<rclcpp::Parameter>& params);

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
  // Twist/control/status/auto-start callbacks intentionally share the node's default
  // MutuallyExclusive callback group, so callbacks do not run concurrently. If entities are
  // split across callback groups, synchronize motor_initialized_, diff_drive_, command state,
  // timer pointers, and all motor serial operations before enabling concurrent execution.
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr twist_subscription_;
  // /emergency_stop の購読と判定（questix_safety の共通チェック）。lifecycle 状態に依存せず
  // 常時生かす（コンストラクタで作成、on_cleanup でも破棄しない）
  std::unique_ptr<questix_safety::EmergencyStopMonitor> estop_monitor_;
  // 教員の許可（練習時のみ購読。volatile、ラッチしない）。E-stop 購読と同じく常時生かす
  rclcpp::Subscription<questix_msgs::msg::ActuationAuthority>::SharedPtr teacher_permission_sub_;
  // 型付きステータス（questix_msgs/DriveStatus）。契約は questix_msgs/README.md。
  rclcpp_lifecycle::LifecyclePublisher<questix_msgs::msg::DriveStatus>::SharedPtr
      typed_status_publisher_;
  // ホイールオドメトリ（nav_msgs/Odometry）と odom->base_link TF。
  rclcpp_lifecycle::LifecyclePublisher<nav_msgs::msg::Odometry>::SharedPtr odom_publisher_;
  std::unique_ptr<tf2_ros::TransformBroadcaster> tf_broadcaster_;
  rclcpp::TimerBase::SharedPtr control_timer_;
  rclcpp::TimerBase::SharedPtr status_timer_;
  rclcpp::TimerBase::SharedPtr auto_start_timer_;
  // 走行チューニング用パラメータの実行時変更ハンドラ（onParameterChange 参照）
  rclcpp::node_interfaces::OnSetParametersCallbackHandle::SharedPtr param_handler_;

  // モータ制御ライブラリ
  std::shared_ptr<motor_control_lib::DdtMotorLib> motor_lib_;
  std::unique_ptr<motor_control_lib::DifferentialDrive> diff_drive_;

  // ホスト側の制御コア（スルーレート・運動学・停止判定）。ROS/シリアル非依存の純粋な
  // 状態機械で、閉ループシミュレーションテスト（test_control_core）と同じコードを通る。
  // diff_drive_ と同じライフサイクル（initializeMotorLib で構築、shutdown で破棄）。
  std::unique_ptr<control_core::ControlCore> control_core_;

  // パラメータ
  // クラス内初期化子は declareParameters の既定値（= launcher/config/drive_component.yaml）と
  // 同値に保つこと。実行時は on_configure -> readParameters で必ず上書きされるが、乖離した
  // 値は「3種類目のデフォルト」としてコードを読む人を誤導する。
  std::string serial_port_;
  int baud_rate_;
  double wheel_radius_;
  double wheel_separation_;
  int left_motor_id_;
  int right_motor_id_;
  int max_motor_rpm_;
  double status_publish_rate_;
  std::string typed_status_topic_;  // 型付き DriveStatus トピック

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
  // 目標接近時のレート絞り幅（実効的なジャーク制限）。残差がこの幅に入ると 1 ステップの
  // 上限を残差比例で縮め、飽和点で加速度がステップで 0 に落ちないようにする。0 で無効
  // （従来の一次レート制限）。詳細は drive_slew::clampRateTapered。
  double slew_taper_band_linear_{0.1};   // [m/s]
  double slew_taper_band_angular_{0.1};  // [rad/s]

  // 制御 tick の周期 [Hz]。スルーレート制限の dt は 1/control_rate の定数になる
  double control_rate_{50.0};

  // 最新の目標 twist（twistCallback が保存、controlTimerCallback が消費）。
  // has_target_ = false は未武装（起動直後・タイムアウト/非常停止/フォールト停止後）で、
  // 制御 tick は駆動指令を送らない。次の /target_twist 受信で再武装される。
  double target_linear_{0.0};
  double target_angular_{0.0};
  rclcpp::Time last_cmd_time_;
  bool has_target_{false};

  // スルーレート制限と停止判定の状態は control_core_ が保持する。

  // コマンド受信タイムアウト（velocity/current 両モードで有効。制御 tick 内で判定）
  // /target_twist がこの秒数途絶えたら走行モータを停止する。0 以下で無効。
  double cmd_timeout_sec_;

  // 停止時の電気ブレーキ（velocity モードのみ）
  bool brake_on_stop_{false};

  // 指令を許す最低車輪 RPM（低速不感帯）。0 で不感帯なし
  int min_command_rpm_{5};

  // velocity モードの走行状態機械（design/model_based_drive_control.md Phase B）。
  // RUN 閾値が 0 なら CREEP は空集合 = 従来の停止/走行 2 状態。
  int drive_fsm_run_enter_rpm_{0};
  int drive_fsm_run_exit_rpm_{0};

  // velocity モード RUN 域の外側 LQR+FF（Phase E）。velocity モードのみ有効。
  // 既定は無効（enabled=false）で従来挙動。同定（Phase A）後に YAML で有効化する。
  bool velocity_run_lqr_enabled_{false};
  double velocity_run_model_tau_sec_{0.1};
  int velocity_run_model_delay_ticks_{1};
  double velocity_run_q_{0.0};
  double velocity_run_r_{1.0};
  double velocity_run_lead_gain_{0.0};
  double velocity_run_disturbance_gain_{0.0};
  double velocity_run_observer_l_x_{0.3};
  double velocity_run_observer_l_d_{0.0};
  double velocity_run_max_correction_rpm_{20.0};
  bool velocity_run_invert_measured_{false};
  double velocity_run_feedback_max_age_sec_{0.1};

  // velocity モードの共振ダンピング（motor_control_lib/wheel_rate_damper.hpp）。velocity モードのみ
  // 有効。gain 0 で無効（既定 = 従来挙動）。範囲は drive_component.cpp の
  // velocityDampingProblem()。
  double velocity_damping_gain_sec_{0.0};
  double velocity_damping_filter_tau_sec_{0.08};
  double velocity_damping_max_correction_rpm_{30.0};
  // 負荷ゲート: 各輪の電流が小さい（車輪を浮かせた等）間は補正を弱め・切る。on 0 でゲート無効
  double velocity_damping_load_on_amp_{0.6};
  double velocity_damping_load_off_amp_{0.3};
  double velocity_damping_load_tau_sec_{0.3};
  // velocity モードの遅れ上乗せ・行き過ぎ差し引き（wheel_lag_assist.hpp、実機試験用）。
  // gain と overshoot_gain がともに 0 で無効。負荷ゲートは velocity_damping_load_* を共用。
  double velocity_lag_assist_gain_{0.0};
  double velocity_lag_assist_overshoot_gain_{0.0};
  double velocity_lag_assist_deadband_rpm_{3.0};
  double velocity_lag_assist_model_tau_sec_{0.06};
  double velocity_lag_assist_max_rpm_{15.0};

  // 指令送信後の追加待機 [ms]。0で無効（DDT M0602C の間隔要件用の保険）
  int command_wait_ms_{0};

  // 停止継続中のブレーキ再送間隔 [ms]。0で無効（毎回送信、従来挙動）
  int stop_resend_interval_ms_{300};

  // 実測RPMローパスの時定数 [s]。<=0で無効（生値）。レポート/オドメトリ経路のみ平滑化する
  double measured_lpf_tau_sec_{0.15};

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

  // 教員の許可（非常停止とは別の概念。練習での opt-in、既定 false）。コンストラクタで読む
  bool require_teacher_permission_{false};
  std::string teacher_permission_topic_{"/actuation_authority"};
  double teacher_permission_timeout_sec_{1.0};  // リース [s]。無効値は 1.0
  bool have_teacher_permission_msg_{false};
  bool teacher_permission_drive_allowed_{false};
  std::chrono::steady_clock::time_point last_teacher_permission_rx_{};

  // 停止指令を送れなかった（両輪へのゼロ送信成功まで閉じたまま、stop_retry_period で再送）
  bool stop_fault_{false};
  std::chrono::steady_clock::time_point last_stop_attempt_{};
  // 前回評価したゲートの理由（閉じる変化の検出とログ用）。コンストラクタで初期評価する
  actuation_gate::Block last_block_{actuation_gate::Block::kEstopUnknown};
};

}  // namespace motor_control_app

#endif  // MOTOR_CONTROL_APP__DRIVE_COMPONENT_HPP_
