// Copyright 2026 scramble-robot
//
#include "motor_control_lib/ddt_motor_lib.hpp"

#include <algorithm>
#include <thread>

using namespace std::chrono_literals;

namespace motor_control_lib {

DdtMotorLib::DdtMotorLib(const std::string& serial_port, int baud_rate)
    : BaseMotorController("DDTMotor"),
      serial_port_(serial_port),
      baud_rate_(baud_rate),
      max_motor_rpm_(330),
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
    sendMotorVelocity(motor_id, 0);
    std::this_thread::sleep_for(10ms);
  }
  RCLCPP_WARN(logger_, "緊急停止が実行されました");
}

bool DdtMotorLib::setMotorVelocity(int motor_id, int velocity_rpm) {
  if (!initialized_) {
    RCLCPP_ERROR(logger_, "モータが初期化されていません");
    return false;
  }

  return sendMotorVelocity(motor_id, velocity_rpm);
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

  velocity_rpm = vel_it->second;

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
  if (!setModeVelocity(motor_id)) {
    RCLCPP_ERROR(logger_, "モーター %d の初期化に失敗しました", motor_id);
    return false;
  }

  // モーター状態を追加
  motor_velocities_[motor_id] = 0;
  motor_feedbacks_[motor_id] = MotorFeedback{};

  RCLCPP_INFO(logger_, "モーター %d が初期化されました", motor_id);
  return true;
}

bool DdtMotorLib::stopMotor(int motor_id) { return sendMotorVelocity(motor_id, 0); }

bool DdtMotorLib::stopAllMotors() {
  bool success = true;
  for (const auto& [motor_id, velocity] : motor_velocities_) {
    success &= sendMotorVelocity(motor_id, 0);
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

bool DdtMotorLib::setModeVelocity(int motor_id) {
  std::vector<uint8_t> data_fields = {static_cast<uint8_t>(motor_id), 0xA0, 0, 0, 0, 0, 0, 0, 0};
  uint8_t crc = crc8Maxim(data_fields);
  data_fields.push_back(crc);

  bool success = sendCommand(data_fields);
  if (success) {
    RCLCPP_INFO(logger_, "モーター %d を速度制御モードに設定しました", motor_id);
  } else {
    RCLCPP_ERROR(logger_, "モーター %d の速度制御モード設定に失敗しました", motor_id);
  }
  return success;
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
