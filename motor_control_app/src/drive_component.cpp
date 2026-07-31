// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "motor_control_app/drive_component.hpp"

#include <algorithm>
#include <chrono>
#include <exception>
#include <filesystem>
#include <functional>
#include <lifecycle_msgs/msg/state.hpp>

#include "motor_control_app/drive_control_tick.hpp"
#include "motor_control_app/drive_slew.hpp"
#include "motor_control_app/lifecycle_auto_start.hpp"
#include "motor_control_app/motor_status_msg.hpp"

using namespace std::chrono_literals;

namespace motor_control_app {

namespace {
// 未武装（駆動指令を送っていない）間にフィードバック快照の鮮度を維持するポーリング周期の
// 目安 [s]。この鮮度以内なら再取得しない（≈5Hz）。odometry::kMaxFeedbackAgeSec（stale 判定）
// より十分小さくすること。
constexpr double kIdleFeedbackMaxAgeSec = 0.2;
}  // namespace

DriveComponent::DriveComponent(const rclcpp::NodeOptions& options)
    : rclcpp_lifecycle::LifecycleNode("drive_component", options),
      last_cmd_time_(0, 0, RCL_ROS_TIME),
      cmd_timeout_sec_(1.0),
      motor_initialized_(false),
      emergency_stop_active_(false) {
  // パラメーター宣言（取得は on_configure で行い、cleanup→configure で再読込できるようにする）
  declareParameters();

  auto_start_ = this->get_parameter("auto_start").as_bool();
  const double requested_retry_period = this->get_parameter("connect_retry_period_sec").as_double();
  connect_retry_period_sec_ =
      lifecycle_auto_start::normalizeRetryPeriod(requested_retry_period, 1.0);
  if (!lifecycle_auto_start::isValidPositiveValue(requested_retry_period)) {
    RCLCPP_WARN(this->get_logger(),
                "Invalid connect_retry_period_sec=%g; using the default 1.0 seconds",
                requested_retry_period);
  }

  // /emergency_stop 購読は lifecycle 状態に依存せず常時生かす（on_cleanup で
  // 破棄される twist 購読と異なり、unconfigured での configure リトライ中も
  // 状態を追従する）。transient_local なので起動時に最新のラッチ状態を受信する。
  emergency_stop_topic_ = this->get_parameter("emergency_stop_topic").as_string();
  if (!emergency_stop_topic_.empty()) {
    emergency_stop_sub_ = this->create_subscription<questix_msgs::msg::EmergencyStop>(
        emergency_stop_topic_, rclcpp::QoS(1).reliable().transient_local(),
        std::bind(&DriveComponent::emergencyStopCallback, this, std::placeholders::_1));
  }

  if (auto_start_) {
    const auto period = std::chrono::duration<double>(std::max(0.5, connect_retry_period_sec_));
    auto_start_timer_ =
        this->create_wall_timer(std::chrono::duration_cast<std::chrono::nanoseconds>(period),
                                std::bind(&DriveComponent::autoStartTimerCallback, this));
    RCLCPP_INFO(this->get_logger(),
                "Drive component created (auto_start=true, retry=%.1fs). "
                "モータ通電（非常停止解除）を待って自動起動します",
                connect_retry_period_sec_);
  } else {
    RCLCPP_INFO(this->get_logger(),
                "Drive component created (auto_start=false). "
                "外部から lifecycle configure/activate してください");
  }
}

DriveComponent::~DriveComponent() {
  if (auto_start_timer_) {
    auto_start_timer_->cancel();
  }
  if (control_timer_) {
    control_timer_->cancel();
  }
  if (status_timer_) {
    status_timer_->cancel();
  }
  shutdownMotorLib();
}

void DriveComponent::autoStartTimerCallback() {
  using lifecycle_auto_start::AutoStartAction;
  using lifecycle_auto_start::decideAutoStartAction;

  if (!auto_start_timer_) {
    return;
  }
  try {
    uint8_t state_id = this->get_current_state().id();
    AutoStartAction action = decideAutoStartAction(state_id);
    if (action == AutoStartAction::kConfigure) {
      RCLCPP_INFO_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                           "モータ接続を試行します（未通電時は失敗し、通電後に自動復帰します）");
      state_id = this->configure().id();
      action = decideAutoStartAction(state_id);
    }
    if (action == AutoStartAction::kActivate) {
      state_id = this->activate().id();
      action = decideAutoStartAction(state_id);
    }
    if (action == AutoStartAction::kStopTimer) {
      auto_start_timer_->cancel();
    } else if (action == AutoStartAction::kNone &&
               !lifecycle_auto_start::isTransitionState(state_id)) {
      RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                           "Unexpected lifecycle state during drive auto-start: %u",
                           static_cast<unsigned int>(state_id));
    }
  } catch (const std::exception& error) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                          "Drive auto-start transition failed: %s", error.what());
  } catch (...) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                          "Drive auto-start transition failed with unknown exception");
  }
}

DriveComponent::CallbackReturn DriveComponent::on_configure(const rclcpp_lifecycle::State&) {
  readParameters();

  if (!lifecycle_auto_start::isValidStatusPublishRate(status_publish_rate_)) {
    RCLCPP_ERROR(this->get_logger(),
                 "Invalid status_publish_rate=%g; value must produce a positive, representable "
                 "nanosecond timer period",
                 status_publish_rate_);
    return CallbackReturn::FAILURE;
  }

  if (!lifecycle_auto_start::isValidStatusPublishRate(control_rate_)) {
    RCLCPP_ERROR(this->get_logger(),
                 "Invalid control_rate=%g; value must produce a positive, representable "
                 "nanosecond timer period",
                 control_rate_);
    return CallbackReturn::FAILURE;
  }

  // 未通電（非常停止中）は USB CDC デバイス自体が存在しない。ライブラリを構築する前に
  // デバイスの有無を確認し、リトライ毎のライブラリ内 ERROR ログで journald を汚さない。
  if (!std::filesystem::exists(serial_port_)) {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                         "シリアルデバイス %s がありません（モータ未通電の可能性）。"
                         "通電を待って再試行します",
                         serial_port_.c_str());
    return CallbackReturn::FAILURE;
  }

  // シリアル接続 + モータ初期化（非常停止中はポートが無い / 開けない場合がある）
  if (!initializeMotorLib()) {
    // 半構築のインスタンスを残さない（次回の configure 再試行のため）
    diff_drive_.reset();
    motor_lib_.reset();
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                         "モータ初期化に失敗しました (port=%s)。通電を待って再試行します",
                         serial_port_.c_str());
    return CallbackReturn::FAILURE;
  }

  RCLCPP_INFO(this->get_logger(), "Parameters:");
  RCLCPP_INFO(this->get_logger(), "  serial_port: %s", serial_port_.c_str());
  RCLCPP_INFO(this->get_logger(), "  baud_rate: %d", baud_rate_);
  RCLCPP_INFO(this->get_logger(), "  wheel_radius: %.3f", wheel_radius_);
  RCLCPP_INFO(this->get_logger(), "  wheel_separation: %.3f", wheel_separation_);
  RCLCPP_INFO(this->get_logger(), "  left_motor_id: %d", left_motor_id_);
  RCLCPP_INFO(this->get_logger(), "  right_motor_id: %d", right_motor_id_);
  RCLCPP_INFO(this->get_logger(), "  max_motor_rpm: %d", max_motor_rpm_);
  RCLCPP_INFO(this->get_logger(), "  status_publish_rate: %.1f", status_publish_rate_);
  RCLCPP_INFO(this->get_logger(), "  typed_status_topic: %s", typed_status_topic_.c_str());
  RCLCPP_INFO(this->get_logger(), "  publish_tf: %s", publish_tf_ ? "true" : "false");
  RCLCPP_INFO(this->get_logger(), "  odom_topic: %s", odom_topic_.c_str());
  RCLCPP_INFO(this->get_logger(), "  odom_frame_id: %s", odom_frame_id_.c_str());
  RCLCPP_INFO(this->get_logger(), "  base_frame_id: %s", base_frame_id_.c_str());
  RCLCPP_INFO(this->get_logger(), "  cmd_timeout_sec: %.2f", cmd_timeout_sec_);
  RCLCPP_INFO(this->get_logger(), "  control_rate: %.1f", control_rate_);
  RCLCPP_INFO(this->get_logger(), "  control_mode: %s", control_mode_.c_str());
  if (control_mode_ == "current") {
    RCLCPP_INFO(
        this->get_logger(),
        "  current_kp: %.4f  current_ki: %.4f  max_current_amp: %.2f  integral_limit_amp: %.2f",
        current_kp_, current_ki_, max_current_amp_, integral_limit_amp_);
    RCLCPP_INFO(this->get_logger(), "  current_zero_deadband_rpm: %d", current_zero_deadband_rpm_);
  }
  RCLCPP_INFO(this->get_logger(), "  max_linear_accel: %.3f  max_angular_accel: %.3f",
              max_linear_accel_, max_angular_accel_);
  RCLCPP_INFO(
      this->get_logger(),
      "  demand-scaled accel: linear[min=%.3f ref=%.3f] angular[min=%.3f ref=%.3f] (0=無効)",
      min_linear_accel_, accel_demand_ref_linear_, min_angular_accel_, accel_demand_ref_angular_);
  RCLCPP_INFO(this->get_logger(), "  slew_taper_band_linear: %.3f  slew_taper_band_angular: %.3f",
              slew_taper_band_linear_, slew_taper_band_angular_);

  // ホスト側スルーレートとファーム側 accel_time は同じ加速プロファイルを二重に持っている。
  // 傾きが緩い（ms/rpm が大きい）側が実効的に支配するため、両方を同じ単位で並べて出す。
  const double firmware_ramp_ms_per_rpm = accel_time_0p1ms_per_rpm_ * 0.1;
  const double host_ramp_ms_per_rpm =
      drive_slew::hostRampMsPerRpm(max_linear_accel_, wheel_radius_);
  RCLCPP_INFO(this->get_logger(), "  accel_time_0p1ms_per_rpm: %d (= %.1f ms/rpm, firmware ramp)",
              accel_time_0p1ms_per_rpm_, firmware_ramp_ms_per_rpm);
  if (host_ramp_ms_per_rpm > 0.0) {
    RCLCPP_INFO(this->get_logger(),
                "    host slew equivalent: %.1f ms/rpm "
                "(max_linear_accel=%.3f, wheel_radius=%.3f) -> 加速プロファイル支配側: %s",
                host_ramp_ms_per_rpm, max_linear_accel_, wheel_radius_,
                firmware_ramp_ms_per_rpm >= host_ramp_ms_per_rpm ? "firmware (accel_time)"
                                                                 : "host (max_linear_accel)");
  } else {
    RCLCPP_INFO(this->get_logger(),
                "    host slew disabled (max_linear_accel<=0) -> "
                "加速プロファイル支配側: firmware (accel_time)");
  }
  RCLCPP_INFO(this->get_logger(), "  min_command_rpm: %d", min_command_rpm_);

  // twist 購読（コールバックは ACTIVE のときのみ処理する）
  twist_subscription_ = this->create_subscription<geometry_msgs::msg::Twist>(
      "/target_twist", 1, std::bind(&DriveComponent::twistCallback, this, std::placeholders::_1));

  // LifecyclePublisher のため on_activate まで publish は無効
  typed_status_publisher_ =
      this->create_publisher<questix_msgs::msg::DriveStatus>(typed_status_topic_, 1);

  // オドメトリ publisher（LifecyclePublisher が ACTIVE ゲートを担う）と TF broadcaster。
  odom_publisher_ = this->create_publisher<nav_msgs::msg::Odometry>(odom_topic_, 10);
  if (publish_tf_) {
    tf_broadcaster_ = std::make_unique<tf2_ros::TransformBroadcaster>(*this);
  }

  RCLCPP_INFO(this->get_logger(), "Drive component configured");
  return CallbackReturn::SUCCESS;
}

DriveComponent::CallbackReturn DriveComponent::on_activate(const rclcpp_lifecycle::State& state) {
  if (!motor_initialized_ || !diff_drive_) {
    RCLCPP_ERROR(this->get_logger(), "Motor library not initialized, cannot activate");
    return CallbackReturn::FAILURE;
  }

  // LifecyclePublisher を有効化（ステータスタイマー作成より先に呼ぶ）
  rclcpp_lifecycle::LifecycleNode::on_activate(state);

  // inactive 中の残留指令でスルーレートクランプが誤動作しないようリセット
  resetCommandState();

  // オドメトリの時刻アンカーをクリアする（ポーズは維持 = 一時停止でありテレポート
  // ではない）。deactivate 中のギャップを次サンプルで積分しないため。
  has_last_odom_time_ = false;

  // 制御 tick タイマー（固定周期）。スルーレート制限・タイムアウト判定・シリアル送信を
  // ここに集約する（twistCallback は目標保存のみ）。
  const auto control_period =
      std::chrono::nanoseconds(lifecycle_auto_start::statusTimerPeriodNanoseconds(control_rate_));
  control_timer_ = this->create_wall_timer(control_period,
                                           std::bind(&DriveComponent::controlTimerCallback, this));

  // ステータスパブリッシュタイマー（フィードバック快照の publish のみ。シリアル非使用）
  const auto timer_period = std::chrono::nanoseconds(
      lifecycle_auto_start::statusTimerPeriodNanoseconds(status_publish_rate_));
  status_timer_ =
      this->create_wall_timer(timer_period, std::bind(&DriveComponent::statusTimerCallback, this));

  // コマンド受信タイムアウトは制御 tick 内で判定する。cmd_timeout_sec_ <= 0 で無効。
  if (!drive_watchdog::isEnabled(cmd_timeout_sec_)) {
    RCLCPP_WARN(this->get_logger(),
                "Command timeout watchdog disabled (cmd_timeout_sec <= 0); motors will keep the "
                "last command if /target_twist stops");
  }

  RCLCPP_INFO(this->get_logger(), "Drive component activated");
  // 稼働状態に到達。以降は自動再遷移を止めて手動 deactivate/cleanup を尊重する。
  if (auto_start_timer_) {
    auto_start_timer_->cancel();
  }
  return CallbackReturn::SUCCESS;
}

DriveComponent::CallbackReturn DriveComponent::on_deactivate(const rclcpp_lifecycle::State& state) {
  control_timer_.reset();
  status_timer_.reset();
  // best-effort で停止指令（電流PI積分状態もリセットされる）
  if (diff_drive_) {
    diff_drive_->stop();
  }
  resetCommandState();
  rclcpp_lifecycle::LifecycleNode::on_deactivate(state);
  // 手動 deactivate を含め、deactivate では自動再遷移を必ず止める
  // （shot_component bc037d1 と同じ扱い）。
  if (auto_start_timer_) {
    auto_start_timer_->cancel();
  }
  RCLCPP_INFO(this->get_logger(), "Drive component deactivated (twist input ignored)");
  return CallbackReturn::SUCCESS;
}

DriveComponent::CallbackReturn DriveComponent::on_cleanup(const rclcpp_lifecycle::State&) {
  control_timer_.reset();
  status_timer_.reset();
  twist_subscription_.reset();
  typed_status_publisher_.reset();
  resetOdometry();
  shutdownMotorLib();
  RCLCPP_INFO(this->get_logger(), "Drive component cleaned up");
  return CallbackReturn::SUCCESS;
}

DriveComponent::CallbackReturn DriveComponent::on_shutdown(const rclcpp_lifecycle::State&) {
  if (auto_start_timer_) {
    auto_start_timer_->cancel();
  }
  control_timer_.reset();
  status_timer_.reset();
  twist_subscription_.reset();
  typed_status_publisher_.reset();
  resetOdometry();
  shutdownMotorLib();
  RCLCPP_INFO(this->get_logger(), "Drive component shut down");
  return CallbackReturn::SUCCESS;
}

DriveComponent::CallbackReturn DriveComponent::on_error(const rclcpp_lifecycle::State&) {
  // 遷移中に ERROR / 例外が発生したときの後始末。リソースを解放して unconfigured
  // に戻し、auto_start 有効時はタイマーを再開して自動復帰に委ねる。
  control_timer_.reset();
  status_timer_.reset();
  twist_subscription_.reset();
  typed_status_publisher_.reset();
  resetOdometry();
  shutdownMotorLib();
  if (auto_start_ && auto_start_timer_) {
    auto_start_timer_->reset();
  }
  RCLCPP_WARN(this->get_logger(), "Drive component error handled, returning to unconfigured");
  return CallbackReturn::SUCCESS;
}

void DriveComponent::declareParameters() {
  // 既定値は launcher/config/drive_component.yaml（統合起動の Single Source of Truth）と
  // 同値に保つこと。乖離すると単体 launch と統合起動で走行挙動が変わる。
  // 値を変更するときは必ず両方（+ drive_component.hpp のクラス内初期化子）を更新する。

  // DDTモータライブラリのパラメータを宣言
  this->declare_parameter("serial_port", "/dev/ttyACM0");
  this->declare_parameter("baud_rate", 57600);
  this->declare_parameter("wheel_radius", 0.1);
  this->declare_parameter("wheel_separation", 0.5);
  this->declare_parameter("left_motor_id", 4);
  this->declare_parameter("right_motor_id", 5);
  this->declare_parameter("max_motor_rpm", 475);
  this->declare_parameter("status_publish_rate", 50.0);
  // 型付きステータストピック（questix_msgs/DriveStatus）
  this->declare_parameter("typed_status_topic", "/drive_status");

  // 制御モード関連 (後方互換のため velocity 既定)
  this->declare_parameter("control_mode", std::string("velocity"));
  this->declare_parameter("current_kp", 0.001);
  this->declare_parameter("current_ki", 0.0);
  this->declare_parameter("max_current_amp", 1.0);
  this->declare_parameter("integral_limit_amp", 0.3);
  this->declare_parameter("current_zero_deadband_rpm", 5);
  this->declare_parameter("current_invert_measured", true);
  this->declare_parameter("max_linear_accel", 3.0);
  this->declare_parameter("max_angular_accel", 3.0);

  // デマンド適応加速度。スティックを速く/大きく倒すほど加速度上限を max へ、ゆっくり/わずか
  // なら min へ寄せる。min_*_accel<=0 または accel_demand_ref_*<=0 で適応無効＝max の一定
  // クランプ（従来挙動）。詳細は drive_slew::demandScaledAccel。
  this->declare_parameter("min_linear_accel", 0.5);
  this->declare_parameter("min_angular_accel", 0.15);
  this->declare_parameter("accel_demand_ref_linear", 0.3);
  this->declare_parameter("accel_demand_ref_angular", 0.5);

  // 目標接近時のレート絞り幅（実効ジャーク制限）。0 で無効＝従来の一次レート制限。
  // 詳細は drive_slew::clampRateTapered。
  this->declare_parameter("slew_taper_band_linear", 0.2);
  this->declare_parameter("slew_taper_band_angular", 0.2);

  // 停止時の電気ブレーキ（velocity モードのみ有効）
  this->declare_parameter("brake_on_stop", false);

  // ファーム側加速時間 [0.1ms/rpm]（velocity モードのみ有効）。ホスト側スルーレート制限が
  // 生む階段状の目標変化をファームが補間する平滑化機構。詳細は DdtMotorLib::setAccelTime。
  this->declare_parameter("accel_time_0p1ms_per_rpm", 1);

  // 指令を許す最低車輪 RPM（低速不感帯）。詳細は DifferentialDrive::setMinCommandRpm。
  this->declare_parameter("min_command_rpm", 5);

  // コマンド受信タイムアウト [s]（velocity/current 両モードで有効。制御 tick 内で判定）
  this->declare_parameter("cmd_timeout_sec", 1.0);

  // 制御 tick の周期 [Hz]。スルーレート制限の dt = 1/control_rate（固定）になり、
  // 加速度プロファイルが上流の publish レート（DualShock 20Hz / UART 50Hz）に依存しない。
  // 指令+フィードバックのシリアル往復（2モータで正常 ≈ 7ms、最悪 ≈ 20ms）がこの周期予算に
  // 収まる必要がある（超過は "Control tick overrun" 警告が出る）。
  this->declare_parameter("control_rate", 50.0);

  // 指令送信後の追加待機 [ms]。0で無効。実機の最小コマンド間隔要件用の保険
  this->declare_parameter("command_wait_ms", 0);

  // 停止継続中のブレーキ再送間隔 [ms]。高頻度でブレーキを再送し続けると、残留回転が
  // ある間は毎回新規の制動として作用し、収束せず持続的な振動を起こすことがある。
  // 0で無効（毎回送信、従来挙動）。
  this->declare_parameter("stop_resend_interval_ms", 0);

  // 実測RPMローパスの時定数 [s]。フィードバック速度のノイズを平滑化する（レポート/オドメトリ
  // 経路のみ、PI制御は生値のまま）。0以下で無効。詳細は DdtMotorLib::setMeasuredLowpassTau。
  this->declare_parameter("measured_lpf_tau_sec", 0.15);

  // Lifecycle 自動遷移。非常停止解除でモータが通電するまで configure を再試行する。
  this->declare_parameter("auto_start", true);
  this->declare_parameter("connect_retry_period_sec", 1.0);

  // 統一緊急停止トピック（questix_msgs/EmergencyStop）。空文字で連動無効。
  this->declare_parameter("emergency_stop_topic", "/emergency_stop");

  // オドメトリ出力（実測 twist を積分して /odom を publish）。
  this->declare_parameter("publish_tf", true);
  this->declare_parameter("odom_topic", "/odom");
  this->declare_parameter("odom_frame_id", "odom");
  this->declare_parameter("base_frame_id", "base_link");
}

void DriveComponent::readParameters() {
  serial_port_ = this->get_parameter("serial_port").as_string();
  baud_rate_ = this->get_parameter("baud_rate").as_int();
  wheel_radius_ = this->get_parameter("wheel_radius").as_double();
  wheel_separation_ = this->get_parameter("wheel_separation").as_double();
  left_motor_id_ = this->get_parameter("left_motor_id").as_int();
  right_motor_id_ = this->get_parameter("right_motor_id").as_int();
  max_motor_rpm_ = this->get_parameter("max_motor_rpm").as_int();
  status_publish_rate_ = this->get_parameter("status_publish_rate").as_double();
  typed_status_topic_ = this->get_parameter("typed_status_topic").as_string();
  control_mode_ = this->get_parameter("control_mode").as_string();
  current_kp_ = this->get_parameter("current_kp").as_double();
  current_ki_ = this->get_parameter("current_ki").as_double();
  max_current_amp_ = this->get_parameter("max_current_amp").as_double();
  integral_limit_amp_ = this->get_parameter("integral_limit_amp").as_double();
  current_zero_deadband_rpm_ = this->get_parameter("current_zero_deadband_rpm").as_int();
  current_invert_measured_ = this->get_parameter("current_invert_measured").as_bool();
  max_linear_accel_ = this->get_parameter("max_linear_accel").as_double();
  max_angular_accel_ = this->get_parameter("max_angular_accel").as_double();
  min_linear_accel_ = this->get_parameter("min_linear_accel").as_double();
  min_angular_accel_ = this->get_parameter("min_angular_accel").as_double();
  accel_demand_ref_linear_ = this->get_parameter("accel_demand_ref_linear").as_double();
  accel_demand_ref_angular_ = this->get_parameter("accel_demand_ref_angular").as_double();
  slew_taper_band_linear_ = this->get_parameter("slew_taper_band_linear").as_double();
  slew_taper_band_angular_ = this->get_parameter("slew_taper_band_angular").as_double();
  brake_on_stop_ = this->get_parameter("brake_on_stop").as_bool();
  accel_time_0p1ms_per_rpm_ =
      static_cast<int>(this->get_parameter("accel_time_0p1ms_per_rpm").as_int());
  min_command_rpm_ = static_cast<int>(this->get_parameter("min_command_rpm").as_int());
  cmd_timeout_sec_ = this->get_parameter("cmd_timeout_sec").as_double();
  control_rate_ = this->get_parameter("control_rate").as_double();
  command_wait_ms_ = static_cast<int>(this->get_parameter("command_wait_ms").as_int());
  stop_resend_interval_ms_ =
      static_cast<int>(this->get_parameter("stop_resend_interval_ms").as_int());
  measured_lpf_tau_sec_ = this->get_parameter("measured_lpf_tau_sec").as_double();
  publish_tf_ = this->get_parameter("publish_tf").as_bool();
  odom_topic_ = this->get_parameter("odom_topic").as_string();
  odom_frame_id_ = this->get_parameter("odom_frame_id").as_string();
  base_frame_id_ = this->get_parameter("base_frame_id").as_string();
}

bool DriveComponent::initializeMotorLib() {
  try {
    // DDTモータライブラリのインスタンスを作成
    motor_lib_ = std::make_shared<motor_control_lib::DdtMotorLib>(serial_port_, baud_rate_);

    // 最大RPMを設定
    if (!motor_lib_->setMaxRpm(max_motor_rpm_)) {
      RCLCPP_ERROR(this->get_logger(), "Failed to set max RPM");
      return false;
    }

    // 停止時の電気ブレーキ設定（velocity モードのみ有効）
    motor_lib_->setBrakeOnStop(brake_on_stop_);

    // ファーム側加速時間（velocity モードのみ有効）
    motor_lib_->setAccelTime(accel_time_0p1ms_per_rpm_);

    // 指令送信後の追加待機（既定 0 = 無効）
    motor_lib_->setCommandWaitMs(command_wait_ms_);

    // 停止継続中のブレーキ再送間隔（停止直後の持続振動の緩和用）
    motor_lib_->setStopResendIntervalMs(stop_resend_interval_ms_);

    // 実測RPMローパス（フィードバック速度のノイズ平滑化。レポート/オドメトリ経路のみ）
    motor_lib_->setMeasuredLowpassTau(measured_lpf_tau_sec_);

    // モータライブラリを初期化（シリアルポートを開く。未通電なら失敗して再試行に回る）
    if (!motor_lib_->initialize()) {
      return false;
    }

    // 制御モード判定
    motor_control_lib::ControlMode mode = motor_control_lib::ControlMode::Velocity;
    if (control_mode_ == "current") {
      mode = motor_control_lib::ControlMode::Current;
      motor_lib_->setCurrentControlParams(current_kp_, current_ki_, max_current_amp_,
                                          integral_limit_amp_);
      motor_lib_->setCurrentZeroDeadbandRpm(current_zero_deadband_rpm_);
      motor_lib_->setCurrentInvertMeasured(current_invert_measured_);
    } else if (control_mode_ != "velocity") {
      RCLCPP_WARN(this->get_logger(), "未知の control_mode '%s' - velocity モードにフォールバック",
                  control_mode_.c_str());
    }

    // 個別モーターを初期化
    if (!motor_lib_->initializeMotor(left_motor_id_, mode) ||
        !motor_lib_->initializeMotor(right_motor_id_, mode)) {
      RCLCPP_ERROR(this->get_logger(), "Failed to initialize individual motors");
      return false;
    }

    // 差動駆動コントローラーを作成
    diff_drive_ = std::make_unique<motor_control_lib::DifferentialDrive>(
        motor_lib_, left_motor_id_, right_motor_id_, wheel_radius_, wheel_separation_);

    // 低速不感帯（ファーム速度ループが低速域で振動するため、その領域を指令しない）。
    // 通常経路の判定は control_core_ が行うが、自己完結パス（setVelocity）でも同じ
    // 不感帯が効くように両方へ設定する。
    diff_drive_->setMinCommandRpm(min_command_rpm_);

    // ホスト側の制御コア（スルーレート・運動学・停止判定）を構築する。
    control_core_ = std::make_unique<control_core::ControlCore>(makeControlCoreConfig());

    motor_initialized_ = true;
    RCLCPP_INFO(this->get_logger(), "Motor library initialized successfully");
    return true;

  } catch (const std::exception& e) {
    RCLCPP_ERROR(this->get_logger(), "Exception during motor initialization: %s", e.what());
    return false;
  }
}

void DriveComponent::shutdownMotorLib() {
  if (motor_lib_ && motor_initialized_) {
    RCLCPP_INFO(this->get_logger(), "Shutting down motor library");
    if (diff_drive_) {
      diff_drive_->stop();
    }
    motor_lib_->emergencyStop();
    motor_lib_->shutdown();
  }
  control_core_.reset();
  diff_drive_.reset();
  motor_lib_.reset();
  motor_initialized_ = false;
}

control_core::Config DriveComponent::makeControlCoreConfig() const {
  control_core::Config config;
  config.max_linear_accel = max_linear_accel_;
  config.max_angular_accel = max_angular_accel_;
  config.min_linear_accel = min_linear_accel_;
  config.min_angular_accel = min_angular_accel_;
  config.accel_demand_ref_linear = accel_demand_ref_linear_;
  config.accel_demand_ref_angular = accel_demand_ref_angular_;
  config.slew_taper_band_linear = slew_taper_band_linear_;
  config.slew_taper_band_angular = slew_taper_band_angular_;
  config.wheel_radius = wheel_radius_;
  config.wheel_separation = wheel_separation_;
  config.min_command_rpm = min_command_rpm_;
  return config;
}

void DriveComponent::resetCommandState() {
  // 武装解除（制御 tick は次の /target_twist まで駆動指令を送らない）+
  // 制御コアのリセット（次の駆動は 0 からのランプ、停止モードから再開）。
  has_target_ = false;
  target_linear_ = 0.0;
  target_angular_ = 0.0;
  if (control_core_) {
    control_core_->reset();
  }
}

void DriveComponent::resetOdometry() {
  odom_publisher_.reset();
  tf_broadcaster_.reset();
  odom_pose_ = {};
  has_last_odom_time_ = false;
}

void DriveComponent::twistCallback(const geometry_msgs::msg::Twist::SharedPtr msg) {
  // inactive 中の twist は無視する（lifecycle activate 後にのみ駆動する）
  if (this->get_current_state().id() != lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE) {
    return;
  }

  // 非常停止中は目標を保存しない（解除後はモータ停止のまま、次の指令で再開 = 従来挙動）。
  if (emergency_stop_active_) {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                         "Emergency stop active, ignoring twist command");
    return;
  }

  // 制御実行は controlTimerCallback（固定周期の制御 tick）に集約されている。ここでは
  // 最新目標の保存のみを行い、シリアル I/O もスルーレート計算もしない。これにより
  // 制御周期（= スルーレートの dt）が上流の publish レートやメッセージ取りこぼしから
  // 独立する（従来は /target_twist の到着間隔が dt だった）。
  target_linear_ = msg->linear.x;
  target_angular_ = msg->angular.z;
  last_cmd_time_ = this->now();
  has_target_ = true;
}

void DriveComponent::controlTimerCallback() {
  const auto tick_start = std::chrono::steady_clock::now();

  // control_core_ は diff_drive_ と同じライフサイクル（initializeMotorLib で構築、
  // shutdownMotorLib で破棄）だが、kDrive 経路で参照するため準備判定に含める。
  const bool motor_ready = motor_initialized_ && diff_drive_ != nullptr && control_core_ != nullptr;
  const double elapsed = has_target_ ? (this->now() - last_cmd_time_).seconds() : 0.0;
  // isHealthy はキャッシュ済みフィードバックの fault コードを見るだけでシリアルには触らない
  const bool healthy = motor_ready && diff_drive_->isHealthy();

  switch (drive_control_tick::decideTickAction(has_target_, motor_ready, emergency_stop_active_,
                                               healthy, elapsed, cmd_timeout_sec_)) {
    case drive_control_tick::TickAction::kIdle:
      // 未武装（起動直後・タイムアウト/非常停止/フォールト停止後）。駆動指令は送らないが、
      // フィードバックが古ければ低頻度で再取得する（外力で車輪が回された場合の観測と
      // /drive_status の鮮度のため）。シリアル利用者を tick の1箇所に保つための配置。
      if (motor_ready && !emergency_stop_active_ && motor_lib_) {
        motor_lib_->refreshMotorFeedback(left_motor_id_, kIdleFeedbackMaxAgeSec);
        motor_lib_->refreshMotorFeedback(right_motor_id_, kIdleFeedbackMaxAgeSec);
      }
      return;
    case drive_control_tick::TickAction::kTimeoutStop:
      RCLCPP_WARN(this->get_logger(),
                  "Command timeout: no /target_twist for %.2fs (limit %.2fs), stopping motors",
                  elapsed, cmd_timeout_sec_);
      // stop() は各ホイールの stopMotor を通り電流PI積分状態をリセットする。
      // resetCommandState で武装解除（WARN はイベント毎に1回）。次の /target_twist で
      // 自動的に再武装し、スルーレートクランプもゼロから再スタートする。
      diff_drive_->stop();
      resetCommandState();
      return;
    case drive_control_tick::TickAction::kFaultStop:
      // モータ異常中は最後の指令を保持せず、明示的に停止指令を送って武装解除する。
      diff_drive_->stop();
      resetCommandState();
      RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                           "Motor not healthy: sending stop command");
      return;
    case drive_control_tick::TickAction::kDrive:
      break;
  }

  // ホスト側の制御コアで 1 ステップ進める（スルーレート制限 -> 運動学 -> 停止判定）。
  // dt は固定周期の定数なので、実効加速度プロファイルが上流の publish レートに依存しない。
  // 制御則の詳細は control_core.hpp / drive_slew.hpp を参照。
  const double dt = drive_control_tick::tickDtSec(control_rate_);
  const auto out = control_core_->step(target_linear_, target_angular_, dt);

  // 指令送信（応答フレームでフィードバック快照も更新される）。停止判定は制御コアが
  // 済ませているため、送信先は停止指令か生の車輪 RPM のどちらかになる。
  const bool sent =
      out.stop ? diff_drive_->commandStop() : diff_drive_->setWheelRpm(out.left_rpm, out.right_rpm);
  if (!sent) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                          "Failed to set motor velocity");
    return;
  }

  RCLCPP_DEBUG(this->get_logger(),
               "Command sent: linear=%.3f, angular=%.3f -> left=%d RPM, right=%d RPM, stop=%s",
               out.linear, out.angular, out.left_rpm, out.right_rpm, out.stop ? "true" : "false");

  // tick 所要時間の監視。シリアル応答待ち（最悪 10ms × 2）が周期予算を超えると
  // 制御周期が崩れるため、超過を可視化する（実機での control_rate 選定の材料）。
  const double tick_ms =
      std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - tick_start)
          .count();
  if (tick_ms > dt * 1000.0) {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                         "Control tick overrun: %.1f ms > budget %.1f ms (control_rate=%.1f)",
                         tick_ms, dt * 1000.0, control_rate_);
  }
}

void DriveComponent::emergencyStopCallback(const questix_msgs::msg::EmergencyStop::SharedPtr msg) {
  const bool was_active = emergency_stop_active_;
  emergency_stop_active_ = msg->active;

  const bool motor_ready = motor_initialized_ && diff_drive_ != nullptr;
  switch (drive_watchdog::decideEstopAction(was_active, msg->active, motor_ready)) {
    case drive_watchdog::EstopAction::kStopNow:
      RCLCPP_WARN(this->get_logger(), "非常停止を受信 (source=%s, reason=%s)。モータを停止します",
                  msg->source.c_str(), msg->reason.c_str());
      // best-effort の即時停止。物理非常停止でモータ電源が落ちている場合は
      // シリアル書込みが失敗し得るが、teardown へはエスカレートしない
      // （デバイス消失は既存の configure リトライ経路が処理する）。
      diff_drive_->stop();
      resetCommandState();
      break;
    case drive_watchdog::EstopAction::kClear:
      RCLCPP_INFO(this->get_logger(),
                  "非常停止が解除されました (source=%s)。twist 受付を再開します"
                  "（モータは次の指令まで停止のまま）",
                  msg->source.c_str());
      break;
    case drive_watchdog::EstopAction::kNone:
      if (msg->active && !was_active) {
        RCLCPP_WARN(this->get_logger(),
                    "非常停止を受信 (source=%s, reason=%s)。モータ未初期化のため指令なし",
                    msg->source.c_str(), msg->reason.c_str());
      }
      break;
  }
}

void DriveComponent::statusTimerCallback() {
  if (!motor_initialized_ || !diff_drive_) {
    return;
  }

  try {
    // 制御 tick（controlTimerCallback）が取り込んだフィードバック快照を読んで publish する
    // だけで、シリアルには触らない。走行中は tick の指令応答で control_rate 周期の実測が
    // 得られる。未武装（アイドル）中の鮮度維持は tick 側の低頻度ポーリングが担う。
    auto status = diff_drive_->getDriveStatus();

    // 型付きステータス（questix_msgs/DriveStatus）を publish
    rclcpp::Time now = this->now();
    motor_control_lib::DdtMotorLib::MotorFeedbackData left_fb, right_fb;
    motor_lib_->getMotorFeedbackData(left_motor_id_, left_fb);
    motor_lib_->getMotorFeedbackData(right_motor_id_, right_fb);

    questix_msgs::msg::DriveStatus typed_msg;
    typed_msg.header.stamp = now;
    typed_msg.left = toMotorFeedbackMsg(left_fb, now);
    typed_msg.right = toMotorFeedbackMsg(right_fb, now);
    typed_msg.linear_velocity = status.current_linear_velocity;
    typed_msg.angular_velocity = status.current_angular_velocity;
    typed_msg.emergency_stop = emergency_stop_active_;
    typed_status_publisher_->publish(typed_msg);

    // 左右両輪のフィードバックが新鮮なときのみ実測 twist を積分する。stale（非常停止・
    // 未通電を含む）なら twist ゼロ扱いで積分せず、現在ポーズで publish を継続する。
    const bool feedback_fresh =
        odometry::isFeedbackFresh(left_fb.has_feedback, left_fb.feedback_age_sec,
                                  odometry::kMaxFeedbackAgeSec) &&
        odometry::isFeedbackFresh(right_fb.has_feedback, right_fb.feedback_age_sec,
                                  odometry::kMaxFeedbackAgeSec);
    publishOdometry(status.current_linear_velocity, status.current_angular_velocity, feedback_fresh,
                    now);

    RCLCPP_DEBUG(this->get_logger(), "Current velocity: linear=%.3f, angular=%.3f",
                 status.current_linear_velocity, status.current_angular_velocity);

  } catch (const std::exception& e) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                          "Exception in status timer callback: %s", e.what());
  }
}

void DriveComponent::publishOdometry(double linear, double angular, bool feedback_fresh,
                                     const rclcpp::Time& now) {
  if (!odom_publisher_) {
    return;
  }

  // 初回（activate 直後）は時刻アンカーのみ設定し、現在ポーズ・ゼロ twist で publish する。
  if (has_last_odom_time_) {
    const double dt = (now - last_odom_time_).seconds();
    if (odometry::isValidDt(dt, odometry::kMaxOdomDtSec)) {
      // stale なら twist ゼロ扱いで積分しない（stale RPM によるポーズドリフト防止）。
      const double eff_linear = feedback_fresh ? linear : 0.0;
      const double eff_angular = feedback_fresh ? angular : 0.0;
      odom_pose_ = odometry::integrate(odom_pose_, eff_linear, eff_angular, dt);
    }
    // dt が無効（<=0 または kMaxOdomDtSec 超過）ならこのサンプルは積分せず再アンカーのみ。
  }
  last_odom_time_ = now;
  has_last_odom_time_ = true;

  // publish に載せる twist は stale 時ゼロ（ポーズと整合させ、下流の誤積分を防ぐ）。
  const double reported_linear = feedback_fresh ? linear : 0.0;
  const double reported_angular = feedback_fresh ? angular : 0.0;
  const odometry::YawQuaternion q = odometry::yawToQuaternion(odom_pose_.theta);

  nav_msgs::msg::Odometry odom;
  odom.header.stamp = now;
  odom.header.frame_id = odom_frame_id_;
  odom.child_frame_id = base_frame_id_;
  odom.pose.pose.position.x = odom_pose_.x;
  odom.pose.pose.position.y = odom_pose_.y;
  odom.pose.pose.position.z = 0.0;
  odom.pose.pose.orientation.x = 0.0;
  odom.pose.pose.orientation.y = 0.0;
  odom.pose.pose.orientation.z = q.z;
  odom.pose.pose.orientation.w = q.w;
  odom.twist.twist.linear.x = reported_linear;
  odom.twist.twist.angular.z = reported_angular;

  // 固定共分散（issue 指定）。z/roll/pitch は非観測、vy は非ホロノミックで非観測。
  odom.pose.covariance[0] = 0.01;    // x
  odom.pose.covariance[7] = 0.01;    // y
  odom.pose.covariance[14] = 1e6;    // z
  odom.pose.covariance[21] = 1e6;    // roll
  odom.pose.covariance[28] = 1e6;    // pitch
  odom.pose.covariance[35] = 0.05;   // yaw
  odom.twist.covariance[0] = 0.01;   // vx
  odom.twist.covariance[7] = 1e6;    // vy
  odom.twist.covariance[14] = 1e6;   // vz
  odom.twist.covariance[21] = 1e6;   // wx
  odom.twist.covariance[28] = 1e6;   // wy
  odom.twist.covariance[35] = 0.05;  // wz
  odom_publisher_->publish(odom);

  // odom->base_link TF（Odometry と同一 stamp / フレーム）。
  if (publish_tf_ && tf_broadcaster_) {
    geometry_msgs::msg::TransformStamped tf;
    tf.header.stamp = now;
    tf.header.frame_id = odom_frame_id_;
    tf.child_frame_id = base_frame_id_;
    tf.transform.translation.x = odom_pose_.x;
    tf.transform.translation.y = odom_pose_.y;
    tf.transform.translation.z = 0.0;
    tf.transform.rotation.x = 0.0;
    tf.transform.rotation.y = 0.0;
    tf.transform.rotation.z = q.z;
    tf.transform.rotation.w = q.w;
    tf_broadcaster_->sendTransform(tf);
  }
}

}  // namespace motor_control_app

// コンポーネントとして登録
RCLCPP_COMPONENTS_REGISTER_NODE(motor_control_app::DriveComponent)
