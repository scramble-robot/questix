// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// DriveComponent: parameter declaration, reading and runtime changes
// (see drive_component.cpp for how the class is split).
#include <algorithm>
#include <chrono>
#include <cmath>
#include <exception>
#include <filesystem>
#include <functional>
#include <lifecycle_msgs/msg/state.hpp>
#include <limits>
#include <stdexcept>

#include "motor_control_app/drive_component.hpp"
#include "motor_control_app/drive_control_tick.hpp"
#include "motor_control_app/drive_slew.hpp"
#include "motor_control_app/lifecycle_auto_start.hpp"
#include "motor_control_app/motor_status_msg.hpp"

using namespace std::chrono_literals;

namespace motor_control_app {

namespace {
// velocity_run_model_delay_ticks・オブザーバ/LQR のゲインは tick 単位で、同定と既定値は
// control_rate 50 Hz を前提にしている。
constexpr double kLqrTickRateHz = 50.0;
}  // namespace

void DriveComponent::declareParameters() {
  // 既定値は launcher/config/drive_component.yaml（統合起動の Single Source of Truth）と
  // 同値に保つこと。乖離すると単体 launch と統合起動で走行挙動が変わる。
  // 値を変更するときは必ず両方（+ drive_component.hpp のクラス内初期化子）を更新する。

  // DDTモータライブラリのパラメータを宣言
  this->declare_parameter("serial_port", "/dev/ttyACM0");
  this->declare_parameter("baud_rate", 57600);
  this->declare_parameter("wheel_radius", 0.05);
  this->declare_parameter("wheel_separation", 0.5);
  this->declare_parameter("left_motor_id", 4);
  this->declare_parameter("right_motor_id", 5);
  this->declare_parameter("max_motor_rpm", 475);
  this->declare_parameter("status_publish_rate", 50.0);
  // 型付きステータストピック（questix_msgs/DriveStatus）
  this->declare_parameter("typed_status_topic", "/drive_status");
  // 制御 tick ごとの診断サンプル（questix_msgs/DriveControlSample、control_rate で publish）。
  // 記録・解析専用で制御・安全判断には使わない。契約は questix_msgs/README.md。
  this->declare_parameter("publish_control_sample", true);
  this->declare_parameter("control_sample_topic", "/drive_control_sample");

  // 制御モード関連 (後方互換のため velocity 既定)
  this->declare_parameter("control_mode", std::string("velocity"));
  this->declare_parameter("current_kp", 0.001);
  this->declare_parameter("current_ki", 0.0);
  this->declare_parameter("max_current_amp", 1.0);
  this->declare_parameter("integral_limit_amp", 0.3);
  this->declare_parameter("current_zero_deadband_rpm", 5);
  this->declare_parameter("current_invert_measured", true);
  this->declare_parameter("max_linear_accel", 1.5);
  this->declare_parameter("max_angular_accel", 1.5);

  // 目標接近時のレート絞り幅（実効ジャーク制限）。0 で無効＝従来の一次レート制限。
  // 詳細は drive_slew::clampRateTapered。
  this->declare_parameter("slew_taper_band_linear", 0.1);
  this->declare_parameter("slew_taper_band_angular", 0.1);

  // 停止時の電気ブレーキ（velocity モードのみ有効）
  this->declare_parameter("brake_on_stop", false);

  // 指令を許す最低車輪 RPM（低速不感帯）。詳細は DifferentialDrive::setMinCommandRpm。
  this->declare_parameter("min_command_rpm", 5);

  // velocity モードの走行状態機械（停止/低速/走行）。RUN 閾値 0 で従来の 2 状態。
  // 詳細は motor_control_lib/drive_mode_fsm.hpp。
  this->declare_parameter("drive_fsm_run_enter_rpm", 0);
  this->declare_parameter("drive_fsm_run_exit_rpm", 0);

  // velocity モード RUN 域の外側 LQR+FF（velocity モードのみ有効。current モードでは無視）。
  // 既定は無効。同定結果（design/model_based_drive_control.md Phase A）を得てから有効化する。
  // 詳細は control_core.hpp VelocityRunLqrConfig / motor_control_lib/wheel_velocity_lqr.hpp。
  this->declare_parameter("velocity_run_lqr_enabled", false);
  this->declare_parameter("velocity_run_model_tau_sec", 0.1);
  this->declare_parameter("velocity_run_model_delay_ticks", 1);
  this->declare_parameter("velocity_run_q", 0.0);
  this->declare_parameter("velocity_run_r", 1.0);
  this->declare_parameter("velocity_run_lead_gain", 0.0);
  this->declare_parameter("velocity_run_disturbance_gain", 0.0);
  this->declare_parameter("velocity_run_observer_l_x", 0.3);
  this->declare_parameter("velocity_run_observer_l_d", 0.0);
  this->declare_parameter("velocity_run_max_correction_rpm", 20.0);
  this->declare_parameter("velocity_run_invert_measured", false);
  this->declare_parameter("velocity_run_feedback_max_age_sec", 0.1);

  // コマンド受信タイムアウト [s]（velocity/current 両モードで有効。制御 tick 内で判定）
  this->declare_parameter("cmd_timeout_sec", 1.0);

  // 制御 tick の周期 [Hz]。スルーレート制限の dt = 1/control_rate（固定）になり、
  // 加速度プロファイルが上流の publish レート（DualShock 20Hz / UART 50Hz）に依存しない。
  // 指令+フィードバックのシリアル往復（2モータで正常 ≈ 7ms、応答なしは最悪
  // 2 × serial_response_timeout_ms、既定で ≈ 20ms）がこの周期予算に
  // 収まる必要がある（超過は "Control tick overrun" 警告が出る）。
  this->declare_parameter("control_rate", 50.0);

  // 指令送信後の追加待機 [ms]。0で無効。実機の最小コマンド間隔要件用の保険
  this->declare_parameter("command_wait_ms", 0);

  // 指令送信後にフィードバック応答を待つ上限 [ms]。既定 10 は従来の固定値。範囲 [2, 50] の外は
  // クランプして WARN。詳細は DdtMotorLib::setResponseTimeoutMs。
  this->declare_parameter("serial_response_timeout_ms", 10);

  // 停止継続中のブレーキ再送間隔 [ms]。高頻度でブレーキを再送し続けると、残留回転が
  // ある間は毎回新規の制動として作用し、収束せず持続的な振動を起こすことがある。
  // 0で無効（毎回送信、従来挙動）。
  this->declare_parameter("stop_resend_interval_ms", 300);

  // 実測RPMローパスの時定数 [s]。フィードバック速度のノイズを平滑化する（レポート/オドメトリ
  // 経路のみ、PI制御は生値のまま）。0以下で無効。詳細は DdtMotorLib::setMeasuredLowpassTau。
  this->declare_parameter("measured_lpf_tau_sec", 0.15);

  // Lifecycle 自動遷移。非常停止解除でモータが通電するまで configure を再試行する。
  this->declare_parameter("auto_start", true);
  this->declare_parameter("connect_retry_period_sec", 1.0);

  // 統一緊急停止トピック（questix_msgs/EmergencyStop）。空文字で連動無効
  // （require_emergency_stop=true のままなら動かない）。
  this->declare_parameter("emergency_stop_topic", "/emergency_stop");
  // 未受信・途絶の /emergency_stop を「動かさない」とするか。false は単体診断の明示 opt-out。
  this->declare_parameter("require_emergency_stop", true);
  // 一度受信した後、この秒数（自分の steady clock での受信間隔）途絶えたら停止。<=0 で無効。
  this->declare_parameter("emergency_stop_timeout_sec", 1.0);

  // 教員の許可（questix_msgs/ActuationAuthority）。非常停止とは別の概念で、練習での
  // opt-in（既定 false）。大会起動（enable_autoreferee）では launch が常に false を渡す。
  this->declare_parameter("require_teacher_permission", false);
  this->declare_parameter("teacher_permission_topic", "/actuation_authority");
  this->declare_parameter("teacher_permission_timeout_sec", 1.0);

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
  publish_control_sample_ = this->get_parameter("publish_control_sample").as_bool();
  control_sample_topic_ = this->get_parameter("control_sample_topic").as_string();
  control_mode_ = this->get_parameter("control_mode").as_string();
  current_kp_ = this->get_parameter("current_kp").as_double();
  current_ki_ = this->get_parameter("current_ki").as_double();
  max_current_amp_ = this->get_parameter("max_current_amp").as_double();
  integral_limit_amp_ = this->get_parameter("integral_limit_amp").as_double();
  current_zero_deadband_rpm_ = this->get_parameter("current_zero_deadband_rpm").as_int();
  current_invert_measured_ = this->get_parameter("current_invert_measured").as_bool();
  max_linear_accel_ = this->get_parameter("max_linear_accel").as_double();
  max_angular_accel_ = this->get_parameter("max_angular_accel").as_double();
  slew_taper_band_linear_ = this->get_parameter("slew_taper_band_linear").as_double();
  slew_taper_band_angular_ = this->get_parameter("slew_taper_band_angular").as_double();
  brake_on_stop_ = this->get_parameter("brake_on_stop").as_bool();
  min_command_rpm_ = static_cast<int>(this->get_parameter("min_command_rpm").as_int());
  drive_fsm_run_enter_rpm_ =
      static_cast<int>(this->get_parameter("drive_fsm_run_enter_rpm").as_int());
  drive_fsm_run_exit_rpm_ =
      static_cast<int>(this->get_parameter("drive_fsm_run_exit_rpm").as_int());
  velocity_run_lqr_enabled_ = this->get_parameter("velocity_run_lqr_enabled").as_bool();
  velocity_run_model_tau_sec_ = this->get_parameter("velocity_run_model_tau_sec").as_double();
  velocity_run_model_delay_ticks_ =
      static_cast<int>(this->get_parameter("velocity_run_model_delay_ticks").as_int());
  velocity_run_q_ = this->get_parameter("velocity_run_q").as_double();
  velocity_run_r_ = this->get_parameter("velocity_run_r").as_double();
  velocity_run_lead_gain_ = this->get_parameter("velocity_run_lead_gain").as_double();
  velocity_run_disturbance_gain_ = this->get_parameter("velocity_run_disturbance_gain").as_double();
  velocity_run_observer_l_x_ = this->get_parameter("velocity_run_observer_l_x").as_double();
  velocity_run_observer_l_d_ = this->get_parameter("velocity_run_observer_l_d").as_double();
  velocity_run_max_correction_rpm_ =
      this->get_parameter("velocity_run_max_correction_rpm").as_double();
  velocity_run_invert_measured_ = this->get_parameter("velocity_run_invert_measured").as_bool();
  velocity_run_feedback_max_age_sec_ =
      this->get_parameter("velocity_run_feedback_max_age_sec").as_double();
  cmd_timeout_sec_ = this->get_parameter("cmd_timeout_sec").as_double();
  control_rate_ = this->get_parameter("control_rate").as_double();
  command_wait_ms_ = static_cast<int>(this->get_parameter("command_wait_ms").as_int());
  {
    const int64_t raw = this->get_parameter("serial_response_timeout_ms").as_int();
    const int64_t clamped =
        std::clamp<int64_t>(raw, motor_control_lib::DdtMotorLib::kMinResponseTimeoutMs,
                            motor_control_lib::DdtMotorLib::kMaxResponseTimeoutMs);
    if (clamped != raw) {
      RCLCPP_WARN(
          this->get_logger(), "serial_response_timeout_ms=%ld is outside [%d, %d]; using %ld ms",
          static_cast<long>(raw), motor_control_lib::DdtMotorLib::kMinResponseTimeoutMs,
          motor_control_lib::DdtMotorLib::kMaxResponseTimeoutMs, static_cast<long>(clamped));
    }
    serial_response_timeout_ms_ = static_cast<int>(clamped);
  }
  stop_resend_interval_ms_ =
      static_cast<int>(this->get_parameter("stop_resend_interval_ms").as_int());
  measured_lpf_tau_sec_ = this->get_parameter("measured_lpf_tau_sec").as_double();
  publish_tf_ = this->get_parameter("publish_tf").as_bool();
  odom_topic_ = this->get_parameter("odom_topic").as_string();
  odom_frame_id_ = this->get_parameter("odom_frame_id").as_string();
  base_frame_id_ = this->get_parameter("base_frame_id").as_string();
}

void DriveComponent::warnIfLqrTicksAssumeAnotherRate() {
  const bool lqr_effective = velocity_run_lqr_enabled_ && control_mode_ == "velocity" &&
                             !velocityRunLqrLacksRunThreshold();
  if (!lqr_effective || std::abs(control_rate_ - kLqrTickRateHz) < 1e-9) {
    return;
  }
  RCLCPP_WARN(this->get_logger(),
              "velocity_run_lqr is enabled with control_rate=%.1f Hz, but its tick-based "
              "parameters assume %.0f Hz: velocity_run_model_delay_ticks=%d is now %.1f ms "
              "(%.1f ms at %.0f Hz), and the observer gains (l_x, l_d) and q/r act per tick. "
              "Identify the drive again at this rate before relying on the correction",
              control_rate_, kLqrTickRateHz, velocity_run_model_delay_ticks_,
              1000.0 * velocity_run_model_delay_ticks_ / control_rate_,
              1000.0 * velocity_run_model_delay_ticks_ / kLqrTickRateHz, kLqrTickRateHz);
}

void DriveComponent::warnCurrentModeAssumptions() {
  // 既定値は変えない（走行挙動を変えない）。評価の前提を起動時に知らせるだけ。
  if (current_ki_ <= 0.0) {
    RCLCPP_WARN(this->get_logger(),
                "current mode with a pure P speed loop (current_kp=%.4f A/rpm, current_ki=%.4f, "
                "max_current_amp=%.2f A): friction leaves a large steady speed error, e.g. "
                "%.2f A at 50 rpm of error. These defaults are a starting point for evaluation, "
                "not a working drive tuning (motor_control_app/README.md)",
                current_kp_, current_ki_, max_current_amp_, current_kp_ * 50.0);
  }
  RCLCPP_WARN(this->get_logger(),
              "current mode: current_invert_measured=%s has no recorded check on this robot. "
              "Confirm the sign with the wheels lifted before driving (README: current mode sign "
              "check); a wrong sign is positive feedback",
              current_invert_measured_ ? "true" : "false");
  RCLCPP_WARN(this->get_logger(),
              "current mode: what the DDT driver does when commands stop is not documented. If it "
              "holds the last current, an unloaded (lifted) wheel accelerates without a speed "
              "limit. Keep max_current_amp low and the emergency stop at hand");
}

bool DriveComponent::velocityRunLqrLacksRunThreshold() const {
  return velocity_run_lqr_enabled_ && control_mode_ == "velocity" &&
         drive_fsm_run_enter_rpm_ <= 0 && drive_fsm_run_exit_rpm_ <= 0;
}

control_core::Config DriveComponent::makeControlCoreConfig() const {
  control_core::Config config;
  config.max_linear_accel = max_linear_accel_;
  config.max_angular_accel = max_angular_accel_;
  config.slew_taper_band_linear = slew_taper_band_linear_;
  config.slew_taper_band_angular = slew_taper_band_angular_;
  config.wheel_radius = wheel_radius_;
  config.wheel_separation = wheel_separation_;
  config.min_command_rpm = min_command_rpm_;
  config.run_enter_rpm = drive_fsm_run_enter_rpm_;
  config.run_exit_rpm = drive_fsm_run_exit_rpm_;
  // RUN 域 LQR+FF は velocity モード専用。current モードではファーム速度ループが無く
  // 前提モデルが成り立たないため、設定が true でも無効にする（起動ログで通知）。
  config.velocity_run.enabled = velocity_run_lqr_enabled_ && control_mode_ == "velocity";
  config.velocity_run.model_tau_sec = velocity_run_model_tau_sec_;
  config.velocity_run.model_delay_ticks = velocity_run_model_delay_ticks_;
  config.velocity_run.q = velocity_run_q_;
  config.velocity_run.r = velocity_run_r_;
  config.velocity_run.lead_gain = velocity_run_lead_gain_;
  config.velocity_run.disturbance_gain = velocity_run_disturbance_gain_;
  config.velocity_run.observer_l_x = velocity_run_observer_l_x_;
  config.velocity_run.observer_l_d = velocity_run_observer_l_d_;
  config.velocity_run.max_correction_rpm = velocity_run_max_correction_rpm_;
  config.velocity_run.invert_measured = velocity_run_invert_measured_;
  return config;
}

rcl_interfaces::msg::SetParametersResult DriveComponent::onParameterChange(
    const std::vector<rclcpp::Parameter>& params) {
  rcl_interfaces::msg::SetParametersResult result;
  result.successful = true;

  // 再初期化なしで反映できないパラメータ。実行時変更は拒否する（受理して黙って無視すると
  // `ros2 param set` が成功を報告してしまい、変わっていないことに気付けない）。
  // 変更するには YAML（launcher/config/drive_component.yaml）を編集してノードを再起動する。
  static const std::vector<std::string> kRequiresReconfigure = {"serial_port",
                                                                "baud_rate",
                                                                "left_motor_id",
                                                                "right_motor_id",
                                                                "max_motor_rpm",
                                                                "control_mode",
                                                                "control_rate",
                                                                "serial_response_timeout_ms",
                                                                "status_publish_rate",
                                                                "wheel_radius",
                                                                "wheel_separation",
                                                                "typed_status_topic",
                                                                "publish_control_sample",
                                                                "control_sample_topic",
                                                                "odom_topic",
                                                                "odom_frame_id",
                                                                "base_frame_id",
                                                                "publish_tf",
                                                                "auto_start",
                                                                "connect_retry_period_sec",
                                                                "emergency_stop_topic",
                                                                "require_emergency_stop",
                                                                "emergency_stop_timeout_sec",
                                                                "require_teacher_permission",
                                                                "teacher_permission_topic",
                                                                "teacher_permission_timeout_sec"};

  bool control_core_dirty = false;
  bool current_pi_dirty = false;
  bool warn_lqr_ignored = false;
  bool lqr_or_run_threshold_changed = false;
  std::vector<std::function<void()>> staged;
  // Phase 1: validate and stage typed values only. No member or subsystem writes.
  try {
    for (const auto& param : params) {
      const auto& name = param.get_name();
      if (name == "max_linear_accel") {
        const auto value = param.get_value<double>();
        staged.emplace_back([this, value]() { max_linear_accel_ = value; });
        control_core_dirty = true;
      } else if (name == "max_angular_accel") {
        const auto value = param.get_value<double>();
        staged.emplace_back([this, value]() { max_angular_accel_ = value; });
        control_core_dirty = true;
      } else if (name == "slew_taper_band_linear") {
        const auto value = param.get_value<double>();
        staged.emplace_back([this, value]() { slew_taper_band_linear_ = value; });
        control_core_dirty = true;
      } else if (name == "slew_taper_band_angular") {
        const auto value = param.get_value<double>();
        staged.emplace_back([this, value]() { slew_taper_band_angular_ = value; });
        control_core_dirty = true;
      } else if (name == "min_command_rpm") {
        const auto raw = param.get_value<int64_t>();
        if (raw < std::numeric_limits<int>::min() || raw > std::numeric_limits<int>::max()) {
          throw std::invalid_argument(name + " is outside the supported int range");
        }
        const int value = static_cast<int>(raw);
        staged.emplace_back([this, value]() {
          min_command_rpm_ = value;
          if (diff_drive_) {
            diff_drive_->setMinCommandRpm(value);
          }
        });
        control_core_dirty = true;

        // --- 走行状態機械 / RUN 域 LQR+FF（制御コアへ反映） ---
        // run_exit > run_enter の組は拒否しない（drive_mode_fsm 側が使用時に正規化する）。
      } else if (name == "drive_fsm_run_enter_rpm") {
        const auto raw = param.get_value<int64_t>();
        if (raw < 0 || raw > std::numeric_limits<int>::max()) {
          throw std::invalid_argument(name + " requires 0..INT_MAX (0 = disabled)");
        }
        const int value = static_cast<int>(raw);
        staged.emplace_back([this, value]() { drive_fsm_run_enter_rpm_ = value; });
        control_core_dirty = true;
        lqr_or_run_threshold_changed = true;
      } else if (name == "drive_fsm_run_exit_rpm") {
        const auto raw = param.get_value<int64_t>();
        if (raw < 0 || raw > std::numeric_limits<int>::max()) {
          throw std::invalid_argument(name + " requires 0..INT_MAX (0 = disabled)");
        }
        const int value = static_cast<int>(raw);
        staged.emplace_back([this, value]() { drive_fsm_run_exit_rpm_ = value; });
        control_core_dirty = true;
        lqr_or_run_threshold_changed = true;
      } else if (name == "velocity_run_lqr_enabled") {
        const auto value = param.get_value<bool>();
        staged.emplace_back([this, value]() { velocity_run_lqr_enabled_ = value; });
        control_core_dirty = true;
        // 警告は commit 成功後に出す（後続パラメータでリクエスト全体が失敗し得るため）。
        warn_lqr_ignored = value && control_mode_ != "velocity";
        lqr_or_run_threshold_changed = true;
      } else if (name == "velocity_run_model_tau_sec") {
        const auto value = param.get_value<double>();
        if (!std::isfinite(value) || value <= 0.0) {
          throw std::invalid_argument(name + " requires a finite positive value");
        }
        staged.emplace_back([this, value]() { velocity_run_model_tau_sec_ = value; });
        control_core_dirty = true;
      } else if (name == "velocity_run_model_delay_ticks") {
        const auto raw = param.get_value<int64_t>();
        if (raw < 0 || raw > motor_control_lib::wheel_observer::kMaxDelayTicks) {
          throw std::invalid_argument(
              name + " requires 0.." +
              std::to_string(motor_control_lib::wheel_observer::kMaxDelayTicks));
        }
        const int value = static_cast<int>(raw);
        staged.emplace_back([this, value]() { velocity_run_model_delay_ticks_ = value; });
        control_core_dirty = true;
      } else if (name == "velocity_run_q") {
        const auto value = param.get_value<double>();
        if (!std::isfinite(value) || value < 0.0) {
          throw std::invalid_argument(name + " requires a finite nonnegative value");
        }
        staged.emplace_back([this, value]() { velocity_run_q_ = value; });
        control_core_dirty = true;
      } else if (name == "velocity_run_r") {
        const auto value = param.get_value<double>();
        if (!std::isfinite(value) || value <= 0.0) {
          throw std::invalid_argument(name + " requires a finite positive value");
        }
        staged.emplace_back([this, value]() { velocity_run_r_ = value; });
        control_core_dirty = true;
      } else if (name == "velocity_run_lead_gain") {
        const auto value = param.get_value<double>();
        if (!std::isfinite(value) || value < 0.0 || value > 1.0) {
          throw std::invalid_argument(name + " requires a finite value in [0, 1]");
        }
        staged.emplace_back([this, value]() { velocity_run_lead_gain_ = value; });
        control_core_dirty = true;
      } else if (name == "velocity_run_disturbance_gain") {
        const auto value = param.get_value<double>();
        if (!std::isfinite(value) || value < 0.0 || value > 1.0) {
          throw std::invalid_argument(name + " requires a finite value in [0, 1]");
        }
        staged.emplace_back([this, value]() { velocity_run_disturbance_gain_ = value; });
        control_core_dirty = true;
      } else if (name == "velocity_run_observer_l_x") {
        const auto value = param.get_value<double>();
        if (!std::isfinite(value) || value < 0.0 || value > 1.0) {
          throw std::invalid_argument(name + " requires a finite value in [0, 1]");
        }
        staged.emplace_back([this, value]() { velocity_run_observer_l_x_ = value; });
        control_core_dirty = true;
      } else if (name == "velocity_run_observer_l_d") {
        const auto value = param.get_value<double>();
        if (!std::isfinite(value) || value < 0.0) {
          throw std::invalid_argument(name + " requires a finite nonnegative value");
        }
        staged.emplace_back([this, value]() { velocity_run_observer_l_d_ = value; });
        control_core_dirty = true;
      } else if (name == "velocity_run_max_correction_rpm") {
        const auto value = param.get_value<double>();
        if (!std::isfinite(value) || value < 0.0) {
          throw std::invalid_argument(name + " requires a finite nonnegative value");
        }
        staged.emplace_back([this, value]() { velocity_run_max_correction_rpm_ = value; });
        control_core_dirty = true;
      } else if (name == "velocity_run_invert_measured") {
        const auto value = param.get_value<bool>();
        staged.emplace_back([this, value]() { velocity_run_invert_measured_ = value; });
        control_core_dirty = true;
      } else if (name == "velocity_run_feedback_max_age_sec") {
        // 制御 tick が直接見る値（制御コアの設定ではないので control_core_dirty は不要）
        const auto value = param.get_value<double>();
        if (!std::isfinite(value) || value <= 0.0) {
          throw std::invalid_argument(name + " requires a finite positive value");
        }
        staged.emplace_back([this, value]() { velocity_run_feedback_max_age_sec_ = value; });
      } else if (name == "cmd_timeout_sec") {
        const auto value = param.get_value<double>();
        staged.emplace_back([this, value]() { cmd_timeout_sec_ = value; });
      } else if (name == "brake_on_stop") {
        const auto value = param.get_value<bool>();
        staged.emplace_back([this, value]() {
          brake_on_stop_ = value;
          if (motor_lib_) {
            motor_lib_->setBrakeOnStop(value);
          }
        });
      } else if (name == "stop_resend_interval_ms") {
        const auto raw = param.get_value<int64_t>();
        if (raw < std::numeric_limits<int>::min() || raw > std::numeric_limits<int>::max()) {
          throw std::invalid_argument(name + " is outside the supported int range");
        }
        const int value = static_cast<int>(raw);
        staged.emplace_back([this, value]() {
          stop_resend_interval_ms_ = value;
          if (motor_lib_) {
            motor_lib_->setStopResendIntervalMs(value);
          }
        });
      } else if (name == "measured_lpf_tau_sec") {
        const auto value = param.get_value<double>();
        staged.emplace_back([this, value]() {
          measured_lpf_tau_sec_ = value;
          if (motor_lib_) {
            motor_lib_->setMeasuredLowpassTau(value);
          }
        });
      } else if (name == "command_wait_ms") {
        const auto raw = param.get_value<int64_t>();
        if (raw < std::numeric_limits<int>::min() || raw > std::numeric_limits<int>::max()) {
          throw std::invalid_argument(name + " is outside the supported int range");
        }
        const int value = static_cast<int>(raw);
        staged.emplace_back([this, value]() {
          command_wait_ms_ = value;
          if (motor_lib_) {
            motor_lib_->setCommandWaitMs(value);
          }
        });
      } else if (name == "current_kp") {
        const auto value = param.get_value<double>();
        if (!std::isfinite(value)) {
          throw std::invalid_argument(name + " requires a finite value");
        }
        staged.emplace_back([this, value]() { current_kp_ = value; });
        current_pi_dirty = true;
      } else if (name == "current_ki") {
        const auto value = param.get_value<double>();
        if (!std::isfinite(value)) {
          throw std::invalid_argument(name + " requires a finite value");
        }
        staged.emplace_back([this, value]() { current_ki_ = value; });
        current_pi_dirty = true;
      } else if (name == "max_current_amp") {
        const auto value = param.get_value<double>();
        if (!std::isfinite(value) || value < 0.0) {
          throw std::invalid_argument(name + " requires a finite nonnegative value");
        }
        staged.emplace_back([this, value]() { max_current_amp_ = value; });
        current_pi_dirty = true;
      } else if (name == "integral_limit_amp") {
        const auto value = param.get_value<double>();
        if (!std::isfinite(value) || value < 0.0) {
          throw std::invalid_argument(name + " requires a finite nonnegative value");
        }
        staged.emplace_back([this, value]() { integral_limit_amp_ = value; });
        current_pi_dirty = true;
      } else if (name == "current_zero_deadband_rpm") {
        const auto raw = param.get_value<int64_t>();
        if (raw < 0 || raw > std::numeric_limits<int>::max()) {
          throw std::invalid_argument(name + " is outside the supported int range");
        }
        const int value = static_cast<int>(raw);
        staged.emplace_back([this, value]() {
          current_zero_deadband_rpm_ = value;
          if (motor_lib_) {
            motor_lib_->setCurrentZeroDeadbandRpm(value);
          }
        });
      } else if (name == "current_invert_measured") {
        const auto value = param.get_value<bool>();
        staged.emplace_back([this, value]() {
          current_invert_measured_ = value;
          if (motor_lib_) {
            motor_lib_->setCurrentInvertMeasured(value);
          }
        });
      } else if (std::find(kRequiresReconfigure.begin(), kRequiresReconfigure.end(), name) !=
                 kRequiresReconfigure.end()) {
        throw std::invalid_argument(
            "parameter '" + name +
            "' cannot be applied at runtime; edit YAML and restart the node");
      }
    }
  } catch (const std::exception& e) {
    result.successful = false;
    result.reason = std::string("Failed to update parameters: ") + e.what();
    return result;
  }

  // Phase 2 setters must remain local-state-only and non-failing.
  // Fallible operations must not be added without revisiting transaction design.
  for (const auto& commit : staged) {
    commit();
  }
  if (current_pi_dirty && motor_lib_) {
    motor_lib_->setCurrentControlParams(current_kp_, current_ki_, max_current_amp_,
                                        integral_limit_amp_);
  }
  if (control_core_dirty && control_core_) {
    control_core_->setConfig(makeControlCoreConfig());
  }
  if (lqr_or_run_threshold_changed) {
    warnIfLqrTicksAssumeAnotherRate();
  }
  if (lqr_or_run_threshold_changed && velocityRunLqrLacksRunThreshold()) {
    RCLCPP_WARN(this->get_logger(),
                "velocity_run_lqr_enabled=true ですが RUN 閾値が両方 0 のため LQR+FF は"
                "適用しません（FF のみ）");
  }
  if (warn_lqr_ignored) {
    RCLCPP_WARN(this->get_logger(),
                "velocity_run_lqr_enabled は velocity モード専用です（現在 '%s'、無視）",
                control_mode_.c_str());
  }
  result.reason = "Parameters updated successfully";
  return result;
}

}  // namespace motor_control_app
