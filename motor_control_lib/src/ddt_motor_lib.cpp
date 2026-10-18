// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "motor_control_lib/ddt_motor_lib.hpp"

#include <sys/select.h>

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstring>
#include <thread>

#include "motor_control_lib/ddt_protocol.hpp"
#include "serial_utils/serial_port.hpp"

using namespace std::chrono_literals;

namespace motor_control_lib {

DdtMotorLib::DdtMotorLib(const std::string& serial_port, int baud_rate)
    : BaseMotorController("DDTMotor"),
      serial_port_(serial_port),
      baud_rate_(baud_rate),
      max_motor_rpm_(330),
      // current モードの既定は launcher/config/drive_component.yaml
      // と同じ（浮かせた車輪で安定する値）。
      current_kp_(0.0015),
      current_ki_(0.004),
      max_current_amp_(1.0),
      integral_limit_amp_(0.3),
      current_zero_deadband_rpm_(5),
      current_invert_measured_(false),
      current_ff_static_amp_(0.0),
      current_ff_viscous_amp_per_rpm_(0.0),
      current_guard_params_{},
      current_max_accel_rpm_per_sec_(0.0),
      current_measured_source_(CurrentMeasuredSource::Position),
      brake_on_stop_(true),
      accel_time_0p1ms_per_rpm_(50),
      command_wait_ms_(0),
      response_timeout_ms_(kDefaultResponseTimeoutMs),
      measured_lpf_tau_sec_(0.0),
      stop_resend_interval_ms_(200),
      serial_fd_(-1) {
  logger_ = rclcpp::get_logger("DdtMotorLib");
}

DdtMotorLib::~DdtMotorLib() { shutdown(); }

bool DdtMotorLib::initialize() {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  if (initialized_) {
    return true;
  }

  if (!initializeSerial()) {
    RCLCPP_ERROR(logger_, "シリアル通信の初期化に失敗しました");
    return false;
  }

  std::this_thread::sleep_for(200ms);
  initialized_ = true;

  RCLCPP_INFO(logger_, "DDTモータライブラリが初期化されました");
  return true;
}

void DdtMotorLib::shutdown() {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  if (initialized_) {
    emergencyStop();
    closeSerial();
    motor_velocities_.clear();
    motor_feedbacks_.clear();
    motor_modes_.clear();
    pi_states_.clear();
    current_previous_nonzero_target_.clear();
    current_guard_trips_.clear();
    current_link_latched_ = false;
    current_link_recovery_.clear();
    speed_estimators_.clear();
    last_sent_frames_.clear();
    transaction_stats_.clear();
    initialized_ = false;
    RCLCPP_INFO(logger_, "DDTモータライブラリが終了されました");
  }
}

bool DdtMotorLib::isHealthy() const {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  if (!initialized_) {
    return false;
  }

  // 全てのモーターの故障コードをチェック
  for (const auto& [motor_id, feedback] : motor_feedbacks_) {
    if (feedback.fault_code != 0) {
      return false;
    }
  }
  // current モードの暴走ガード・応答の途切れのラッチが立っていれば異常（ホスト側の判定。故障
  // コードは偽装しない）
  return current_guard_trips_.empty() && !current_link_latched_;
}

void DdtMotorLib::resetCurrentPiStateForStop(int motor_id) {
  current_previous_nonzero_target_[motor_id] = false;
  auto& pi_state = pi_states_[motor_id];
  pi_state.pi.integral_amp = 0.0;
  pi_state.has_last_t = false;
  pi_state.ref_rpm_filtered = 0.0;
  pi_state.last_ref_t = {};
  pi_state.has_last_ref_t = false;
  pi_state.guard = {};
}

void DdtMotorLib::clearCurrentGuardTrips(const char* why) {
  if (current_guard_trips_.empty()) {
    return;
  }
  for (const auto& [motor_id, trip] : current_guard_trips_) {
    RCLCPP_WARN(logger_, "モーター %d の電流モード暴走ガード（%s）を解除しました: %s", motor_id,
                ddt_current_pi::guardTripName(trip), why);
  }
  current_guard_trips_.clear();
}

bool DdtMotorLib::currentLinkLatched() const {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  return current_link_latched_;
}

bool DdtMotorLib::isCurrentModeMotor(int motor_id) const {
  auto it = motor_modes_.find(motor_id);
  return it != motor_modes_.end() && it->second == ControlMode::Current;
}

double DdtMotorLib::currentFeedbackAgeSec(const MotorFeedback& fb) const {
  return std::chrono::duration<double>(controlNow() - fb.last_feedback_control_time).count();
}

void DdtMotorLib::latchCurrentLink(int motor_id, const char* why) {
  for (auto& [id, count] : current_link_recovery_) {
    count = 0;
  }
  if (current_link_latched_) {
    return;  // WARN は状態の変化のときだけ
  }
  current_link_latched_ = true;
  for (const auto& [id, mode] : motor_modes_) {
    if (mode == ControlMode::Current) {
      resetCurrentPiStateForStop(id);
      current_link_recovery_[id] = 0;
    }
  }
  RCLCPP_WARN(logger_,
              "モーター %d: %s。応答の途切れのラッチを立て、すべての current モードのモータに電流 "
              "0 を送ります（解除: 停止の指令だけの間に、すべてのモータから有効な応答が %d 回"
              "続けて届いたとき）",
              motor_id, why, kCurrentLinkRecoveryResponses);
}

bool DdtMotorLib::stopOtherCurrentMotors(int motor_id) {
  bool sent = true;
  for (const auto& [id, mode] : motor_modes_) {
    if (id != motor_id && mode == ControlMode::Current) {
      resetCurrentPiStateForStop(id);
      sent = sendMotorCurrentRaw(id, 0) && sent;
    }
  }
  return sent;
}

bool DdtMotorLib::latchCurrentLinkAndStop(int motor_id, const char* why) {
  latchCurrentLink(motor_id, why);
  resetCurrentPiStateForStop(motor_id);
  const bool sent = sendMotorCurrentRaw(motor_id, 0);
  const bool others_sent = stopOtherCurrentMotors(motor_id);
  return sent && others_sent;
}

void DdtMotorLib::noteCurrentLinkResponse(int motor_id, bool valid) {
  int& count = current_link_recovery_[motor_id];
  count = valid ? count + 1 : 0;
  for (const auto& [id, mode] : motor_modes_) {
    if (mode != ControlMode::Current) {
      continue;
    }
    auto it = current_link_recovery_.find(id);
    if (it == current_link_recovery_.end() || it->second < kCurrentLinkRecoveryResponses) {
      return;
    }
  }
  current_link_latched_ = false;
  current_link_recovery_.clear();
  RCLCPP_INFO(logger_,
              "応答の途切れのラッチを解除しました（停止の指令だけの間に、すべての current モードの"
              "モータから有効な応答が %d 回続けて届いた）",
              kCurrentLinkRecoveryResponses);
}

ddt_current_pi::GuardTrip DdtMotorLib::currentGuardTrip(int motor_id) const {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  auto it = current_guard_trips_.find(motor_id);
  return it == current_guard_trips_.end() ? ddt_current_pi::GuardTrip::kNone : it->second;
}

void DdtMotorLib::emergencyStop() {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  for (const auto& [motor_id, velocity] : motor_velocities_) {
    auto mode_it = motor_modes_.find(motor_id);
    if (mode_it != motor_modes_.end() && mode_it->second == ControlMode::Current) {
      resetCurrentPiStateForStop(motor_id);
      // 電流モード: raw=0 を直接送信して即座にトルク解除
      sendMotorCurrentRaw(motor_id, 0);
    } else {
      // 速度モード: 目標0 + 電気ブレーキでしっかり停止
      sendMotorVelocity(motor_id, 0, brake_on_stop_);
    }
    std::this_thread::sleep_for(10ms);
  }
  RCLCPP_WARN(logger_, "緊急停止が実行されました");
}

bool DdtMotorLib::setMotorVelocity(int motor_id, int velocity_rpm) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  if (!initialized_) {
    RCLCPP_ERROR(logger_, "モータが初期化されていません");
    return false;
  }

  // 未登録モータはファーム側モードが不明なまま指令すると誤解釈され得るため、
  // Velocity モードを明示的に設定してから送信する。
  auto mode_it = motor_modes_.find(motor_id);
  if (mode_it == motor_modes_.end()) {
    RCLCPP_WARN(logger_, "モーター %d は未初期化のため Velocity モードで初期化します", motor_id);
    if (!initializeMotor(motor_id, ControlMode::Velocity)) {
      return false;
    }
    mode_it = motor_modes_.find(motor_id);
  }
  ControlMode mode = mode_it->second;

  // 目標 RPM は常に max_motor_rpm_ でクランプ
  int rpm_ref_raw = std::clamp(velocity_rpm, -max_motor_rpm_, max_motor_rpm_);
  motor_velocities_[motor_id] = rpm_ref_raw;

  if (mode == ControlMode::Current) {
    return commandCurrentMode(motor_id, rpm_ref_raw);
  }

  return sendMotorVelocity(motor_id, rpm_ref_raw);
}

bool DdtMotorLib::commandCurrentMode(int motor_id, int rpm_ref_raw) {
  // 応答の途切れのラッチの間は電流 0 だけを送る。0 でない目標を受けたら、解除の数えを 0 に戻す
  // （停止の指令だけの間に、すべてのモータから有効な応答がそろったときだけ解除する）。
  // その送受信の応答も数えない。送る前に数え直し、countResponse での解除を抑える。
  if (current_link_latched_) {
    resetCurrentPiStateForStop(motor_id);
    if (rpm_ref_raw != 0) {
      for (auto& [id, count] : current_link_recovery_) {
        count = 0;
      }
    }
    suppress_current_link_recovery_ = rpm_ref_raw != 0;
    const bool sent = sendMotorCurrentRaw(motor_id, 0);
    suppress_current_link_recovery_ = false;
    return sent;
  }

  // 暴走ガードがラッチしている間は電流 0 だけを送る（解除は再初期化かパラメータ変更）。
  if (current_guard_trips_.count(motor_id) != 0) {
    resetCurrentPiStateForStop(motor_id);
    return sendMotorCurrentRaw(motor_id, 0);
  }

  // 応答の新しさの門（P0-2・P0-3 の軽減）: 0 でない電流は、そのモータの新しい応答（経過時間
  // kCurrentFeedbackMaxAgeSec 以下、mode=1）があるときだけ送る。古い実測で電流を出すと、浮かせた
  // 車輪は回転が上がり続け、モータだけが再起動して速度ループに戻っていれば電流の raw 値が速度目標
  // として読まれる。
  // 確認と送信は一度に行えないので、確認の直後（送信までの間）にモータだけが再起動する競合は、
  // ソフトだけでは無くせない。再起動後の最初の指令に有効な mode 不一致の応答が返る試験では、
  // 速度目標として読まれる電流指令は 1 回だった。応答喪失を伴う再起動・ホストの停滞・通信断で
  // この上限は保証しない。P0-3 は軽減策で、B4 とあわせた残りのリスク（Issue #222）。
  auto fb_it = motor_feedbacks_.find(motor_id);
  if (fb_it == motor_feedbacks_.end() || !fb_it->second.has_feedback) {
    resetCurrentPiStateForStop(motor_id);
    if (rpm_ref_raw != 0) {
      return latchCurrentLinkAndStop(motor_id, "応答が一度も無いのに 0 でない目標が来た");
    }
    return sendMotorCurrentRaw(motor_id, 0);
  }
  if (fb_it->second.consecutive_timeouts >= kCurrentMaxConsecutiveTimeouts) {
    // countResponse がラッチを立てているはずだが、念のためここでも止める。
    return latchCurrentLinkAndStop(motor_id, "有効な応答が続けて無い");
  }
  const bool previous_nonzero_target = current_previous_nonzero_target_[motor_id];
  current_previous_nonzero_target_[motor_id] = rpm_ref_raw != 0;
  const double feedback_age_sec = currentFeedbackAgeSec(fb_it->second);
  if (feedback_age_sec > kCurrentFeedbackMaxAgeSec) {
    if (rpm_ref_raw != 0 &&
        (transaction_stats_[motor_id].last_current_raw_sent != 0 || previous_nonzero_target)) {
      // 電流を出している最中に応答が古くなった: 途切れとみなして止める。
      return latchCurrentLinkAndStop(motor_id, "電流を出している間に最新の応答が古くなった");
    }
    resetCurrentPiStateForStop(motor_id);
    // 電流 0 で止まっている間の古さ（待機中の応答の取り直しは stop_resend_interval_ms ごと）は
    // 途切れではない。この周期は電流 0 を送って新しい応答を取り直し、次の周期から PI を回す
    // （0 で準備し直す → 新しい mode=1 を確かめる）。
    RCLCPP_DEBUG(logger_, "モーター %d: 最新の応答が %.3f s 前のため、電流 0 で応答を取り直します",
                 motor_id, feedback_age_sec);
    return sendMotorCurrentRaw(motor_id, 0);
  }

  // モータが電流ループを報告していなければ電流を出さない（電流指令が速度目標として解釈される）。
  // 暴走ガード（kModeMismatch、このモータ）と応答の途切れのラッチ（すべてのモータ）の両方を立てる。
  if (fb_it->second.mode != 0x01) {
    latchCurrentLink(motor_id, "モータが電流ループを報告していない");
    const bool sent =
        tripCurrentGuard(motor_id, ddt_current_pi::GuardTrip::kModeMismatch, rpm_ref_raw,
                         fb_it->second.speed, fb_it->second.speed, 0.0, 0.0);
    const bool others_sent = stopOtherCurrentMotors(motor_id);
    return sent && others_sent;
  }

  // PI と暴走ガードの帰還（current_measured_source。モーターの向き・符号反転前）。角度から求めた
  // 速さが無効なら電流を出さない（0 rpm で代用しない）。電流を出している最中なら途切れとみなして
  // ラッチし、電流 0 で止まっている間（起動・待機の後）なら、電流 0 を送って応答を集める
  // （有効な区間が 2 つそろうまで。走り出しが 2 周期ほど遅れる）。
  double measured_rpm = 0.0;
  wheel_speed_estimator::Estimate estimate;
  if (!currentMeasuredRpm(motor_id, &measured_rpm, &estimate)) {
    if (rpm_ref_raw != 0 &&
        (transaction_stats_[motor_id].last_current_raw_sent != 0 || previous_nonzero_target)) {
      RCLCPP_WARN(logger_, "モーター %d: 角度から求めた速さが無効（%s、最新の応答 %.3f s 前）",
                  motor_id, wheel_speed_estimator::invalidName(estimate.reason), estimate.age_sec);
      return latchCurrentLinkAndStop(motor_id, "電流を出している間に角度から求めた速さが無効");
    }
    resetCurrentPiStateForStop(motor_id);
    RCLCPP_DEBUG(logger_, "モーター %d: 角度から求めた速さが無効（%s）のため電流 0 を送ります",
                 motor_id, wheel_speed_estimator::invalidName(estimate.reason));
    return sendMotorCurrentRaw(motor_id, 0);
  }

  // スルーレート制限（加速度制限）: 目標 RPM を 1ステップあたり max_accel * dt だけ変化させる。
  // drive_component は使わない（既定 0 = 無効。加速度はホストの ControlCore が制限する）。
  int rpm_ref = rpm_ref_raw;
  if (current_max_accel_rpm_per_sec_ > 0.0) {
    auto& st = pi_states_[motor_id];
    auto now = controlNow();
    double dt = 0.01;
    if (st.has_last_ref_t) {
      dt = std::chrono::duration<double>(now - st.last_ref_t).count();
      if (dt <= 0.0 || dt > 0.2) {
        dt = 0.01;
      }
    } else {
      double initial_ref_rpm = measured_rpm;
      if (current_invert_measured_) {
        initial_ref_rpm = -initial_ref_rpm;
      }
      initial_ref_rpm = std::clamp(initial_ref_rpm, static_cast<double>(-max_motor_rpm_),
                                   static_cast<double>(max_motor_rpm_));
      st.ref_rpm_filtered = initial_ref_rpm;
    }
    st.last_ref_t = now;
    st.has_last_ref_t = true;

    double max_step = current_max_accel_rpm_per_sec_ * dt;
    double delta = static_cast<double>(rpm_ref_raw) - st.ref_rpm_filtered;
    if (delta > max_step) delta = max_step;
    if (delta < -max_step) delta = -max_step;
    st.ref_rpm_filtered += delta;
    rpm_ref = static_cast<int>(std::lround(st.ref_rpm_filtered));
  }

  // 静止デッドバンド: ref=0 かつ実測がノイズ帯内なら、PI を走らず raw=0 を送る。
  // これがないと measured の量子化ノイズを積分が拾い、静止時にトルクが出て微振動する。
  if (ddt_current_pi::inZeroDeadband(rpm_ref, static_cast<int>(std::lround(measured_rpm)),
                                     current_zero_deadband_rpm_)) {
    auto& st = pi_states_[motor_id];
    st.pi.integral_amp = 0.0;
    st.has_last_t = false;
    st.guard = {};
    return sendMotorCurrentRaw(motor_id, 0);
  }

  // ガード用: 送信前の実測（PI の向き）と、その実測から今までに流れていた電流（前回の指令）。
  const double measured_prev = current_invert_measured_ ? -measured_rpm : measured_rpm;
  auto& tx_before = transaction_stats_[motor_id];
  const double applied_amp = ddt_current_pi::rawToAmp(tx_before.last_current_raw_sent);
  const uint64_t feedback_count_before = tx_before.feedback_count;

  double i_cmd_amp = 0.0;
  const int16_t current_raw = runCurrentLoopStep(motor_id, rpm_ref, measured_rpm, &i_cmd_amp);
  if (!sendMotorCurrentRaw(motor_id, current_raw)) {
    // Even a failed 0 A PI command may leave the previous nonzero current applied.
    latchCurrentLinkAndStop(motor_id, "PI 電流指令の送信に失敗した");
    return false;
  }
  // この送受信で応答の途切れのラッチが立った（countResponse）: 送ったばかりの電流を 0 で上書きし、
  // ほかのモータも止める。
  if (current_link_latched_) {
    resetCurrentPiStateForStop(motor_id);
    const bool sent = sendMotorCurrentRaw(motor_id, 0);
    const bool others_sent = stopOtherCurrentMotors(motor_id);
    return sent && others_sent;
  }
  // 新しい応答が無ければガードは評価しない（同じ実測を二度使わない）。
  if (transaction_stats_[motor_id].feedback_count == feedback_count_before) {
    return true;
  }
  const auto& fb_new = motor_feedbacks_[motor_id];
  double measured_new_raw = static_cast<double>(fb_new.speed);
  const bool measured_new_valid = currentMeasuredRpm(motor_id, &measured_new_raw, &estimate);
  const double measured_new = current_invert_measured_ ? -measured_new_raw : measured_new_raw;
  if (fb_new.mode != 0x01) {
    latchCurrentLink(motor_id, "モータが電流ループを報告していない");
    const bool sent = tripCurrentGuard(motor_id, ddt_current_pi::GuardTrip::kModeMismatch, rpm_ref,
                                       measured_prev, measured_new, applied_amp, i_cmd_amp);
    const bool others_sent = stopOtherCurrentMotors(motor_id);
    return sent && others_sent;
  }
  if (!measured_new_valid) {
    // 送った後の応答で角度から求めた速さが無効（区間の間隔・fault 等）: ガードは評価できない。
    // 0 でない電流を送ったばかりなら、途切れとみなして止める。
    if (current_raw != 0) {
      RCLCPP_WARN(logger_, "モーター %d: 角度から求めた速さが無効（%s、最新の応答 %.3f s 前）",
                  motor_id, wheel_speed_estimator::invalidName(estimate.reason), estimate.age_sec);
      return latchCurrentLinkAndStop(motor_id, "電流を送った後の角度から求めた速さが無効");
    }
    return true;
  }
  const ddt_current_pi::GuardSample sample{
      std::chrono::duration<double>(controlNow().time_since_epoch()).count(),
      rpm_ref,
      measured_prev,
      measured_new,
      applied_amp,
      i_cmd_amp,
      max_current_amp_};
  const auto trip =
      ddt_current_pi::updateGuard(pi_states_[motor_id].guard, current_guard_params_, sample);
  if (trip == ddt_current_pi::GuardTrip::kNone) {
    return true;
  }
  return tripCurrentGuard(motor_id, trip, rpm_ref, measured_prev, measured_new, applied_amp,
                          i_cmd_amp);
}

bool DdtMotorLib::tripCurrentGuard(int motor_id, ddt_current_pi::GuardTrip trip, int rpm_ref,
                                   double measured_prev, double measured_new, double applied_amp,
                                   double i_cmd_amp) {
  current_guard_trips_[motor_id] = trip;
  const char* hint = "";
  switch (trip) {
    case ddt_current_pi::GuardTrip::kAccelAgainstCurrent:
      hint =
          "回転を止める向きの電流なのに速くなり続けた。current_invert_measured の符号が逆"
          "（正帰還）の可能性が高い";
      break;
    case ddt_current_pi::GuardTrip::kOverspeed:
      hint = "目標より速いまま減速しない。摩擦補償の過補償・外力・符号を確認";
      break;
    case ddt_current_pi::GuardTrip::kOscillation:
      hint =
          "電流が上限で正負に振れている。負荷に対してゲインが高すぎる（浮かせた車輪に床用の"
          "ゲイン、走行中に持ち上げた等）";
      break;
    case ddt_current_pi::GuardTrip::kModeMismatch:
      hint =
          "モータが電流ループを報告していない。電流指令が速度目標として解釈されるため止めた"
          "（モータの電源の入れ直し等でモードが戻った可能性）";
      break;
    case ddt_current_pi::GuardTrip::kNone:
      break;
  }
  RCLCPP_ERROR(logger_,
               "モーター %d: 電流モード暴走ガード作動（%s）: ref=%d meas %.1f->%.1f applied=%.3fA "
               "cmd=%.3fA。電流 0 でラッチします（解除は再初期化か current モードのパラメータ"
               "変更）。%s",
               motor_id, ddt_current_pi::guardTripName(trip), rpm_ref, measured_prev, measured_new,
               applied_amp, i_cmd_amp, hint);
  resetCurrentPiStateForStop(motor_id);
  return sendMotorCurrentRaw(motor_id, 0);
}

bool DdtMotorLib::getMotorStatus(int motor_id, int& velocity_rpm, uint8_t& temperature,
                                 uint8_t& fault_code) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  if (!initialized_) {
    RCLCPP_ERROR(logger_, "モータが初期化されていません");
    return false;
  }

  auto vel_it = motor_velocities_.find(motor_id);
  auto feedback_it = motor_feedbacks_.find(motor_id);

  if (vel_it == motor_velocities_.end()) {
    RCLCPP_ERROR(logger_, "モーターID %d が見つかりません", motor_id);
    return false;
  }

  // 有効フィードバックがあれば実測 RPM を返す（velocity/current 両モード）。
  // velocity モードでも sendMotorVelocity が毎コマンド応答を取り込むため実測が使える。
  // フィードバック未受信のときのみ目標値にフォールバックする（既存互換）。
  bool prefer_measured =
      (feedback_it != motor_feedbacks_.end() && feedback_it->second.has_feedback);

  // レポート／オドメトリ経路ではローパス済みの実測 RPM を返す（tau<=0 で生値）。
  velocity_rpm = prefer_measured ? measuredRpmForReport(feedback_it->second) : vel_it->second;

  if (feedback_it != motor_feedbacks_.end()) {
    temperature = feedback_it->second.temperature;
    fault_code = feedback_it->second.fault_code;
  } else {
    temperature = 0;
    fault_code = 0;
  }

  return true;
}

bool DdtMotorLib::initializeMotor(int motor_id) {
  return initializeMotor(motor_id, ControlMode::Velocity);
}

bool DdtMotorLib::initializeMotor(int motor_id, ControlMode mode) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  if (!setControlMode(motor_id, mode)) {
    RCLCPP_ERROR(logger_, "モーター %d の初期化（モード設定）に失敗しました", motor_id);
    return false;
  }

  motor_modes_[motor_id] = mode;
  motor_velocities_[motor_id] = 0;
  motor_feedbacks_[motor_id] = MotorFeedback{};
  speed_estimators_[motor_id].reset();
  pi_states_[motor_id] = PiState{};
  current_previous_nonzero_target_[motor_id] = false;
  if (current_guard_trips_.erase(motor_id) != 0) {
    RCLCPP_WARN(logger_, "モーター %d の電流モード暴走ガードを解除しました: 再初期化", motor_id);
  }

  // フィードバックをプライミング: ゼロ指令を 1 回通常経路で送り、last_sent_frames_ を
  // 埋めつつ初回フィードバックを取得する（モータは動かない。電流 0 も速度 0 も停止）。
  // 応答のモード値で切り替わったかも確かめる。
  const uint8_t wanted = (mode == ControlMode::Current) ? 0x01 : 0x02;
  auto prime = [&]() {
    return (mode == ControlMode::Current) ? sendMotorCurrentRaw(motor_id, 0)
                                          : sendMotorVelocity(motor_id, 0, brake_on_stop_);
  };
  auto reported = [&]() -> int {
    const auto& fb = motor_feedbacks_[motor_id];
    return fb.has_feedback ? fb.mode : -1;
  };
  bool primed = prime();
  if (primed && reported() >= 0 && reported() != wanted) {
    RCLCPP_WARN(
        logger_,
        "モーター %d: 仕様書のモード切替フレームの後もモード %d を報告しています（期待 %d）。"
        "2026-10 までの独自レイアウトでも試します",
        motor_id, reported(), wanted);
    if (sendCommand(ddt_protocol::packModeFrameLegacy(static_cast<uint8_t>(motor_id), wanted))) {
      motor_feedbacks_[motor_id] = MotorFeedback{};
      primed = prime();
      if (reported() == wanted) {
        RCLCPP_WARN(
            logger_,
            "モーター %d: 独自レイアウトのモード切替フレームで切り替わりました（仕様書と違う"
            "ファームの可能性。記録してください）",
            motor_id);
      }
    }
  }
  if (!primed) {
    RCLCPP_WARN(logger_, "モーター %d のフィードバックプライミングに失敗しました（続行）",
                motor_id);
  }
  if (mode == ControlMode::Current && reported() != wanted) {
    // 電流ループを確認できないまま電流指令を送ると、raw 値（例 0.1 A = 410）が速度目標として
    // 解釈され、浮かせた車輪が回り出す。current モードは起動しない。
    RCLCPP_ERROR_THROTTLE(logger_, throttle_clock_, 10000,
                          "モーター %d が電流ループに切り替わったことを確認できません（報告モード"
                          "=%d、-1 は応答なし）。current モードでは起動しません",
                          motor_id, reported());
    motor_modes_.erase(motor_id);
    return false;
  }
  if (mode == ControlMode::Velocity && reported() >= 0 && reported() != wanted) {
    RCLCPP_WARN(logger_, "モーター %d が速度ループを報告しません（報告モード=%d）", motor_id,
                reported());
  }

  RCLCPP_INFO(logger_, "モーター %d が初期化されました (mode=%s)", motor_id,
              mode == ControlMode::Current ? "current" : "velocity");
  return true;
}

bool DdtMotorLib::stopMotor(int motor_id) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  auto mode_it = motor_modes_.find(motor_id);
  if (mode_it != motor_modes_.end() && mode_it->second == ControlMode::Current) {
    resetCurrentPiStateForStop(motor_id);
    motor_velocities_[motor_id] = 0;
    return sendMotorCurrentRaw(motor_id, 0);
  }
  // 速度モード: 目標0 + 電気ブレーキでしっかり停止・保持する。
  // 既に停止（目標RPM=0）と分かっている状態が続く間、高頻度（~20Hz）でブレーキ指令を
  // 再送し続けると、残留回転がある間は毎回新規の制動として作用し、収束せず持続的な振動
  // （リミットサイクル）を起こすことがある（cf. 停止直後の足回り振動の rosbag 解析）。
  // 停止状態が続いている間は、再送間隔未満の呼び出しは実際のシリアル送信をスキップする。
  // 「停止中」の判断は、要求目標（motor_velocities_）ではなく、最後に送信に成功したフレームが
  // 停止フレームかで行う: 停止指令の送信に失敗していたら、次の呼び出しで必ず送り直す。
  motor_velocities_[motor_id] = 0;
  const bool already_stopped = lastSentFrameIsZero(motor_id);
  if (already_stopped && stop_resend_interval_ms_ > 0) {
    auto now = std::chrono::steady_clock::now();
    auto last_it = last_stop_send_time_.find(motor_id);
    if (last_it != last_stop_send_time_.end()) {
      auto elapsed_ms =
          std::chrono::duration_cast<std::chrono::milliseconds>(now - last_it->second).count();
      if (elapsed_ms < stop_resend_interval_ms_) {
        return true;  // 直近で送信済み。ブレーキは保持されているとみなしスキップする。
      }
    }
  }

  bool success = sendMotorVelocity(motor_id, 0, brake_on_stop_);
  if (success) {
    last_stop_send_time_[motor_id] = std::chrono::steady_clock::now();
  }
  return success;
}

bool DdtMotorLib::stopMotorNow(int motor_id) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  if (!initialized_) {
    return false;
  }
  motor_velocities_[motor_id] = 0;
  auto mode_it = motor_modes_.find(motor_id);
  if (mode_it != motor_modes_.end() && mode_it->second == ControlMode::Current) {
    resetCurrentPiStateForStop(motor_id);
    return sendMotorCurrentRaw(motor_id, 0);
  }
  const bool success = sendMotorVelocity(motor_id, 0, brake_on_stop_);
  if (success) {
    last_stop_send_time_[motor_id] = std::chrono::steady_clock::now();
  }
  return success;
}

bool DdtMotorLib::lastSentFrameIsZero(int motor_id) const {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  auto frame_it = last_sent_frames_.find(motor_id);
  return frame_it != last_sent_frames_.end() && ddt_protocol::isZeroCommandFrame(frame_it->second);
}

bool DdtMotorLib::stopAllMotors() {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  bool success = true;
  for (const auto& [motor_id, velocity] : motor_velocities_) {
    success &= stopMotor(motor_id);
    std::this_thread::sleep_for(10ms);
  }
  return success;
}

int DdtMotorLib::getMaxRpm() const { return max_motor_rpm_; }

bool DdtMotorLib::setMaxRpm(int max_rpm) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  // M0602C の速度ループ指令範囲は ±475 rpm（仕様）。範囲外の指令はファーム挙動が未定義の
  // ため、上限として機能しない値を黙って受け付けず仕様上限にクランプする。
  if (max_rpm > kSpecVelocityMaxRpm) {
    RCLCPP_WARN(logger_, "max_rpm %d は M0602C 速度指令範囲 ±%d rpm を超えるためクランプします",
                max_rpm, kSpecVelocityMaxRpm);
    max_rpm = kSpecVelocityMaxRpm;
  }
  max_motor_rpm_ = max_rpm;
  return true;
}

std::vector<DdtMotorLib::MotorStatus> DdtMotorLib::getAllMotorStatus() const {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  std::vector<MotorStatus> statuses;

  for (const auto& [motor_id, velocity] : motor_velocities_) {
    MotorStatus status;
    status.motor_id = motor_id;
    status.velocity_rpm = velocity;

    auto feedback_it = motor_feedbacks_.find(motor_id);
    if (feedback_it != motor_feedbacks_.end()) {
      status.temperature = feedback_it->second.temperature;
      status.fault_code = feedback_it->second.fault_code;
      status.is_healthy = (feedback_it->second.fault_code == 0);
    } else {
      status.temperature = 0;
      status.fault_code = 0;
      status.is_healthy = true;
    }

    statuses.push_back(status);
  }

  return statuses;
}

bool DdtMotorLib::initializeSerial() {
  serial_utils::SerialConfig cfg{O_RDWR | O_NOCTTY | O_SYNC, baud_rate_, 0, 5};
  serial_fd_ = serial_utils::openSerial(serial_port_, cfg, logger_);
  if (serial_fd_ < 0) {
    RCLCPP_ERROR(logger_, "シリアルポートの初期化に失敗しました: %s", serial_port_.c_str());
    return false;
  }

  RCLCPP_INFO(logger_, "シリアルポートが開きました: %s", serial_port_.c_str());
  return true;
}

void DdtMotorLib::closeSerial() {
  if (serial_fd_ >= 0) {
    close(serial_fd_);
    serial_fd_ = -1;
  }
}

bool DdtMotorLib::setModeVelocity(int motor_id) {
  return setControlMode(motor_id, ControlMode::Velocity);
}

bool DdtMotorLib::setControlMode(int motor_id, ControlMode mode) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  // フレーム組み立ては ddt_protocol::packModeFrame に集約（バイト列レイアウトは同関数を参照）。
  uint8_t mode_value = 0x02;  // 速度ループ
  if (mode == ControlMode::Current) {
    mode_value = 0x01;  // 電流ループ
  }

  std::vector<uint8_t> data_fields =
      ddt_protocol::packModeFrame(static_cast<uint8_t>(motor_id), mode_value);

  bool success = sendCommand(data_fields);
  if (success) {
    RCLCPP_INFO(logger_, "モーター %d を %s モードに設定しました", motor_id,
                mode == ControlMode::Current ? "電流制御" : "速度制御");
  } else {
    RCLCPP_ERROR(logger_, "モーター %d のモード設定に失敗しました", motor_id);
  }
  return success;
}

void DdtMotorLib::setCurrentControlParams(double kp, double ki, double max_current_amp,
                                          double integral_limit_amp) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  current_kp_ = kp;
  current_ki_ = ki;
  max_current_amp_ = std::max(0.0, max_current_amp);
  integral_limit_amp_ = std::max(0.0, integral_limit_amp);
  RCLCPP_INFO(logger_,
              "電流制御パラメータ更新: Kp=%.4f, Ki=%.4f, max_current=%.2fA, integral_limit=%.2fA",
              current_kp_, current_ki_, max_current_amp_, integral_limit_amp_);
  clearCurrentGuardTrips("PI パラメータの変更");
}

void DdtMotorLib::setCurrentFeedforward(double static_amp, double viscous_amp_per_rpm) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  current_ff_static_amp_ = std::isfinite(static_amp) ? std::max(0.0, static_amp) : 0.0;
  current_ff_viscous_amp_per_rpm_ =
      std::isfinite(viscous_amp_per_rpm) ? std::max(0.0, viscous_amp_per_rpm) : 0.0;
  RCLCPP_INFO(logger_, "電流モード 摩擦補償: static=%.3fA viscous=%.5fA/rpm",
              current_ff_static_amp_, current_ff_viscous_amp_per_rpm_);
  clearCurrentGuardTrips("摩擦補償の変更");
}

void DdtMotorLib::setCurrentGuardParams(double overspeed_margin_rpm, double overspeed_time_sec) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  const ddt_current_pi::GuardParams defaults{};
  current_guard_params_.overspeed_margin_rpm =
      (std::isfinite(overspeed_margin_rpm) && overspeed_margin_rpm > 0.0)
          ? overspeed_margin_rpm
          : defaults.overspeed_margin_rpm;
  current_guard_params_.overspeed_time_sec =
      (std::isfinite(overspeed_time_sec) && overspeed_time_sec > 0.0) ? overspeed_time_sec
                                                                      : defaults.overspeed_time_sec;
  RCLCPP_INFO(logger_, "電流モード 暴走ガード: 目標超過 %.0f rpm が %.2f s 続いたら作動",
              current_guard_params_.overspeed_margin_rpm, current_guard_params_.overspeed_time_sec);
  clearCurrentGuardTrips("ガード設定の変更");
}

void DdtMotorLib::setCurrentMeasuredSource(CurrentMeasuredSource source) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  current_measured_source_ = source;
  RCLCPP_INFO(logger_, "電流モード PI の帰還: %s",
              source == CurrentMeasuredSource::Position ? "position（角度から求めた速さ）"
                                                        : "reported（報告回転数）");
  clearCurrentGuardTrips("帰還の変更");
}

CurrentMeasuredSource DdtMotorLib::getCurrentMeasuredSource() const {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  return current_measured_source_;
}

double DdtMotorLib::controlNowSec() const {
  return std::chrono::duration<double>(controlNow().time_since_epoch()).count();
}

bool DdtMotorLib::currentMeasuredRpm(int motor_id, double* rpm_out,
                                     wheel_speed_estimator::Estimate* est_out) const {
  if (current_measured_source_ == CurrentMeasuredSource::Reported) {
    auto fb_it = motor_feedbacks_.find(motor_id);
    *rpm_out = fb_it == motor_feedbacks_.end() ? 0.0 : static_cast<double>(fb_it->second.speed);
    return true;
  }
  wheel_speed_estimator::Estimate est;
  auto it = speed_estimators_.find(motor_id);
  if (it != speed_estimators_.end()) {
    est = it->second.estimate(controlNowSec());
  }
  if (est_out != nullptr) {
    *est_out = est;
  }
  if (!est.valid) {
    return false;
  }
  *rpm_out = est.rpm;
  return true;
}

void DdtMotorLib::setCurrentZeroDeadbandRpm(int deadband_rpm) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  current_zero_deadband_rpm_ = std::max(0, deadband_rpm);
  RCLCPP_INFO(logger_, "電流モード ゼロ近傍デッドバンド: %d RPM", current_zero_deadband_rpm_);
}

void DdtMotorLib::setCurrentInvertMeasured(bool invert) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  current_invert_measured_ = invert;
  RCLCPP_INFO(logger_, "電流モード measured符号反転: %s", invert ? "ON" : "OFF");
  clearCurrentGuardTrips("符号反転の変更");
}

void DdtMotorLib::setCurrentMaxAccelRpmPerSec(double rpm_per_sec) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  current_max_accel_rpm_per_sec_ = rpm_per_sec;
  if (rpm_per_sec > 0.0) {
    RCLCPP_INFO(logger_, "電流モード 加速度制限: %.1f RPM/s", rpm_per_sec);
  } else {
    RCLCPP_INFO(logger_, "電流モード 加速度制限: 無効");
  }
}

void DdtMotorLib::setBrakeOnStop(bool enable) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  brake_on_stop_ = enable;
  RCLCPP_INFO(logger_, "停止時電気ブレーキ: %s", enable ? "ON" : "OFF");
}

void DdtMotorLib::setAccelTime(int accel_time_0p1ms_per_rpm) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  accel_time_0p1ms_per_rpm_ = std::clamp(accel_time_0p1ms_per_rpm, 1, 255);
  RCLCPP_INFO(logger_, "ファーム加速時間: %d (0.1ms/rpm 単位 = %.1f ms/rpm)",
              accel_time_0p1ms_per_rpm_, accel_time_0p1ms_per_rpm_ * 0.1);
}

void DdtMotorLib::setCommandWaitMs(int wait_ms) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  command_wait_ms_ = std::max(0, wait_ms);
  if (command_wait_ms_ > 0) {
    RCLCPP_INFO(logger_, "指令送信後の追加待機: %d ms", command_wait_ms_);
  } else {
    RCLCPP_INFO(logger_, "指令送信後の追加待機: 無効");
  }
}

int DdtMotorLib::clampResponseTimeoutMs(int timeout_ms) {
  return std::clamp(timeout_ms, kMinResponseTimeoutMs, kMaxResponseTimeoutMs);
}

int DdtMotorLib::setResponseTimeoutMs(int timeout_ms) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  response_timeout_ms_ = clampResponseTimeoutMs(timeout_ms);
  RCLCPP_INFO(logger_, "フィードバック応答タイムアウト: %d ms%s", response_timeout_ms_,
              response_timeout_ms_ != timeout_ms ? "（指定値を範囲に丸めました）" : "");
  return response_timeout_ms_;
}

int DdtMotorLib::getResponseTimeoutMs() const {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  return response_timeout_ms_;
}

void DdtMotorLib::setStopResendIntervalMs(int interval_ms) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  stop_resend_interval_ms_ = std::max(0, interval_ms);
  if (stop_resend_interval_ms_ > 0) {
    RCLCPP_INFO(logger_, "停止中のブレーキ再送間隔: %d ms", stop_resend_interval_ms_);
  } else {
    RCLCPP_INFO(logger_, "停止中のブレーキ再送間隔スロットリング: 無効");
  }
}

void DdtMotorLib::setMeasuredLowpassTau(double tau_sec) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  measured_lpf_tau_sec_ = (tau_sec > 0.0) ? tau_sec : 0.0;
  if (measured_lpf_tau_sec_ > 0.0) {
    RCLCPP_INFO(logger_, "実測RPMローパス: tau=%.3fs (fc≒%.2fHz)", measured_lpf_tau_sec_,
                1.0 / (2.0 * M_PI * measured_lpf_tau_sec_));
  } else {
    RCLCPP_INFO(logger_, "実測RPMローパス: 無効（生値を使用）");
  }
}

int DdtMotorLib::measuredRpmForReport(const MotorFeedback& fb) const {
  if (measured_lpf_tau_sec_ > 0.0) {
    return static_cast<int>(std::lround(fb.speed_filtered));
  }
  return static_cast<int>(fb.speed);
}

bool DdtMotorLib::sendMotorVelocity(int motor_id, int velocity_rpm, bool brake) {
  int velocity_int = std::clamp(velocity_rpm, -max_motor_rpm_, max_motor_rpm_);

  // フレーム組み立ては ddt_protocol::packVelocityFrame に集約。
  std::vector<uint8_t> data_fields = ddt_protocol::packVelocityFrame(
      static_cast<uint8_t>(motor_id), static_cast<int16_t>(velocity_int),
      static_cast<uint8_t>(accel_time_0p1ms_per_rpm_), brake);

  // 固定スリープ付きの sendCommand は使わない（50Hz 指令に追従できなくなる）。
  // 応答フレームの消費により motor_feedbacks_ も更新される。
  bool success = sendFrameWithFeedback(motor_id, data_fields);
  if (success) {
    motor_velocities_[motor_id] = velocity_int;
    // refreshMotorFeedback の再送用に、実行中フレームをそのまま保存（ブレーキ等の状態を保持）。
    last_sent_frames_[motor_id] = data_fields;
    RCLCPP_DEBUG(logger_, "モーター %d 速度設定: %d RPM", motor_id, velocity_int);
  } else {
    RCLCPP_ERROR(logger_, "モーター %d の速度設定に失敗しました (目標: %d RPM)", motor_id,
                 velocity_int);
  }
  return success;
}

bool DdtMotorLib::sendMotorCurrentRaw(int motor_id, int16_t current_raw) {
  // フレーム組み立ては ddt_protocol::packCurrentFrame に集約（バイト列レイアウトは同関数を参照）。
  std::vector<uint8_t> data_fields =
      ddt_protocol::packCurrentFrame(static_cast<uint8_t>(motor_id), current_raw);

  bool success = sendFrameWithFeedback(motor_id, data_fields);
  if (success) {
    // refreshMotorFeedback の再送用に、実行中フレームをそのまま保存。
    last_sent_frames_[motor_id] = data_fields;
    transaction_stats_[motor_id].last_current_raw_sent = current_raw;
    RCLCPP_DEBUG(logger_, "モーター %d 電流指令: raw=%d", motor_id, static_cast<int>(current_raw));
  }
  return success;
}

// 戻り値は「書けたか」だけで、応答が来たかは表さない（応答が時間切れでも true。Issue #222 の
// R4）。応答の有無は countResponse と transaction_stats_ が数える。current モードの安全の判断
// （応答の途切れのラッチ・応答の新しさの門）は戻り値ではなく、そちらの「応答が来たか」で行う。
bool DdtMotorLib::sendFrameWithFeedback(int motor_id, const std::vector<uint8_t>& frame) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  if (serial_fd_ < 0) {
    return false;
  }

  // 送信前に入力バッファをクリア: 前サイクルの未取応答や遷移ゴミでの
  // フレーム同期ずれを防ぐ（CRC 不一致ログの主原因対策）。
  tcflush(serial_fd_, TCIFLUSH);

  // 書込は最大3回まで再試行する。書込成功後はフィードバックを1回だけ待つ。
  // 固定スリープは行わない: 応答待ち（最大 response_timeout_ms_、既定 10ms）が自然な
  // コマンド間隔になる。
  for (int attempt = 0; attempt < 3; ++attempt) {
    // 往復レイテンシ計測: 書込開始→フィードバック受信完了。制御周期引き上げ
    // （タイムアウト短縮・tick 高周期化）の判断材料として統計を蓄積する。
    const auto roundtrip_start = std::chrono::steady_clock::now();
    ssize_t written = writeSerial(frame.data(), frame.size());
    if (written != static_cast<ssize_t>(frame.size())) {
      RCLCPP_WARN_THROTTLE(logger_, throttle_clock_, 1000, "指令書込失敗 motor=%d", motor_id);
      std::this_thread::sleep_for(5ms);
      continue;
    }
    if (!drainSerialOutput()) {
      return false;
    }

    std::vector<uint8_t> feedback_frame;
    auto& tx = transaction_stats_[motor_id];
    ++tx.transactions;
    if (readFeedbackFrame(motor_id, feedback_frame, response_timeout_ms_)) {
      const bool parsed = parseFeedback(motor_id, feedback_frame);
      const double roundtrip_ms = std::chrono::duration<double, std::milli>(
                                      std::chrono::steady_clock::now() - roundtrip_start)
                                      .count();
      // 10 byte は届いたが有効なフィードバックでない（CRC 不一致・別 ID）ものは、診断トピックと
      // 同じく「有効な応答なし」として数える（往復時間の統計には入れない）。
      tx.last_response_timeout = !parsed;
      tx.last_roundtrip_ms = parsed ? roundtrip_ms : std::nan("");
      if (parsed) {
        recordSerialRoundtrip(roundtrip_ms);
      } else {
        ++tx.response_timeouts;
        ++serial_latency_stats_.timeouts;
      }
      countResponse(motor_id, parsed);
    } else {
      RCLCPP_DEBUG(logger_, "モーター %d フィードバック未受信 (%dms timeout)", motor_id,
                   response_timeout_ms_);
      ++serial_latency_stats_.timeouts;
      ++tx.response_timeouts;
      tx.last_response_timeout = true;
      tx.last_roundtrip_ms = std::nan("");
      countResponse(motor_id, false);
    }
    // 実機の最小コマンド間隔要件が判明した場合の保険（既定 0 = 待機なし）。
    if (command_wait_ms_ > 0) {
      std::this_thread::sleep_for(std::chrono::milliseconds(command_wait_ms_));
    }
    return true;
  }
  return false;
}

void DdtMotorLib::countResponse(int motor_id, bool valid) {
  auto it = motor_feedbacks_.find(motor_id);
  if (it == motor_feedbacks_.end()) {
    return;  // 未登録のモータ（モード設定前など）は数えない
  }
  MotorFeedback& fb = it->second;
  fb.consecutive_timeouts = valid ? 0 : fb.consecutive_timeouts + 1;
  if (!isCurrentModeMotor(motor_id)) {
    return;  // velocity モードは従来どおり
  }
  if (current_link_latched_) {
    // 解除に数えるのは、新しい有効な応答（parse に成功 = feedback_count が進んだ）で、電流ループ
    // を報告し、fault が無いものだけ。
    if (!suppress_current_link_recovery_) {
      noteCurrentLinkResponse(motor_id, valid && fb.mode == 0x01 && fb.fault_code == 0);
    }
    return;
  }
  if (fb.consecutive_timeouts >= kCurrentMaxConsecutiveTimeouts) {
    // フレームはここでは送らない（送受信の途中のため）。電流 0 は呼び出し側か次の指令が送る。
    latchCurrentLink(motor_id, "有効な応答が続けて無い");
  }
}

int16_t DdtMotorLib::runCurrentLoopStep(int motor_id, int rpm_ref, double measured_rpm,
                                        double* i_cmd_amp_out) {
  auto& st = pi_states_[motor_id];
  auto now = controlNow();

  double dt = 0.01;  // 初回および異常時のフォールバック [s]
  if (st.has_last_t) {
    dt = std::chrono::duration<double>(now - st.last_t).count();
  }
  st.last_t = now;
  st.has_last_t = true;
  dt = ddt_current_pi::sanitizeDt(dt);

  // 実測 RPM（current_measured_source。鮮度・有効性は呼び出し側 commandCurrentMode が確認済み）。
  // 符号反転は stepToRaw 内で行うため、ここではモーターの向きの値を渡す。

  ddt_current_pi::Params params{current_kp_,
                                current_ki_,
                                max_current_amp_,
                                integral_limit_amp_,
                                current_invert_measured_,
                                current_ff_static_amp_,
                                current_ff_viscous_amp_per_rpm_};
  double i_cmd_amp = 0.0;
  int16_t raw = ddt_current_pi::stepToRaw(st.pi, params, rpm_ref, measured_rpm, dt, &i_cmd_amp);
  if (i_cmd_amp_out != nullptr) {
    *i_cmd_amp_out = i_cmd_amp;
  }

  // ログは従来通り符号反転後の実測値と、それに基づく error を表示する。
  const double meas_logged = current_invert_measured_ ? -measured_rpm : measured_rpm;
  const double error = static_cast<double>(rpm_ref) - meas_logged;
  RCLCPP_INFO_THROTTLE(logger_, throttle_clock_, 200,
                       "PI motor=%d ref=%d meas=%.1f err=%.1f ff=%.3fA integ=%.3fA i_cmd=%.3fA "
                       "raw=%d dt=%.4f",
                       motor_id, rpm_ref, meas_logged, error,
                       ddt_current_pi::frictionFeedforwardAmp(rpm_ref, params), st.pi.integral_amp,
                       i_cmd_amp, static_cast<int>(raw), dt);
  return raw;
}

bool DdtMotorLib::readFeedbackFrame(int expected_motor_id, std::vector<uint8_t>& out_frame,
                                    int timeout_ms) {
  if (serial_fd_ < 0) {
    return false;
  }

  out_frame.clear();
  out_frame.reserve(10);
  uint8_t buf[16];

  auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (out_frame.size() < 10) {
    auto now = std::chrono::steady_clock::now();
    if (now >= deadline) {
      return false;
    }
    auto remain = std::chrono::duration_cast<std::chrono::microseconds>(deadline - now).count();

    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(serial_fd_, &rfds);
    struct timeval tv;
    tv.tv_sec = remain / 1000000;
    tv.tv_usec = remain % 1000000;

    int sel = select(serial_fd_ + 1, &rfds, nullptr, nullptr, &tv);
    if (sel <= 0) {
      return false;  // timeout or error
    }

    ssize_t need = 10 - static_cast<ssize_t>(out_frame.size());
    ssize_t n = readSerial(buf, std::min<ssize_t>(need, static_cast<ssize_t>(sizeof(buf))));
    if (n <= 0) {
      // EAGAIN 等。ループ継続
      continue;
    }
    for (ssize_t i = 0; i < n; ++i) {
      // 先頭バイトは expected_motor_id のはず。それ以外なら同期外れと見なし読み飛ばし
      if (out_frame.empty() && buf[i] != static_cast<uint8_t>(expected_motor_id)) {
        continue;
      }
      out_frame.push_back(buf[i]);
      if (out_frame.size() >= 10) {
        // 10バイト揃った段階で CRC を検証し、失敗なら先頭 1バイトを捨てて
        // 残りを保持したまま再同期を試みる（スライド同期）。
        std::vector<uint8_t> payload(out_frame.begin(), out_frame.begin() + 9);
        if (ddt_protocol::crc8Maxim(payload) == out_frame[9]) {
          return true;
        }
        out_frame.erase(out_frame.begin());
        // 残りに先頭以外の expected_motor_id以外バイトが先頭に来ていたらそこまで捨てる
        while (!out_frame.empty() && out_frame.front() != static_cast<uint8_t>(expected_motor_id)) {
          out_frame.erase(out_frame.begin());
        }
        // ループを続けて不足分を読む
      }
    }
  }
  return out_frame.size() == 10;
}

bool DdtMotorLib::parseFeedback(int expected_motor_id, const std::vector<uint8_t>& frame) {
  // フレーム分解・検証は ddt_protocol::parseFeedbackFrame に集約（readFeedbackFrame 側でも
  // 検証済みだが、二重ガード）。
  ddt_protocol::Feedback decoded{};
  ddt_protocol::ParseResult result =
      ddt_protocol::parseFeedbackFrame(static_cast<uint8_t>(expected_motor_id), frame, decoded);
  if (result != ddt_protocol::ParseResult::kOk) {
    if (result == ddt_protocol::ParseResult::kCrcMismatch) {
      // ログ用に payload の期待 CRC を再計算する。
      std::vector<uint8_t> payload(frame.begin(), frame.begin() + 9);
      uint8_t expected_crc = ddt_protocol::crc8Maxim(payload);
      RCLCPP_WARN_THROTTLE(logger_, throttle_clock_, 1000,
                           "CRC不一致 motor=%d expected=0x%02X got=0x%02X", expected_motor_id,
                           expected_crc, frame[9]);
    }
    return false;
  }

  // Protocol 1 応答フォーマット (DDT M0602C 仕様):
  //  DATA[1]=mode, DATA[2..3]=torque current, DATA[4..5]=speed (signed),
  //  DATA[6..7]=position, DATA[8]=fault code
  // マルチバイトは big-endian (high, low)。
  MotorFeedback& fb = motor_feedbacks_[expected_motor_id];
  // 実測 RPM の一次ローパス（レポート用途）。tau<=0 または初回受信なら生値で初期化する。
  // 可変サンプル間隔対応: alpha = dt / (tau + dt)。dt は前回受信からの経過。
  const auto feedback_now = std::chrono::steady_clock::now();
  if (measured_lpf_tau_sec_ > 0.0 && fb.has_feedback) {
    const double dt = std::chrono::duration<double>(feedback_now - fb.last_feedback_time).count();
    const double alpha = (dt > 0.0) ? std::clamp(dt / (measured_lpf_tau_sec_ + dt), 0.0, 1.0) : 0.0;
    fb.speed_filtered += alpha * (static_cast<double>(decoded.speed) - fb.speed_filtered);
  } else {
    fb.speed_filtered = static_cast<double>(decoded.speed);
  }
  fb.mode = decoded.mode;
  fb.current = decoded.current;
  fb.speed = decoded.speed;
  fb.position = decoded.position;
  // temperature は Protocol 2 (0x74) が必要なため未取得（常に 0 のまま保持）。
  fb.fault_code = decoded.fault_code;
  fb.has_feedback = true;
  fb.last_feedback_time = feedback_now;
  fb.last_feedback_control_time = controlNow();
  ++transaction_stats_[expected_motor_id].feedback_count;
  speed_estimators_[expected_motor_id].update(wheel_speed_estimator::Sample{
      fb.position,
      std::chrono::duration<double>(fb.last_feedback_control_time.time_since_epoch()).count(),
      transaction_stats_[expected_motor_id].feedback_count, fb.mode, fb.fault_code});

  // PI 状態側にも保存（受信失敗時のフォールバック用）
  auto pi_it = pi_states_.find(expected_motor_id);
  if (pi_it != pi_states_.end()) {
    pi_it->second.last_measured_rpm = fb.speed;
  }
  return true;
}

// 低頻度の設定系コマンド（setControlMode 等）専用。書込成功後にモード反映待ちとして
// 固定 50ms スリープする（呼び出し元が state_mutex_ 保持中のためその間ブロックする）。
// 高頻度の指令送信には使わず sendFrameWithFeedback を使うこと（cf. issue #84）。
bool DdtMotorLib::sendCommand(const std::vector<uint8_t>& command, int retry_count) {
  for (int attempt = 0; attempt < retry_count; attempt++) {
    try {
      ssize_t written = writeSerial(command.data(), command.size());
      if (written == static_cast<ssize_t>(command.size())) {
        // 書込済みcommandの重複送信を避けるため、drain失敗時は再試行しない。
        if (!drainSerialOutput()) {
          return false;
        }
        std::this_thread::sleep_for(50ms);
        return true;
      }
    } catch (const std::exception& e) {
      RCLCPP_WARN(logger_, "シリアル通信エラー (試行 %d): %s", attempt + 1, e.what());
      std::this_thread::sleep_for(100ms);
    }
  }
  return false;
}

bool DdtMotorLib::drainSerialOutput() {
  if (serial_fd_ < 0) {
    return false;
  }

  int result;
  int saved_errno = 0;
  do {
    result = tcdrain(serial_fd_);
    saved_errno = result == -1 ? errno : 0;
  } while (result == -1 && saved_errno == EINTR);

  if (result != 0) {
    RCLCPP_WARN_THROTTLE(logger_, throttle_clock_, 1000,
                         "シリアル送信完了待機に失敗: errno=%d (%s)", saved_errno,
                         std::strerror(saved_errno));
    return false;
  }

  return true;
}

ssize_t DdtMotorLib::writeSerial(const void* data, size_t size) {
  if (serial_fd_ < 0) {
    return -1;
  }
  return write(serial_fd_, data, size);
}

std::chrono::steady_clock::time_point DdtMotorLib::controlNow() const {
  return std::chrono::steady_clock::now();
}

ssize_t DdtMotorLib::readSerial(void* data, size_t size) {
  if (serial_fd_ < 0) {
    return -1;
  }
  return read(serial_fd_, data, size);
}

void DdtMotorLib::recordSerialRoundtrip(double roundtrip_ms) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  auto& stats = serial_latency_stats_;
  ++stats.samples;
  stats.last_ms = roundtrip_ms;
  stats.max_ms = std::max(stats.max_ms, roundtrip_ms);
  // EMA alpha=0.05: 直近 ~20 サンプル相当の平滑平均。初回はそのまま採用。
  stats.ema_ms =
      (stats.samples == 1) ? roundtrip_ms : stats.ema_ms + 0.05 * (roundtrip_ms - stats.ema_ms);
  RCLCPP_DEBUG_THROTTLE(logger_, throttle_clock_, 5000,
                        "シリアル往復: last=%.2fms ema=%.2fms max=%.2fms samples=%lu timeouts=%lu",
                        stats.last_ms, stats.ema_ms, stats.max_ms,
                        static_cast<unsigned long>(stats.samples),
                        static_cast<unsigned long>(stats.timeouts));
}

DdtMotorLib::SerialLatencyStats DdtMotorLib::getSerialLatencyStats() const {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  return serial_latency_stats_;
}

bool DdtMotorLib::getMotorFeedbackData(int motor_id, MotorFeedbackData& out) const {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  if (!initialized_) {
    return false;
  }
  auto vel_it = motor_velocities_.find(motor_id);
  if (vel_it == motor_velocities_.end()) {
    return false;
  }

  out = MotorFeedbackData{};
  out.motor_id = static_cast<uint8_t>(motor_id);
  out.target_rpm = static_cast<int16_t>(vel_it->second);

  auto fb_it = motor_feedbacks_.find(motor_id);
  if (fb_it != motor_feedbacks_.end() && fb_it->second.has_feedback) {
    const MotorFeedback& fb = fb_it->second;
    out.mode = fb.mode;
    out.current_raw = fb.current;
    // レポート用途はローパス済み実測 RPM を返す（tau<=0 で生値）。生値も併せて返す:
    // ローパスは既定 tau=0.15s (fc≒1.06Hz) で床の上の約 1.5〜1.75Hz の速度変動（原因は
    // 未確定）を約半分に見せる（一次 LPF の理論値で 1.65 Hz の利得は約 0.54。半分になるのは
    // この velocity_rpm だけ）ため、同定・振動解析は velocity_rpm_raw を使うこと。
    out.velocity_rpm = static_cast<int16_t>(measuredRpmForReport(fb));
    // control_core の観測器 (velocity RUN LQR) もこの生値を使う。
    out.velocity_rpm_raw = fb.speed;
    out.position_raw = fb.position;
    out.temperature = fb.temperature;  // 常に 0（Protocol 2 未実装）
    out.fault_code = fb.fault_code;
    out.has_feedback = true;
    out.feedback_age_sec =
        std::chrono::duration<double>(std::chrono::steady_clock::now() - fb.last_feedback_time)
            .count();
    auto est_it = speed_estimators_.find(motor_id);
    if (est_it != speed_estimators_.end()) {
      const auto est = est_it->second.estimate(controlNowSec());
      out.position_rpm = est.valid ? est.rpm : 0.0;
      out.position_rpm_valid = est.valid;
    }
  }
  return true;
}

bool DdtMotorLib::getMotorTransactionStats(int motor_id, MotorTransactionStats& out) const {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  out = MotorTransactionStats{};
  if (motor_velocities_.find(motor_id) == motor_velocities_.end()) {
    return false;
  }
  auto it = transaction_stats_.find(motor_id);
  if (it != transaction_stats_.end()) {
    out = it->second;
  }
  return true;
}

bool DdtMotorLib::refreshMotorFeedback(int motor_id, double max_age_sec) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  if (!initialized_) {
    return false;
  }

  auto fb_it = motor_feedbacks_.find(motor_id);
  if (fb_it != motor_feedbacks_.end() && fb_it->second.has_feedback) {
    double age = std::chrono::duration<double>(std::chrono::steady_clock::now() -
                                               fb_it->second.last_feedback_time)
                     .count();
    if (age <= max_age_sec) {
      return true;  // 十分新鮮: 何もしない
    }
  }

  // 古い/未受信: 最後に送信に成功したフレームが停止フレーム（指令値0）のときだけ、それを
  // そのまま再送してフィードバックを引き出す。非ゼロ（停止指令の送信失敗で残ったもの）や
  // 送信履歴なしでは何も送らない: フィードバックのために駆動指令を再送・生成しない。
  auto frame_it = last_sent_frames_.find(motor_id);
  const bool has_frame = frame_it != last_sent_frames_.end();
  const bool zero_frame = has_frame && ddt_protocol::isZeroCommandFrame(frame_it->second);
  if (has_frame && !zero_frame) {
    RCLCPP_WARN_THROTTLE(logger_, throttle_clock_, 5000,
                         "モーター %d: 最後に送信できた指令が停止ではないため、アイドル中の"
                         "フィードバック取得を行いません（停止の送信に失敗している可能性）",
                         motor_id);
  }

  // 停止フレームの再送は stopMotor と同じ再送間隔スロットルに従う。制御 tick 経由の再送が
  // スロットルをバイパスすると、残留回転がある間ブレーキが毎回新規の制動として作用し続けて
  // しまう。スロットル中は再送せず、保持フィードバックのまま返す（停止中の実測は多少古くても
  // 許容。鮮度は feedback_age_sec で観測できる）。
  bool throttled = false;
  if (zero_frame && stop_resend_interval_ms_ > 0) {
    auto now = std::chrono::steady_clock::now();
    auto last_it = last_stop_send_time_.find(motor_id);
    throttled =
        last_it != last_stop_send_time_.end() &&
        std::chrono::duration_cast<std::chrono::milliseconds>(now - last_it->second).count() <
            stop_resend_interval_ms_;
  }
  // フィードバックが新鮮な場合は上で返しているため、ここでは stale として判定する。
  if (ddt_protocol::decideIdleRefresh(false, has_frame, zero_frame, throttled) !=
      ddt_protocol::IdleRefresh::kResendZero) {
    return false;
  }
  // 再送するのは停止フレームのコピー（送信中に last_sent_frames_ が更新されても安全）。
  const std::vector<uint8_t> zero = frame_it->second;
  sendFrameWithFeedback(motor_id, zero);
  last_stop_send_time_[motor_id] = std::chrono::steady_clock::now();

  fb_it = motor_feedbacks_.find(motor_id);
  return fb_it != motor_feedbacks_.end() && fb_it->second.has_feedback &&
         std::chrono::duration<double>(std::chrono::steady_clock::now() -
                                       fb_it->second.last_feedback_time)
                 .count() <= max_age_sec;
}

}  // namespace motor_control_lib
