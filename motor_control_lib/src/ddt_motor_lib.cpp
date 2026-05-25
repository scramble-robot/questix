#include "motor_control_lib/ddt_motor_lib.hpp"

#include <sys/select.h>

#include <algorithm>
#include <thread>

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
      serial_fd_(-1) {
  logger_ = rclcpp::get_logger("DdtMotorLib");
}

DdtMotorLib::~DdtMotorLib() { shutdown(); }

bool DdtMotorLib::initialize() {
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
  if (initialized_) {
    emergencyStop();
    closeSerial();
    motor_velocities_.clear();
    motor_feedbacks_.clear();
    motor_modes_.clear();
    pi_states_.clear();
    initialized_ = false;
    RCLCPP_INFO(logger_, "DDTモータライブラリが終了されました");
  }
}

bool DdtMotorLib::isHealthy() const {
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

void DdtMotorLib::emergencyStop() {
  for (const auto& [motor_id, velocity] : motor_velocities_) {
    auto mode_it = motor_modes_.find(motor_id);
    if (mode_it != motor_modes_.end() && mode_it->second == ControlMode::Current) {
      // 電流モード: raw=0 を直接送信して即座にトルク解除
      sendMotorCurrentRaw(motor_id, 0);
      auto pi_it = pi_states_.find(motor_id);
      if (pi_it != pi_states_.end()) {
        pi_it->second.integral_amp = 0.0;
        pi_it->second.has_last_t = false;
      }
    } else {
      sendMotorVelocity(motor_id, 0);
    }
    std::this_thread::sleep_for(10ms);
  }
  RCLCPP_WARN(logger_, "緊急停止が実行されました");
}

bool DdtMotorLib::setMotorVelocity(int motor_id, int velocity_rpm) {
  if (!initialized_) {
    RCLCPP_ERROR(logger_, "モータが初期化されていません");
    return false;
  }

  // モード別に分岐。未登録モータは Velocity 既定。
  auto mode_it = motor_modes_.find(motor_id);
  ControlMode mode = (mode_it != motor_modes_.end()) ? mode_it->second : ControlMode::Velocity;

  // 目標 RPM は常に max_motor_rpm_ でクランプ
  int rpm_ref = std::clamp(velocity_rpm, -max_motor_rpm_, max_motor_rpm_);
  motor_velocities_[motor_id] = rpm_ref;

  if (mode == ControlMode::Current) {
    int16_t current_raw = runCurrentLoopStep(motor_id, rpm_ref);
    return sendMotorCurrentRaw(motor_id, current_raw);
  }

  return sendMotorVelocity(motor_id, rpm_ref);
}

bool DdtMotorLib::getMotorStatus(int motor_id, int& velocity_rpm, uint8_t& temperature,
                                 uint8_t& fault_code) {
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

  // Current モードでフィードバックがあれば実測 RPM を返す。それ以外は目標値を返す（既存互換）。
  auto mode_it = motor_modes_.find(motor_id);
  bool prefer_measured =
      (mode_it != motor_modes_.end() && mode_it->second == ControlMode::Current) &&
      (feedback_it != motor_feedbacks_.end());

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

bool DdtMotorLib::initializeMotor(int motor_id) { return initializeMotor(motor_id, ControlMode::Velocity); }

bool DdtMotorLib::initializeMotor(int motor_id, ControlMode mode) {
  if (!setControlMode(motor_id, mode)) {
    RCLCPP_ERROR(logger_, "モーター %d の初期化（モード設定）に失敗しました", motor_id);
    return false;
  }

  motor_modes_[motor_id] = mode;
  motor_velocities_[motor_id] = 0;
  motor_feedbacks_[motor_id] = MotorFeedback{};
  pi_states_[motor_id] = PiState{0.0, 0, std::chrono::steady_clock::now(), false};

  RCLCPP_INFO(logger_, "モーター %d が初期化されました (mode=%s)", motor_id,
              mode == ControlMode::Current ? "current" : "velocity");
  return true;
}

bool DdtMotorLib::stopMotor(int motor_id) {
  auto mode_it = motor_modes_.find(motor_id);
  if (mode_it != motor_modes_.end() && mode_it->second == ControlMode::Current) {
    auto pi_it = pi_states_.find(motor_id);
    if (pi_it != pi_states_.end()) {
      pi_it->second.integral_amp = 0.0;
      pi_it->second.has_last_t = false;
    }
    motor_velocities_[motor_id] = 0;
    return sendMotorCurrentRaw(motor_id, 0);
  }
  return sendMotorVelocity(motor_id, 0);
}

bool DdtMotorLib::stopAllMotors() {
  bool success = true;
  for (const auto& [motor_id, velocity] : motor_velocities_) {
    success &= stopMotor(motor_id);
    std::this_thread::sleep_for(10ms);
  }
  return success;
}

int DdtMotorLib::getMaxRpm() const { return max_motor_rpm_; }

bool DdtMotorLib::setMaxRpm(int max_rpm) {
  max_motor_rpm_ = max_rpm;
  return true;
}

std::vector<DdtMotorLib::MotorStatus> DdtMotorLib::getAllMotorStatus() const {
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
  try {
    serial_fd_ = open(serial_port_.c_str(), O_RDWR | O_NOCTTY | O_SYNC);
    if (serial_fd_ < 0) {
      throw std::runtime_error("シリアルポートが開けませんでした: " + serial_port_);
    }

    struct termios tty;
    if (tcgetattr(serial_fd_, &tty) != 0) {
      throw std::runtime_error("tcgetattr エラー");
    }

    // ボーレート設定
    speed_t speed = B115200;
    switch (baud_rate_) {
      case 9600:
        speed = B9600;
        break;
      case 19200:
        speed = B19200;
        break;
      case 38400:
        speed = B38400;
        break;
      case 57600:
        speed = B57600;
        break;
      case 115200:
        speed = B115200;
        break;
      default:
        RCLCPP_WARN(logger_, "未対応のボーレート %d、115200を使用", baud_rate_);
        speed = B115200;
        break;
    }

    cfsetospeed(&tty, speed);
    cfsetispeed(&tty, speed);

    // 8N1設定
    tty.c_cflag = (tty.c_cflag & ~CSIZE) | CS8;
    tty.c_iflag &= ~IGNBRK;
    tty.c_lflag = 0;
    tty.c_oflag = 0;
    tty.c_cc[VMIN] = 0;
    tty.c_cc[VTIME] = 5;

    tty.c_iflag &= ~(IXON | IXOFF | IXANY);
    tty.c_cflag |= (CLOCAL | CREAD);
    tty.c_cflag &= ~(PARENB | PARODD);
    tty.c_cflag &= ~CSTOPB;
    tty.c_cflag &= ~CRTSCTS;

    if (tcsetattr(serial_fd_, TCSANOW, &tty) != 0) {
      throw std::runtime_error("tcsetattr エラー");
    }

    RCLCPP_INFO(logger_, "シリアルポートが開きました: %s", serial_port_.c_str());
    return true;

  } catch (const std::exception& e) {
    RCLCPP_ERROR(logger_, "シリアルポートの初期化に失敗しました: %s", e.what());
    return false;
  }
}

void DdtMotorLib::closeSerial() {
  if (serial_fd_ >= 0) {
    close(serial_fd_);
    serial_fd_ = -1;
  }
}

bool DdtMotorLib::setModeVelocity(int motor_id) { return setControlMode(motor_id, ControlMode::Velocity); }

bool DdtMotorLib::setControlMode(int motor_id, ControlMode mode) {
  // Protocol 3 (モード切替)
  // 仕様書: {ID, 0xA0, 0,0,0,0,0,0, 0, mode_value} （DATA[9] が mode_value で CRC 無し）
  // 既存実装互換: DATA[8] に mode_value を入れ DATA[9] を CRC8(data[0..8]) とする独自レイアウト。
  //   既存 velocity 切替 (mode_value=0) はこの形で実機動作実績がある。
  //   電流モードで意図通り切替できない場合は仕様書通りの形 (DATA[9]=mode_value, CRC無し) に
  //   フォールバックすること。
  uint8_t mode_value = 0x02;  // 速度ループ
  if (mode == ControlMode::Current) {
    mode_value = 0x01;  // 電流ループ
  }

  std::vector<uint8_t> data_fields = {
      static_cast<uint8_t>(motor_id), 0xA0, 0, 0, 0, 0, 0, 0, mode_value};
  uint8_t crc = crc8Maxim(data_fields);
  data_fields.push_back(crc);

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
  current_kp_ = kp;
  current_ki_ = ki;
  max_current_amp_ = std::max(0.0, max_current_amp);
  integral_limit_amp_ = std::max(0.0, integral_limit_amp);
  RCLCPP_INFO(logger_,
              "電流制御パラメータ更新: Kp=%.4f, Ki=%.4f, max_current=%.2fA, integral_limit=%.2fA",
              current_kp_, current_ki_, max_current_amp_, integral_limit_amp_);
}

bool DdtMotorLib::sendMotorVelocity(int motor_id, int velocity_rpm) {
  int velocity_int = std::clamp(velocity_rpm, -max_motor_rpm_, max_motor_rpm_);

  uint8_t vel_low = static_cast<uint8_t>(velocity_int & 0xFF);
  uint8_t vel_high = static_cast<uint8_t>((velocity_int >> 8) & 0xFF);

  std::vector<uint8_t> data_fields = {
      static_cast<uint8_t>(motor_id), 0x64, vel_low, vel_high, 0, 0, 0, 0, 0};

  uint8_t crc = crc8Maxim(data_fields);
  data_fields.push_back(crc);

  bool success = sendCommand(data_fields);
  if (success) {
    motor_velocities_[motor_id] = velocity_int;
    RCLCPP_DEBUG(logger_, "モーター %d 速度設定: %d RPM", motor_id, velocity_int);
  } else {
    RCLCPP_ERROR(logger_, "モーター %d の速度設定に失敗しました (目標: %d RPM)", motor_id,
                 velocity_int);
  }
  return success;
}

bool DdtMotorLib::sendMotorCurrentRaw(int motor_id, int16_t current_raw) {
  // Protocol 1 (0x64) を電流指令として送信。
  // 仕様: DATA[2]=指令上位, DATA[3]=指令下位（電流モードでは -32767..32767 が -8A..8A）
  // 電流モードでは acceleration / brake バイトは無効。
  // ※ 既存 sendMotorVelocity がリトルエンディアン (low,high) で実機動作している実績に合わせ、
  //   こちらも (low,high) で送る。実機挙動が逆なら入替えること。
  uint8_t cur_low = static_cast<uint8_t>(current_raw & 0xFF);
  uint8_t cur_high = static_cast<uint8_t>((current_raw >> 8) & 0xFF);

  std::vector<uint8_t> data_fields = {
      static_cast<uint8_t>(motor_id), 0x64, cur_low, cur_high, 0, 0, 0, 0, 0};
  uint8_t crc = crc8Maxim(data_fields);
  data_fields.push_back(crc);

  if (serial_fd_ < 0) {
    return false;
  }

  // 書込: 応答待ちで代替するため sleep は入れない。応答が来なければリトライ最大2回。
  for (int attempt = 0; attempt < 3; ++attempt) {
    ssize_t written = writeSerial(data_fields.data(), data_fields.size());
    if (written != static_cast<ssize_t>(data_fields.size())) {
      RCLCPP_WARN_THROTTLE(logger_, *rclcpp::Clock::make_shared(), 1000,
                           "電流指令書込失敗 motor=%d", motor_id);
      std::this_thread::sleep_for(5ms);
      continue;
    }
    fsync(serial_fd_);

    std::vector<uint8_t> frame;
    if (readFeedbackFrame(motor_id, frame, /*timeout_ms=*/50)) {
      parseFeedback(motor_id, frame);
      RCLCPP_DEBUG(logger_, "モーター %d 電流指令: raw=%d", motor_id,
                   static_cast<int>(current_raw));
      return true;
    }
    // フィードバック取得失敗。前回値で PI 継続するため上位には true を返したいが、
    // 書込自体は成功しているのでこのまま返す。ただしリトライしない（次サイクルで再送）。
    RCLCPP_DEBUG(logger_, "モーター %d フィードバック未受信 (50ms timeout)", motor_id);
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
    if (dt <= 0.0 || dt > 0.2) {
      dt = 0.01;  // 異常値クリップ
    }
  }
  st.last_t = now;
  st.has_last_t = true;

  // 実測 RPM: フィードバック未取得なら前回保持値（受信失敗時は最新フィードバックがそのまま残る）
  int measured_rpm = 0;
  auto fb_it = motor_feedbacks_.find(motor_id);
  if (fb_it != motor_feedbacks_.end()) {
    measured_rpm = static_cast<int>(fb_it->second.speed);
  }

  double error = static_cast<double>(rpm_ref - measured_rpm);

  // 積分項更新 (アンチワインドアップ: 積分項寄与 = Ki * integral を ±integral_limit_amp_ にクランプ)
  st.integral_amp += error * dt;
  if (current_ki_ > 1e-9) {
    double integ_clip = integral_limit_amp_ / current_ki_;
    st.integral_amp = std::clamp(st.integral_amp, -integ_clip, integ_clip);
  } else {
    st.integral_amp = 0.0;
  }

  double i_cmd_amp = current_kp_ * error + current_ki_ * st.integral_amp;
  i_cmd_amp = std::clamp(i_cmd_amp, -max_current_amp_, max_current_amp_);

  // -8A..8A が -32767..32767 に対応（仕様書）
  double raw_d = (i_cmd_amp / 8.0) * 32767.0;
  int raw = static_cast<int>(std::lround(raw_d));
  raw = std::clamp(raw, -32767, 32767);

  RCLCPP_DEBUG(logger_,
               "PI motor=%d ref=%d meas=%d err=%.1f integ=%.3fA i_cmd=%.3fA raw=%d dt=%.4f",
               motor_id, rpm_ref, measured_rpm, error, st.integral_amp, i_cmd_amp, raw, dt);
  return static_cast<int16_t>(raw);
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
        break;
      }
    }
  }
  return out_frame.size() == 10;
}

bool DdtMotorLib::parseFeedback(int expected_motor_id, const std::vector<uint8_t>& frame) {
  if (frame.size() != 10) {
    return false;
  }
  if (frame[0] != static_cast<uint8_t>(expected_motor_id)) {
    return false;
  }
  // CRC8 検証
  std::vector<uint8_t> payload(frame.begin(), frame.begin() + 9);
  uint8_t expected_crc = crc8Maxim(payload);
  if (expected_crc != frame[9]) {
    RCLCPP_WARN_THROTTLE(logger_, *rclcpp::Clock::make_shared(), 1000,
                         "CRC不一致 motor=%d expected=0x%02X got=0x%02X", expected_motor_id,
                         expected_crc, frame[9]);
    return false;
  }

  // Protocol 1 応答フォーマット:
  //  DATA[1]=mode, DATA[2..3]=torque current, DATA[4..5]=speed (signed),
  //  DATA[6..7]=position, DATA[8]=fault code
  // ※ 送信側がリトルエンディアン (low,high) で動作している実績に合わせ、応答も
  //   リトルエンディアンとして解釈する。
  MotorFeedback& fb = motor_feedbacks_[expected_motor_id];
  fb.mode = frame[1];
  fb.current = static_cast<uint16_t>(frame[2] | (frame[3] << 8));
  fb.speed = static_cast<int16_t>(frame[4] | (frame[5] << 8));
  // 位置はここでは使わないが、temperature 取得は Protocol 2 (0x74) が必要。
  // 暫定で前回値保持（既存挙動）。
  fb.fault_code = frame[8];

  // PI 状態側にも保存（受信失敗時のフォールバック用）
  auto pi_it = pi_states_.find(expected_motor_id);
  if (pi_it != pi_states_.end()) {
    pi_it->second.last_measured_rpm = fb.speed;
  }
  return true;
}

uint8_t DdtMotorLib::crc8Maxim(const std::vector<uint8_t>& data) {
  uint8_t crc = 0x00;
  for (uint8_t byte : data) {
    crc ^= byte;
    for (int i = 0; i < 8; i++) {
      if (crc & 0x01) {
        crc = (crc >> 1) ^ 0x8C;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc;
}

bool DdtMotorLib::sendCommand(const std::vector<uint8_t>& command, int retry_count) {
  for (int attempt = 0; attempt < retry_count; attempt++) {
    try {
      ssize_t written = writeSerial(command.data(), command.size());
      if (written == static_cast<ssize_t>(command.size())) {
        fsync(serial_fd_);
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

// TODO: Implement feedback methods
bool DdtMotorLib::requestMotorFeedback(int /*motor_id*/) {
  // Implementation from original code can be added here
  return true;
}

void DdtMotorLib::processFeedbackResponse(int /*motor_id*/,
                                          const std::vector<uint8_t>& /*response*/) {
  // Implementation from original code can be added here
}

}  // namespace motor_control_lib
