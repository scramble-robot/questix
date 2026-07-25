// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "motor_control_lib/ddt_motor_lib.hpp"

#include <sys/select.h>

#include <algorithm>
#include <cerrno>
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
      current_kp_(0.005),
      current_ki_(0.02),
      max_current_amp_(2.0),
      integral_limit_amp_(1.5),
      current_zero_deadband_rpm_(5),
      current_invert_measured_(false),
      current_max_accel_rpm_per_sec_(0.0),
      brake_on_stop_(true),
      accel_time_0p1ms_per_rpm_(50),
      command_wait_ms_(0),
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
    last_sent_frames_.clear();
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
  return true;
}

void DdtMotorLib::resetCurrentPiStateForStop(int motor_id) {
  auto& pi_state = pi_states_[motor_id];
  pi_state.pi.integral_amp = 0.0;
  pi_state.has_last_t = false;
  pi_state.ref_rpm_filtered = 0.0;
  pi_state.last_ref_t = {};
  pi_state.has_last_ref_t = false;
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
    // スルーレート制限（加速度制限）: 目標 RPM を 1ステップあたり max_accel * dt だけ変化させる。
    // これにより起動ステップ時の電流飽和を抑え、急加速を抑制する。
    int rpm_ref = rpm_ref_raw;
    if (current_max_accel_rpm_per_sec_ > 0.0) {
      auto& st = pi_states_[motor_id];
      auto now = std::chrono::steady_clock::now();
      double dt = 0.01;
      if (st.has_last_ref_t) {
        dt = std::chrono::duration<double>(now - st.last_ref_t).count();
        if (dt <= 0.0 || dt > 0.2) {
          dt = 0.01;
        }
      } else {
        double initial_ref_rpm = 0.0;
        auto fb_it = motor_feedbacks_.find(motor_id);
        if (fb_it != motor_feedbacks_.end()) {
          initial_ref_rpm = static_cast<double>(fb_it->second.speed);
          if (current_invert_measured_) {
            initial_ref_rpm = -initial_ref_rpm;
          }
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
    if (rpm_ref == 0) {
      int measured_rpm = 0;
      auto fb_it = motor_feedbacks_.find(motor_id);
      if (fb_it != motor_feedbacks_.end()) {
        measured_rpm = static_cast<int>(fb_it->second.speed);
      }
      if (ddt_current_pi::inZeroDeadband(rpm_ref, measured_rpm, current_zero_deadband_rpm_)) {
        auto pi_it = pi_states_.find(motor_id);
        if (pi_it != pi_states_.end()) {
          pi_it->second.pi.integral_amp = 0.0;
          pi_it->second.has_last_t = false;
        }
        return sendMotorCurrentRaw(motor_id, 0);
      }
    }
    int16_t current_raw = runCurrentLoopStep(motor_id, rpm_ref);
    return sendMotorCurrentRaw(motor_id, current_raw);
  }

  return sendMotorVelocity(motor_id, rpm_ref_raw);
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

  velocity_rpm = prefer_measured ? static_cast<int>(feedback_it->second.speed) : vel_it->second;

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
  pi_states_[motor_id] = PiState{};

  // フィードバックをプライミング: ゼロ指令を 1 回通常経路で送り、last_sent_frames_ を
  // 埋めつつ初回フィードバックを取得する（モータは動かない）。未通電時など失敗しても
  // 致命ではないため WARN に留めて初期化は成功させる。
  bool primed = (mode == ControlMode::Current) ? sendMotorCurrentRaw(motor_id, 0)
                                               : sendMotorVelocity(motor_id, 0, brake_on_stop_);
  if (!primed) {
    RCLCPP_WARN(logger_, "モーター %d のフィードバックプライミングに失敗しました（続行）",
                motor_id);
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
  auto vel_it = motor_velocities_.find(motor_id);
  bool already_stopped = vel_it != motor_velocities_.end() && vel_it->second == 0;
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

void DdtMotorLib::setStopResendIntervalMs(int interval_ms) {
  std::lock_guard<std::recursive_mutex> lock(state_mutex_);
  stop_resend_interval_ms_ = std::max(0, interval_ms);
  if (stop_resend_interval_ms_ > 0) {
    RCLCPP_INFO(logger_, "停止中のブレーキ再送間隔: %d ms", stop_resend_interval_ms_);
  } else {
    RCLCPP_INFO(logger_, "停止中のブレーキ再送間隔スロットリング: 無効");
  }
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
    RCLCPP_DEBUG(logger_, "モーター %d 電流指令: raw=%d", motor_id, static_cast<int>(current_raw));
  }
  return success;
}

bool DdtMotorLib::sendFrameWithFeedback(int motor_id, const std::vector<uint8_t>& frame) {
  if (serial_fd_ < 0) {
    return false;
  }

  // 送信前に入力バッファをクリア: 前サイクルの未取応答や遷移ゴミでの
  // フレーム同期ずれを防ぐ（CRC 不一致ログの主原因対策）。
  tcflush(serial_fd_, TCIFLUSH);

  // 書込は最大3回まで再試行する。書込成功後はフィードバックを1回だけ待つ。
  // 固定スリープは行わない: 応答待ち（最大10ms）が自然なコマンド間隔になる。
  for (int attempt = 0; attempt < 3; ++attempt) {
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
    if (readFeedbackFrame(motor_id, feedback_frame, /*timeout_ms=*/10)) {
      parseFeedback(motor_id, feedback_frame);
    } else {
      RCLCPP_DEBUG(logger_, "モーター %d フィードバック未受信 (10ms timeout)", motor_id);
    }
    // 実機の最小コマンド間隔要件が判明した場合の保険（既定 0 = 待機なし）。
    if (command_wait_ms_ > 0) {
      std::this_thread::sleep_for(std::chrono::milliseconds(command_wait_ms_));
    }
    return true;
  }
  return false;
}

int16_t DdtMotorLib::runCurrentLoopStep(int motor_id, int rpm_ref) {
  auto& st = pi_states_[motor_id];
  auto now = std::chrono::steady_clock::now();

  double dt = 0.01;  // 初回および異常時のフォールバック [s]
  if (st.has_last_t) {
    dt = std::chrono::duration<double>(now - st.last_t).count();
  }
  st.last_t = now;
  st.has_last_t = true;
  dt = ddt_current_pi::sanitizeDt(dt);

  // 実測 RPM: フィードバック未取得なら前回保持値（受信失敗時は最新フィードバックがそのまま残る）。
  // 符号反転は stepToRaw 内で行うため、ここでは生値を渡す。
  int measured_rpm = 0;
  auto fb_it = motor_feedbacks_.find(motor_id);
  if (fb_it != motor_feedbacks_.end()) {
    measured_rpm = static_cast<int>(fb_it->second.speed);
  }

  ddt_current_pi::Params params{current_kp_, current_ki_, max_current_amp_, integral_limit_amp_,
                                current_invert_measured_};
  double i_cmd_amp = 0.0;
  int16_t raw = ddt_current_pi::stepToRaw(st.pi, params, rpm_ref, measured_rpm, dt, &i_cmd_amp);

  // ログは従来通り符号反転後の実測値と、それに基づく error を表示する。
  int meas_logged = current_invert_measured_ ? -measured_rpm : measured_rpm;
  double error = static_cast<double>(rpm_ref - meas_logged);
  RCLCPP_INFO_THROTTLE(logger_, throttle_clock_, 200,
                       "PI motor=%d ref=%d meas=%d err=%.1f integ=%.3fA i_cmd=%.3fA raw=%d dt=%.4f",
                       motor_id, rpm_ref, meas_logged, error, st.pi.integral_amp, i_cmd_amp,
                       static_cast<int>(raw), dt);
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
  fb.mode = decoded.mode;
  fb.current = decoded.current;
  fb.speed = decoded.speed;
  fb.position = decoded.position;
  // temperature は Protocol 2 (0x74) が必要なため未取得（常に 0 のまま保持）。
  fb.fault_code = decoded.fault_code;
  fb.has_feedback = true;
  fb.last_feedback_time = std::chrono::steady_clock::now();

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

ssize_t DdtMotorLib::readSerial(void* data, size_t size) {
  if (serial_fd_ < 0) {
    return -1;
  }
  return read(serial_fd_, data, size);
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
    out.velocity_rpm = fb.speed;
    out.position_raw = fb.position;
    out.temperature = fb.temperature;  // 常に 0（Protocol 2 未実装）
    out.fault_code = fb.fault_code;
    out.has_feedback = true;
    out.feedback_age_sec =
        std::chrono::duration<double>(std::chrono::steady_clock::now() - fb.last_feedback_time)
            .count();
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

  // 古い/未受信: ファームが実行中の最後のフレームをそのまま再送してフィードバックを引き出す。
  auto frame_it = last_sent_frames_.find(motor_id);
  if (frame_it == last_sent_frames_.end()) {
    return false;  // 送信履歴なし（未指令）
  }

  // 停止フレーム（指令値0）の再送は stopMotor と同じ再送間隔スロットルに従う。
  // ステータスタイマ（~10Hz）経由の再送がスロットルをバイパスすると、残留回転がある間
  // ブレーキが毎回新規の制動として作用し続けてしまう。スロットル中は再送せず、保持
  // フィードバックのまま返す（停止中の実測は多少古くても許容。鮮度は feedback_age_sec
  // で観測できる）。
  const bool stop_frame = ddt_protocol::isZeroVelocityFrame(frame_it->second);
  if (stop_frame && stop_resend_interval_ms_ > 0) {
    auto now = std::chrono::steady_clock::now();
    auto last_it = last_stop_send_time_.find(motor_id);
    if (last_it != last_stop_send_time_.end() &&
        std::chrono::duration_cast<std::chrono::milliseconds>(now - last_it->second).count() <
            stop_resend_interval_ms_) {
      return false;
    }
  }
  sendFrameWithFeedback(motor_id, frame_it->second);
  if (stop_frame) {
    last_stop_send_time_[motor_id] = std::chrono::steady_clock::now();
  }

  fb_it = motor_feedbacks_.find(motor_id);
  return fb_it != motor_feedbacks_.end() && fb_it->second.has_feedback &&
         std::chrono::duration<double>(std::chrono::steady_clock::now() -
                                       fb_it->second.last_feedback_time)
                 .count() <= max_age_sec;
}

}  // namespace motor_control_lib
