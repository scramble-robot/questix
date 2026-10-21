// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// DriveComponent: motor library, control loop, motion permission / E-stop gate, status
// and odometry (see drive_component.cpp for how the class is split).
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
// 未武装（駆動指令を送っていない）間にフィードバック快照の鮮度を維持するポーリング周期の
// 目安 [s]。この鮮度以内なら再取得しない。再取得は停止フレームの再送なので
// stop_resend_interval_ms のスロットルにも従い、実際の周期は長い方になる（既定 300 ms で
// ≈3 Hz、最大 age ≈0.32 s）。odometry::kMaxFeedbackAgeSec（stale 判定）より十分小さくすること。
constexpr double kIdleFeedbackMaxAgeSec = 0.2;

// 停止指令を送れなかったとき（stop fault）の再送間隔 [s]。
constexpr double kStopRetryPeriodSec = 0.5;

double secondsSince(std::chrono::steady_clock::time_point then,
                    std::chrono::steady_clock::time_point now) {
  return std::chrono::duration<double>(now - then).count();
}
}  // namespace

bool DriveComponent::initializeMotorLib() {
  resetOdometryAnchor("motor initialization");
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

    // ファーム側加速時間（velocity モードのみ有効）。実機評価で 1 に確定:
    // 1 より大きくすると高RPM の直進が乱れる。加速プロファイルの整形はホスト側の
    // スルーレート制限（max_*_accel + slew_taper_band_*）に一本化し、ファーム側の
    // 平滑化は実質無効（1 = 0.1ms/rpm）で固定する。パラメータとしては公開しない
    // （二重の加速プロファイルがチューニングを非直交にしていたため廃止）。
    constexpr int kFirmwareAccelTime0p1msPerRpm = 1;
    motor_lib_->setAccelTime(kFirmwareAccelTime0p1msPerRpm);

    // 指令送信後の追加待機（既定 0 = 無効）
    motor_lib_->setCommandWaitMs(command_wait_ms_);

    // フィードバック応答待ちの上限（既定 10 ms = 従来の固定値）
    motor_lib_->setResponseTimeoutMs(serial_response_timeout_ms_);

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
      motor_lib_->setCurrentMeasuredSource(
          current_measured_source_ == "reported"
              ? motor_control_lib::CurrentMeasuredSource::Reported
              : motor_control_lib::CurrentMeasuredSource::Position);
      motor_lib_->setCurrentFeedforward(current_ff_static_amp_, current_ff_viscous_amp_per_rpm_);
      motor_lib_->setCurrentGuardParams(current_guard_overspeed_margin_rpm_,
                                        current_guard_overspeed_time_sec_);
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
      (void)diff_drive_->stopNow();
    }
    motor_lib_->emergencyStop();
    motor_lib_->shutdown();
  }
  control_core_.reset();
  diff_drive_.reset();
  motor_lib_.reset();
  motor_initialized_ = false;
}

void DriveComponent::resetCommandState() {
  odom_left_ref_rpm_ = 0.0;
  odom_right_ref_rpm_ = 0.0;
  needs_neutral_warned_ = false;
  rearm_.reset();
  pending_cmd_timeout_stop_ = false;
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
  odom_estop_poll_skipped_ = false;
  odom_estop_suspended_ = false;
  odom_estop_release_pending_ = false;
  odom_estop_released_at_ = {};
  odom_estop_left_count_ = 0;
  odom_estop_right_count_ = 0;
  odom_publisher_.reset();
  tf_broadcaster_.reset();
  resetOdometryAnchor("lifecycle resources reset");
}

void DriveComponent::resetOdometryAnchor(const char* reason) {
  odom_position_integrator_.reset();
  odom_left_ref_rpm_ = 0.0;
  odom_right_ref_rpm_ = 0.0;
  odom_last_pair_stationary_ = false;
  // Routine lifecycle/init retries are expected, including with no motor power.
  RCLCPP_DEBUG_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                        "Wheel position odometry anchor reset: %s (pose retained)", reason);
}

// Observe both callbacks and ticks so a reason change without a twist still ends the episode.
void DriveComponent::observeTwistLogBlock(actuation_gate::Block block) {
  if (block != twist_log_block_) {
    blocked_twist_warned_ = false;
    needs_neutral_warned_ = false;
    twist_log_block_ = block;
  }
}

void DriveComponent::twistCallback(const geometry_msgs::msg::Twist::SharedPtr msg) {
  // inactive 中の twist は無視する（lifecycle activate 後にのみ駆動する）
  if (this->get_current_state().id() != lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE) {
    return;
  }

  // 走行許可なし・非常停止中・E-stop 不明/途絶・stop fault の間は目標を保存しない
  // （開いた後も中立を受けるまでは走行を再開しない）。
  const auto block = actuation_gate::evaluate(gateInputs());
  observeTwistLogBlock(block);
  const bool strict_neutral = msg->linear.x == 0.0 && msg->angular.z == 0.0;
  if (strict_neutral) {
    blocked_twist_warned_ = false;
    needs_neutral_warned_ = false;
  }
  if (block != actuation_gate::Block::kNone) {
    rearm_.reset();  // also latch a closed gate observed before its control tick
    if (strict_neutral) {
      RCLCPP_DEBUG(this->get_logger(), "Actuation blocked (%s), ignoring neutral twist command",
                   actuation_gate::blockName(block));
    } else if (!blocked_twist_warned_) {
      RCLCPP_WARN(this->get_logger(),
                  "Actuation blocked (%s), ignoring twist command: linear=%g angular=%g",
                  actuation_gate::blockName(block), msg->linear.x, msg->angular.z);
      blocked_twist_warned_ = true;
    }
    return;
  }

  if (pending_cmd_timeout_stop_) return;  // cannot cancel a stop owed by a late callback
  const bool motor_healthy = motor_initialized_ && diff_drive_ && diff_drive_->isHealthy();
  const auto decision =
      rearm_.command(msg->linear.x, msg->angular.z, this->now().seconds(), cmd_timeout_sec_,
                     !motor_healthy, rearm_neutral_linear_, rearm_neutral_angular_);
  using Decision = drive_rearm::Rearm::Decision;
  if (decision == Decision::kTimeout) {
    pending_cmd_timeout_stop_ = true;  // I/O remains in the control tick
    return;
  }
  if (decision == Decision::kNeedsNeutral) {
    if (!needs_neutral_warned_) {
      RCLCPP_WARN(this->get_logger(),
                  "Drive needs neutral: linear=%g angular=%g; bands linear=%g angular=%g",
                  msg->linear.x, msg->angular.z, rearm_neutral_linear_, rearm_neutral_angular_);
      needs_neutral_warned_ = true;
    }
    return;
  }
  if (decision == Decision::kInvalid) {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                         "Ignoring non-finite drive command");
    return;
  }
  if (decision == Decision::kInhibited) return;
  needs_neutral_warned_ = false;

  // 制御実行は controlTimerCallback（固定周期の制御 tick）に集約されている。ここでは
  // 最新目標の保存のみを行い、シリアル I/O もスルーレート計算もしない。これにより
  // 制御周期（= スルーレートの dt）が上流の publish レートやメッセージ取りこぼしから
  // 独立する（従来は /target_twist の到着間隔が dt だった）。
  target_linear_ = decision == Decision::kNeutral ? 0.0 : msg->linear.x;
  target_angular_ = decision == Decision::kNeutral ? 0.0 : msg->angular.z;
  last_cmd_time_ = this->now();
  has_target_ = true;
}

void DriveComponent::controlTimerCallback() {
  const auto tick_start = std::chrono::steady_clock::now();
  const rclcpp::Time tick_stamp = this->now();
  odom_tick_time_sec_ = std::chrono::duration<double>(tick_start.time_since_epoch()).count();

  // この tick の診断サンプル。送受信の前のカウンタを取っておき、tick の後と比べる。
  tick_sample_ = drive_control_sample::TickInput{};
  if (motor_lib_ && control_sample_publisher_) {
    motor_lib_->getMotorTransactionStats(left_motor_id_, tick_sample_.left.stats_before);
    motor_lib_->getMotorTransactionStats(right_motor_id_, tick_sample_.right.stats_before);
  }
  // Odometry inputs are separate from diagnostics and start neutral every tick:
  // idle/stop/fault/timeout never inherit a previous driving reference.
  odom_left_ref_rpm_ = 0.0;
  odom_right_ref_rpm_ = 0.0;
  odom_estop_poll_skipped_ = false;  // only kIdle below can record an intentional skip
  in_control_tick_ = true;
  runControlTick();
  in_control_tick_ = false;
  integrateOdometry();
  publishControlSample(tick_stamp, tick_start);
}

void DriveComponent::integrateOdometry() {
  if (!motor_lib_ || !motor_initialized_ || stop_fault_) {
    const auto state = !motor_lib_ || !motor_initialized_ ? OdomMotorState::kUnavailable
                                                          : OdomMotorState::kStopFault;
    resetOdometryAnchor(state == OdomMotorState::kUnavailable ? "motor unavailable" : "stop fault");
    if (state != odom_motor_state_) {
      RCLCPP_WARN(this->get_logger(), "Wheel position odometry anchor reset: %s (pose retained)",
                  state == OdomMotorState::kUnavailable ? "motor unavailable" : "stop fault");
    }
    odom_motor_state_ = state;
    return;
  }
  odom_motor_state_ = OdomMotorState::kReady;
  const auto steadySeconds = []() {
    return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
  };
  motor_control_lib::DdtMotorLib::MotorFeedbackData left_fb, right_fb;
  motor_control_lib::DdtMotorLib::MotorTransactionStats left_tx, right_tx;
  const bool left_ok = motor_lib_->getMotorFeedbackData(left_motor_id_, left_fb);
  const double left_now = steadySeconds();
  const bool right_ok = motor_lib_->getMotorFeedbackData(right_motor_id_, right_fb);
  const double right_now = steadySeconds();
  const bool left_stats = motor_lib_->getMotorTransactionStats(left_motor_id_, left_tx);
  const bool right_stats = motor_lib_->getMotorTransactionStats(right_motor_id_, right_tx);
  const wheel_position::Sample left{left_fb.position_raw,
                                    static_cast<double>(left_fb.velocity_rpm_raw),
                                    left_now - left_fb.feedback_age_sec,
                                    left_tx.feedback_count,
                                    left_ok && left_stats && left_fb.has_feedback,
                                    left_fb.fault_code,
                                    odom_left_ref_rpm_,
                                    left_fb.mode == (control_mode_ == "current" ? 1 : 2)};
  const wheel_position::Sample right{right_fb.position_raw,
                                     static_cast<double>(right_fb.velocity_rpm_raw),
                                     right_now - right_fb.feedback_age_sec,
                                     right_tx.feedback_count,
                                     right_ok && right_stats && right_fb.has_feedback,
                                     right_fb.fault_code,
                                     odom_right_ref_rpm_,
                                     right_fb.mode == (control_mode_ == "current" ? 1 : 2)};
  const wheel_position::Limits limits{wheel_radius_, wheel_separation_,
                                      static_cast<double>(max_motor_rpm_), max_linear_accel_,
                                      max_angular_accel_};
  // The pure tracker retains feedback_count gating and waits for BOTH new
  // endpoints. It also checks the pairing deadline on ticks with no new data.
  const double odom_now = steadySeconds();
  // ref belongs to tick START, before serial replies. Using the end-of-tick
  // now would wrongly exclude this tick's ref from a new anchor's history.
  const auto result =
      odom_position_integrator_.update(left, right, odom_now, limits, odom_tick_time_sec_);
  odom_pose_ = wheel_position::integrate(odom_pose_, result);
  const bool stationary = left.native_rpm == 0.0 && right.native_rpm == 0.0;
  if (result.state == wheel_position::State::kAnchored ||
      result.state == wheel_position::State::kIntegrated) {
    odom_last_pair_stationary_ = stationary;
  }
  const auto log_now = std::chrono::steady_clock::now();
  if (odom_estop_poll_skipped_) {
    if (!odom_estop_suspended_) {
      RCLCPP_INFO(this->get_logger(),
                  "Wheel position odometry deferred: E-stop polling suspended (pose retained)");
    }
    odom_estop_suspended_ = true;
    odom_estop_release_pending_ = false;
    odom_estop_left_count_ = left.count;
    odom_estop_right_count_ = right.count;
  } else if (odom_estop_suspended_) {
    odom_estop_suspended_ = false;
    odom_estop_release_pending_ = true;
    odom_estop_released_at_ = log_now;
  }
  // Require BOTH new endpoints, not a re-anchor on feedback retained from before the E-stop.
  if (odom_estop_release_pending_ &&
      (result.state == wheel_position::State::kAnchored ||
       result.state == wheel_position::State::kIntegrated) &&
      left.count > odom_estop_left_count_ && right.count > odom_estop_right_count_) {
    odom_estop_release_pending_ = false;
  }
  const bool estop_known = last_block_ != actuation_gate::Block::kEstopUnknown &&
                           last_block_ != actuation_gate::Block::kEstopStale;
  const auto finite_zero = [](double value) { return std::isfinite(value) && value == 0.0; };
  // Log evidence only: a re-armed neutral controller uses TICK_DRIVE too. Require both
  // the accepted/shaped commands and the last SUCCESSFUL wheel frames to be zero.
  // RPM targets alone cannot prove this in current mode (nonzero PI current at zero RPM).
  const bool zero_command =
      motor_initialized_ && !stop_fault_ && diff_drive_ && control_core_ &&
      (!has_target_ || (finite_zero(target_linear_) && finite_zero(target_angular_))) &&
      finite_zero(control_core_->lastLinear()) && finite_zero(control_core_->lastAngular()) &&
      left_fb.target_rpm == 0 && right_fb.target_rpm == 0 && diff_drive_->lastSentIsZero();
  // ID13 needed about 1.3 s for its first reply. Eight existing idle polling intervals plus
  // two ticks give 1.64 s at 50 Hz, allowing that observed delay with scheduling margin.
  // This bounds LOG suppression only: no polling, safety, anchor or pose decision reads it.
  const double release_grace =
      8.0 * kIdleFeedbackMaxAgeSec + 2.0 * drive_control_tick::tickDtSec(control_rate_);
  if (!estop_known || !zero_command ||
      (odom_estop_release_pending_ &&
       secondsSince(odom_estop_released_at_, log_now) >= release_grace)) {
    odom_estop_release_pending_ = false;
  }
  if (result.stop_gap && result.reason != wheel_position::Reason::kNone) {
    const auto decisionName = [](wheel_position::StopDecision decision) {
      switch (decision) {
        case wheel_position::StopDecision::kAccepted:
          return "accepted";
        case wheel_position::StopDecision::kOutside:
          return "outside bound";
        case wheel_position::StopDecision::kAmbiguous:
          return "ambiguous";
        case wheel_position::StopDecision::kHardGate:
          return "hard gate";
      }
      return "unknown";
    };
    RCLCPP_WARN_THROTTLE(
        this->get_logger(), *this->get_clock(), 1000,
        "Wheel position odometry anchor reset: stop gap %s; "
        "left=%s (%s) d=%.9g U=%.9g right=%s (%s) d=%.9g U=%.9g (pose retained)",
        wheel_position::reasonName(result.reason), decisionName(result.left.decision),
        wheel_position::reasonName(result.left.reason), result.left.turns, result.left.upper,
        decisionName(result.right.decision), wheel_position::reasonName(result.right.reason),
        result.right.turns, result.right.upper);
  } else if (result.state == wheel_position::State::kReset) {
    // kInvalid also covers bad dimensions or malformed/counter-rollback feedback: keep those
    // WARNs even if the other wheel has never answered. These checks classify logs only.
    const bool geometry_valid = std::isfinite(limits.radius) && limits.radius > 0.0 &&
                                std::isfinite(limits.separation) && limits.separation > 0.0 &&
                                std::isfinite(limits.max_rpm) && limits.max_rpm > 0.0;
    const auto valid_if_received = [](const wheel_position::Sample& sample, double now) {
      return !sample.received ||
             (std::isfinite(sample.time_sec) && sample.time_sec <= now &&
              std::isfinite(sample.native_rpm) &&
              sample.position <= motor_control_lib::ddt_protocol::kPositionRawPerTurn);
    };
    const bool unheard = (!left.received || !right.received) && valid_if_received(left, left_now) &&
                         valid_if_received(right, right_now);
    const bool harmless_inputs = geometry_valid && left.fault == 0 && right.fault == 0;
    const bool expected_missing = result.reason == wheel_position::Reason::kInvalid && unheard;
    const bool estop_reset = harmless_inputs && odom_estop_poll_skipped_ &&
                             (expected_missing || result.reason == wheel_position::Reason::kStale);
    // Use the same samples, time and age limit as Integrator::update to identify stale wheels.
    // Only stale wheels must retain their suspension counts; a fresh wheel may have advanced.
    const bool left_stale = odom_now - left.time_sec > odometry::kMaxFeedbackAgeSec;
    const bool right_stale = odom_now - right.time_sec > odometry::kMaxFeedbackAgeSec;
    const bool retained_stale = result.reason == wheel_position::Reason::kStale &&
                                (!left_stale || left.count == odom_estop_left_count_) &&
                                (!right_stale || right.count == odom_estop_right_count_);
    const bool release_reset =
        harmless_inputs && odom_estop_release_pending_ &&
        (expected_missing || result.reason == wheel_position::Reason::kGap || retained_stale);
    // Only the expected gap of healthy, zero-command idle polling is quiet.
    // A last moving pair, nonzero command/RPM, stale/fault or ambiguous result
    // remains a WARN. Logging never changes the reset/integration decision.
    const bool idle_gap = estop_known && result.reason == wheel_position::Reason::kGap &&
                          odom_last_pair_stationary_ && stationary && left_fb.target_rpm == 0 &&
                          right_fb.target_rpm == 0;
    if (estop_reset || release_reset) {
      RCLCPP_DEBUG_THROTTLE(
          this->get_logger(), *this->get_clock(), 1000,
          "Wheel position odometry deferred: %s; %s (pose retained)",
          estop_reset ? "E-stop polling suspended" : "E-stop release awaiting fresh pair",
          wheel_position::reasonName(result.reason));
    } else if (idle_gap) {
      RCLCPP_DEBUG_THROTTLE(
          this->get_logger(), *this->get_clock(), 1000,
          "Wheel position odometry anchor reset: idle polling gap (pose retained)");
    } else {
      RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                           "Wheel position odometry anchor reset: %s (pose retained)",
                           wheel_position::reasonName(result.reason));
    }
  }
}

void DriveComponent::publishControlSample(const rclcpp::Time& tick_stamp,
                                          std::chrono::steady_clock::time_point tick_start) {
  if (!control_sample_publisher_) {
    return;
  }
  auto& sample = tick_sample_;
  sample.seq = control_sample_seq_++;
  sample.tick_start = tick_stamp;
  sample.control_period_sec = drive_control_tick::tickDtSec(control_rate_);
  sample.current_mode = (control_mode_ == "current");
  if (control_core_) {
    sample.drive_mode = control_core_->mode();
  }
  if (sample.tick_action != questix_msgs::msg::DriveControlSample::TICK_DRIVE && control_core_) {
    // 駆動しなかった tick の整形後指令は制御コアの保持値（停止・リセット後は 0）。
    sample.shaped_linear = control_core_->lastLinear();
    sample.shaped_angular = control_core_->lastAngular();
  }
  if (motor_lib_) {
    motor_lib_->getMotorTransactionStats(left_motor_id_, sample.left.stats_after);
    motor_lib_->getMotorTransactionStats(right_motor_id_, sample.right.stats_after);
    motor_lib_->getMotorFeedbackData(left_motor_id_, sample.left.feedback);
    motor_lib_->getMotorFeedbackData(right_motor_id_, sample.right.feedback);
  }
  sample.now = this->now();
  sample.tick_duration_sec =
      std::chrono::duration<double>(std::chrono::steady_clock::now() - tick_start).count();
  control_sample_publisher_->publish(drive_control_sample::toDriveControlSampleMsg(sample));
}

void DriveComponent::runControlTick() {
  const auto tick_start = std::chrono::steady_clock::now();

  // control_core_ は diff_drive_ と同じライフサイクル（initializeMotorLib で構築、
  // shutdownMotorLib で破棄）だが、kDrive 経路で参照するため準備判定に含める。
  const bool motor_ready = motor_initialized_ && diff_drive_ != nullptr && control_core_ != nullptr;

  // 停止指令を送れなかった後は、両輪へのゼロ送信が成功するまで一定間隔で再送する
  // （成功しても停止のまま。次の /target_twist で初めて動く）。
  if (stop_fault_ && motor_ready) {
    const auto now_steady = std::chrono::steady_clock::now();
    if (actuation_gate::shouldRetryStop(stop_fault_, secondsSince(last_stop_attempt_, now_steady),
                                        kStopRetryPeriodSec)) {
      last_stop_attempt_ = now_steady;
      const bool zero_sent = diff_drive_->stopNow();
      tick_sample_.stop_frame = true;
      tick_sample_.command_sent = zero_sent;
      if (zero_sent) {
        stop_fault_ = false;
        RCLCPP_INFO(this->get_logger(),
                    "Stop fault cleared: zero sent to both wheels (still stopped until the next "
                    "neutral command)");
      } else {
        RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                              "Stop fault: zero could not be sent yet, retrying every %.1fs",
                              kStopRetryPeriodSec);
      }
    }
  }

  // 走行許可（L2）・E-stop（L1）・stop fault のゲート。閉じたら停止 + 武装解除（applyGate）。
  const auto block = applyGate();

  if (pending_cmd_timeout_stop_) {
    tick_sample_.tick_action = questix_msgs::msg::DriveControlSample::TICK_TIMEOUT_STOP;
    safetyStop("command timeout observed by input callback");
    return;
  }

  const double elapsed = has_target_ ? (this->now() - last_cmd_time_).seconds() : 0.0;
  // isHealthy はキャッシュ済みフィードバックの fault コードを見るだけでシリアルには触らない
  const bool healthy = motor_ready && diff_drive_->isHealthy();
  if (!healthy) rearm_.reset();  // a zero received while faulty cannot arm its recovery
  if (motor_ready) {
    reportCurrentGuardTrips();  // 作動・解除の変化だけをログに出す
  }

  using SampleMsg = questix_msgs::msg::DriveControlSample;
  switch (drive_control_tick::decideTickAction(has_target_, motor_ready,
                                               block != actuation_gate::Block::kNone, healthy,
                                               elapsed, cmd_timeout_sec_)) {
    case drive_control_tick::TickAction::kIdle:
      tick_sample_.tick_action = SampleMsg::TICK_IDLE;
      // 未武装（起動直後・タイムアウト/非常停止/フォールト停止後）またはゲートが閉じている。
      // 駆動指令は送らないが、フィードバックが古ければ低頻度で再取得する（外力で車輪が回された
      // 場合の観測と /drive_status の鮮度のため）。再取得が送るのは送信に成功したゼロだけで、
      // 非ゼロの再送はしない（DdtMotorLib::refreshMotorFeedback）。押下を受信している間と
      // stop fault の間（再送は上で行う）は送らない。
      // Log evidence only: do not infer a deliberate suspension from old feedback or permission.
      odom_estop_poll_skipped_ =
          motor_ready && motor_lib_ && block == actuation_gate::Block::kEstopActive;
      if (motor_ready && motor_lib_ && block != actuation_gate::Block::kEstopActive &&
          block != actuation_gate::Block::kStopFault) {
        motor_lib_->refreshMotorFeedback(left_motor_id_, kIdleFeedbackMaxAgeSec);
        motor_lib_->refreshMotorFeedback(right_motor_id_, kIdleFeedbackMaxAgeSec);
      }
      return;
    case drive_control_tick::TickAction::kTimeoutStop:
      tick_sample_.tick_action = SampleMsg::TICK_TIMEOUT_STOP;
      RCLCPP_WARN(this->get_logger(),
                  "Command timeout: no /target_twist for %.2fs (limit %.2fs), stopping motors",
                  elapsed, cmd_timeout_sec_);
      // safetyStop は各ホイールへスロットル無しでゼロを送り（電流PI積分状態もリセット）、
      // 武装解除する（WARN はイベント毎に1回）。中立の /target_twist を受けるまで再武装せず、
      // スルーレートクランプもゼロから再スタートする。送れなければ stop fault。
      safetyStop("command timeout");
      return;
    case drive_control_tick::TickAction::kFaultStop:
      tick_sample_.tick_action = SampleMsg::TICK_FAULT_STOP;
      // モータ異常中は最後の指令を保持せず、明示的に停止指令を送って武装解除する。
      // current モードの暴走ガード（ホスト側の判定）もここに来る。
      safetyStop("motor fault");
      RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                           "Motor not healthy: sending stop command");
      return;
    case drive_control_tick::TickAction::kDrive:
      tick_sample_.tick_action = SampleMsg::TICK_DRIVE;
      break;
  }

  // ホスト側の制御コアで 1 ステップ進める（スルーレート制限 -> 運動学 -> 停止判定）。
  // dt は固定周期の定数なので、実効加速度プロファイルが上流の publish レートに依存しない。
  // 制御則の詳細は control_core.hpp / drive_slew.hpp を参照。
  const double dt = drive_control_tick::tickDtSec(control_rate_);

  // 実測車輪 RPM（生値、モータフレーム）を制御コアへ渡す。RUN 域 LQR+FF（velocity モード、
  // 有効時のみ）が使う。両輪のフィードバックが新鮮でなければ valid=false = FF のみ（従来挙動）。
  control_core::WheelFeedback feedback;
  if (motor_lib_) {
    motor_control_lib::DdtMotorLib::MotorFeedbackData left_fb, right_fb;
    const bool got = motor_lib_->getMotorFeedbackData(left_motor_id_, left_fb) &&
                     motor_lib_->getMotorFeedbackData(right_motor_id_, right_fb);
    if (got && left_fb.has_feedback && right_fb.has_feedback &&
        left_fb.feedback_age_sec <= velocity_run_feedback_max_age_sec_ &&
        right_fb.feedback_age_sec <= velocity_run_feedback_max_age_sec_) {
      feedback.valid = true;
      feedback.left_rpm = left_fb.velocity_rpm_raw;
      feedback.right_rpm = right_fb.velocity_rpm_raw;
    }
  }
  const auto out = control_core_->step(target_linear_, target_angular_, dt, feedback);
  odom_left_ref_rpm_ = out.left_ref_rpm;
  odom_right_ref_rpm_ = out.right_ref_rpm;

  // 指令送信（応答フレームでフィードバック快照も更新される）。停止判定は制御コアが
  // 済ませているため、送信先は停止指令か生の車輪 RPM のどちらかになる。
  const bool sent =
      out.stop ? diff_drive_->commandStop() : diff_drive_->setWheelRpm(out.left_rpm, out.right_rpm);
  tick_sample_.command_sent = sent;
  tick_sample_.stop_frame = out.stop;
  tick_sample_.lqr_active = out.lqr_active;
  tick_sample_.shaped_linear = out.linear;
  tick_sample_.shaped_angular = out.angular;
  tick_sample_.left.ref_rpm = out.left_ref_rpm;
  tick_sample_.right.ref_rpm = out.right_ref_rpm;
  tick_sample_.left.command_rpm = out.stop ? 0 : out.left_rpm;
  tick_sample_.right.command_rpm = out.stop ? 0 : out.right_rpm;
  if (!sent) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                          "Failed to set motor velocity");
    return;
  }

  RCLCPP_DEBUG(this->get_logger(),
               "Command sent: linear=%.3f, angular=%.3f -> left=%d RPM (ref %d), right=%d RPM "
               "(ref %d), mode=%s, lqr=%s",
               out.linear, out.angular, out.left_rpm, out.left_ref_rpm, out.right_rpm,
               out.right_ref_rpm, motor_control_lib::drive_mode_fsm::toString(out.mode),
               out.lqr_active ? "on" : "off");

  // tick 所要時間の監視。シリアル応答待ち（最悪 serial_response_timeout_ms × 2）が
  // 周期予算を超えると制御周期が崩れるため、超過を可視化する
  // （実機での control_rate 選定の材料）。
  const double tick_ms =
      std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - tick_start)
          .count();
  if (tick_ms > dt * 1000.0) {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                         "Control tick overrun: %.1f ms > budget %.1f ms (control_rate=%.1f)",
                         tick_ms, dt * 1000.0, control_rate_);
  }
}

void DriveComponent::reportCurrentGuardTrips() {
  using motor_control_lib::ddt_current_pi::GuardTrip;
  if (!motor_lib_) {
    return;
  }
  const struct {
    const char* wheel;
    int motor_id;
    GuardTrip* reported;
  } wheels[] = {{"left", left_motor_id_, &reported_guard_trip_left_},
                {"right", right_motor_id_, &reported_guard_trip_right_}};
  for (const auto& w : wheels) {
    const GuardTrip trip = motor_lib_->currentGuardTrip(w.motor_id);
    if (trip != *w.reported && trip != GuardTrip::kNone) {
      // 書式は監視ツール（scripts/current_mode_sim）が読む: "Current guard tripped: <wheel> ..."
      RCLCPP_ERROR(this->get_logger(),
                   "Current guard tripped: %s wheel (motor %d), reason %s. The wheel gets 0 A "
                   "until the node is reconfigured or a current-mode parameter is changed",
                   w.wheel, w.motor_id, motor_control_lib::ddt_current_pi::guardTripName(trip));
    }
    *w.reported = trip;
  }
}

void DriveComponent::onEmergencyStop(const questix_msgs::msg::EmergencyStop& msg,
                                     const questix_safety::EmergencyStopMonitor::Change& change) {
  // 未受信の間は押下扱い（was_active=true）。受信状態そのものは estop_monitor_ が持つ。
  const bool was_active = change.was_active;

  const bool motor_ready = motor_initialized_ && diff_drive_ != nullptr;
  bool stopped_now = false;
  switch (drive_watchdog::decideEstopAction(was_active, msg.active, motor_ready)) {
    case drive_watchdog::EstopAction::kStopNow:
      RCLCPP_WARN(this->get_logger(), "非常停止を受信 (source=%s, reason=%s)。モータを停止します",
                  msg.source.c_str(), msg.reason.c_str());
      // スロットル無しの即時停止 + 目標破棄。物理非常停止でモータ電源が落ちている場合は
      // シリアル書込みが失敗し得る。その場合は stop fault として閉じたまま再送する
      // （teardown へはエスカレートしない。デバイス消失は既存の configure リトライ経路）。
      safetyStop("emergency stop");
      stopped_now = true;
      break;
    case drive_watchdog::EstopAction::kClear:
      RCLCPP_INFO(this->get_logger(),
                  "非常停止が解除されました (source=%s)。twist 受付を再開します"
                  "（モータは中立を受けるまで停止のまま）",
                  msg.source.c_str());
      break;
    case drive_watchdog::EstopAction::kNone:
      if (msg.active && !was_active) {
        RCLCPP_WARN(this->get_logger(),
                    "非常停止を受信 (source=%s, reason=%s)。モータ未初期化のため指令なし",
                    msg.source.c_str(), msg.reason.c_str());
      }
      break;
  }
  // 途絶からの復帰・未受信からの初回受信を含め、ゲートの状態を更新する（開いても動かない）。
  applyGate(stopped_now);
}

void DriveComponent::onMotionPermission(const questix_msgs::msg::MotionPermission& msg,
                                        const questix_safety::PermissionMonitor::Change& change) {
  if (change.first || change.was_allowed != msg.drive_allowed) {
    RCLCPP_INFO(this->get_logger(), "Motion permission (%s): drive %s", msg.mode.c_str(),
                msg.drive_allowed ? "allowed" : "not allowed");
  }
  // OFF への変化は制御 tick を待たずに停止する（ON への変化は何も動かさない）。
  applyGate();
}

actuation_gate::EstopInputs DriveComponent::estopInputs() const { return estop_monitor_->inputs(); }

actuation_gate::PermissionInputs DriveComponent::permissionInputs() const {
  return permission_monitor_->inputs();
}

actuation_gate::Inputs DriveComponent::gateInputs() const {
  actuation_gate::Inputs in;
  in.permission = permissionInputs();
  in.estop = estopInputs();
  in.stop_fault = stop_fault_;
  return in;
}

bool DriveComponent::estopEngaged() const {
  // Only the E-stop: the motion permission is a permission and never reads as an E-stop.
  return estop_monitor_->engaged();
}

actuation_gate::Block DriveComponent::applyGate(bool stopped_now) {
  const auto block = actuation_gate::evaluate(gateInputs());
  observeTwistLogBlock(block);
  const auto action = actuation_gate::decideGateAction(last_block_, block, has_target_);
  if (block != last_block_) {
    if (block == actuation_gate::Block::kNone) {
      RCLCPP_INFO(this->get_logger(),
                  "Actuation allowed again (was %s); the drive needs neutral before moving",
                  actuation_gate::blockName(last_block_));
    } else {
      RCLCPP_WARN(this->get_logger(), "Actuation blocked: %s (was %s)",
                  actuation_gate::blockName(block), actuation_gate::blockName(last_block_));
    }
  }
  last_block_ = block;
  if (action == actuation_gate::GateAction::kSafetyStop && !stopped_now) {
    safetyStop(actuation_gate::blockName(block));
  }
  return block;
}

bool DriveComponent::safetyStop(const char* reason) {
  // 目標は送信の成否によらず必ず破棄する（古い目標を後で復活させない）。
  resetCommandState();
  if (!motor_initialized_ || !diff_drive_) {
    return false;  // 送る相手がない（未通電・未構成）。駆動指令も出ていない
  }
  last_stop_attempt_ = std::chrono::steady_clock::now();
  const bool zero_sent = diff_drive_->stopNow();
  if (in_control_tick_) {
    tick_sample_.stop_frame = true;
    tick_sample_.command_sent = zero_sent;
  }
  if (zero_sent) {
    return true;
  }
  if (!stop_fault_) {
    RCLCPP_ERROR(this->get_logger(),
                 "Stop fault (%s): the zero command could not be sent to both wheels. Actuation "
                 "stays closed and the zero is retried every %.1fs",
                 reason, kStopRetryPeriodSec);
  }
  stop_fault_ = true;
  return false;
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
    // 非常停止として扱っている間（押下・未受信・途絶）は true。走行許可の有無とは別。
    typed_msg.emergency_stop = estopEngaged();
    typed_status_publisher_->publish(typed_msg);

    // 左右両輪のフィードバックが新鮮なときのみ実測 twist を積分する。stale（非常停止・
    // 未通電を含む）なら twist ゼロ扱いで積分せず、現在ポーズで publish を継続する。
    const bool feedback_fresh =
        odometry::isFeedbackFresh(left_fb.has_feedback, left_fb.feedback_age_sec,
                                  odometry::kMaxFeedbackAgeSec) &&
        odometry::isFeedbackFresh(right_fb.has_feedback, right_fb.feedback_age_sec,
                                  odometry::kMaxFeedbackAgeSec);
    // ポーズは制御 tick の integrateOdometry が積分済み。twist はローパス後を publish する。
    publishOdometry(status.current_linear_velocity, status.current_angular_velocity, feedback_fresh,
                    now);

    RCLCPP_DEBUG(this->get_logger(), "Current velocity: linear=%.3f, angular=%.3f",
                 status.current_linear_velocity, status.current_angular_velocity);

  } catch (const std::exception& e) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                          "Exception in status timer callback: %s", e.what());
  }
}

void DriveComponent::publishOdometry(double twist_linear, double twist_angular, bool feedback_fresh,
                                     const rclcpp::Time& now) {
  if (!odom_publisher_) {
    return;
  }

  // publish に載せる twist は stale 時ゼロ（ポーズと整合させ、下流の誤積分を防ぐ）。
  const double reported_linear = feedback_fresh ? twist_linear : 0.0;
  const double reported_angular = feedback_fresh ? twist_angular : 0.0;
  // Hold the pose at the last paired position endpoints. Extrapolating with
  // integer RPM would reintroduce its directional bias and a reset-time jump.
  // The published twist intentionally keeps the existing LPF velocity contract.
  const odometry::Pose2D pose = odom_pose_;
  const odometry::YawQuaternion q = odometry::yawToQuaternion(pose.theta);

  nav_msgs::msg::Odometry odom;
  odom.header.stamp = now;
  odom.header.frame_id = odom_frame_id_;
  odom.child_frame_id = base_frame_id_;
  odom.pose.pose.position.x = pose.x;
  odom.pose.pose.position.y = pose.y;
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
    tf.transform.translation.x = pose.x;
    tf.transform.translation.y = pose.y;
    tf.transform.translation.z = 0.0;
    tf.transform.rotation.x = 0.0;
    tf.transform.rotation.y = 0.0;
    tf.transform.rotation.z = q.z;
    tf.transform.rotation.w = q.w;
    tf_broadcaster_->sendTransform(tf);
  }
}

}  // namespace motor_control_app
