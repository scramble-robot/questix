// Copyright 2026 scramble-robot
//
#include "motor_control_lib/servo_control.hpp"

#include <fcntl.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <termios.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstring>
#include <iostream>
#include <thread>
#include <vector>

namespace motor_control_lib {

FeetechServoController::FeetechServoController(const std::string& port, int baudrate)
    : port_(port), baudrate_(baudrate), serial_fd_(-1), connected_(false) {
  initializeRegisterMap();
}

FeetechServoController::~FeetechServoController() { disconnect(); }

bool FeetechServoController::connect() {
  // シリアルポートを開く
  serial_fd_ = open(port_.c_str(), O_RDWR | O_NOCTTY | O_NDELAY);
  if (serial_fd_ == -1) {
    std::cerr << "Failed to open serial port: " << port_ << " - " << strerror(errno) << std::endl;
    return false;
  }

  // シリアルポート設定
  struct termios options;
  tcgetattr(serial_fd_, &options);

  // ボーレート設定
  speed_t speed;
  switch (baudrate_) {
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
    case 230400:
      speed = B230400;
      break;
    case 460800:
      speed = B460800;
      break;
    case 921600:
      speed = B921600;
      break;
    default:
      std::cerr << "Unsupported baudrate: " << baudrate_ << std::endl;
      close(serial_fd_);
      return false;
  }

  cfsetispeed(&options, speed);
  cfsetospeed(&options, speed);

  // 8N1設定
  options.c_cflag &= ~PARENB;  // パリティなし
  options.c_cflag &= ~CSTOPB;  // ストップビット1
  options.c_cflag &= ~CSIZE;   // データビットマスクをクリア
  options.c_cflag |= CS8;      // データビット8

  // ハードウェアフロー制御無効
  options.c_cflag &= ~CRTSCTS;

  // ローカルライン、受信有効
  options.c_cflag |= CREAD | CLOCAL;

  // 入力処理フラグ
  options.c_iflag &= ~(IXON | IXOFF | IXANY);          // ソフトウェアフロー制御無効
  options.c_iflag &= ~(ICANON | ECHO | ECHOE | ISIG);  // Raw入力
  options.c_iflag &= ~(INLCR | IGNCR | ICRNL);         // 改行文字変換無効

  // ライン処理フラグ
  options.c_lflag &= ~(ICANON | ECHO | ECHOE | ISIG);  // Raw入力

  // 出力処理フラグ
  options.c_oflag &= ~OPOST;  // Raw出力

  // タイムアウト設定
  options.c_cc[VMIN] = 1;     // 最小読み取り文字数（1文字以上待つ）
  options.c_cc[VTIME] = 100;  // タイムアウト（0.1秒単位、10秒）

  if (tcsetattr(serial_fd_, TCSANOW, &options) != 0) {
    std::cerr << "Failed to set serial attributes: " << strerror(errno) << std::endl;
    close(serial_fd_);
    return false;
  }

  // バッファをクリア
  tcflush(serial_fd_, TCIOFLUSH);

  // RS485設定確認
  int status;
  ioctl(serial_fd_, TIOCMGET, &status);
  std::cout << "Serial port status: 0x" << std::hex << status << std::dec << std::endl;

  connected_ = true;
  std::cout << "Connected to servo controller: " << port_ << " @ " << baudrate_ << " bps"
            << std::endl;
  return true;
}

int32_t FeetechServoController::getCurrentPosition(uint8_t servo_id) {
  std::cout << "Reading current position for servo " << static_cast<int>(servo_id) << "..."
            << std::endl;

  // Read Present Position (register 256 according to initializeRegisterMap)
  int32_t position = readRegister(servo_id, 256);

  if (position != -1) {
    std::cout << "Position read successfully: " << position << std::endl;
  } else {
    std::cout << "Failed to read position" << std::endl;
  }

  return position;
}

void FeetechServoController::disconnect() {
  if (serial_fd_ != -1) {
    close(serial_fd_);
    serial_fd_ = -1;
    connected_ = false;
    std::cout << "Disconnected from servo controller" << std::endl;
  }
}

bool FeetechServoController::isConnected() const { return connected_; }

uint16_t FeetechServoController::calculateCRC16(const uint8_t* data, size_t length) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < length; i++) {
    crc ^= data[i];
    for (int j = 0; j < 8; j++) {
      if (crc & 1) {
        crc >>= 1;
        crc ^= 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc;
}

size_t FeetechServoController::createModbusCommand(uint8_t slave_id, uint8_t function_code,
                                                   uint16_t address, uint16_t value,
                                                   uint8_t* command) {
  command[0] = slave_id;
  command[1] = function_code;
  command[2] = (address >> 8) & 0xFF;  // アドレス上位
  command[3] = address & 0xFF;         // アドレス下位
  command[4] = (value >> 8) & 0xFF;    // 値上位
  command[5] = value & 0xFF;           // 値下位

  uint16_t crc = calculateCRC16(command, 6);
  command[6] = crc & 0xFF;         // CRC下位
  command[7] = (crc >> 8) & 0xFF;  // CRC上位

  return 8;
}

bool FeetechServoController::verifyChecksum(const uint8_t* data, size_t length) {
  if (length < 3) {
    return false;
  }

  // データ部分（最後の2バイトを除く）
  size_t data_length = length - 2;
  // Modbus-RTUではCRCはリトルエンディアン
  uint16_t received_crc = data[length - 2] | (data[length - 1] << 8);
  uint16_t calculated_crc = calculateCRC16(data, data_length);

  return received_crc == calculated_crc;
}

int FeetechServoController::sendCommand(const uint8_t* cmd_bytes, size_t cmd_length,
                                        uint8_t* response, size_t max_response_length,
                                        bool expect_response) {
  if (!connected_ || serial_fd_ == -1) {
    return -1;
  }

  try {
    // デバッグ: 送信コマンドを表示（高速コマンド時は出力を削減）
    if (cmd_bytes[1] != 6) {  // 書き込みコマンド以外のみ表示
      std::cout << "Sending command: ";
      for (size_t i = 0; i < cmd_length; i++) {
        printf("%02X ", cmd_bytes[i]);
      }
      std::cout << std::endl;
    }

    // バッファクリア
    tcflush(serial_fd_, TCIOFLUSH);

    // RS485送信制御（RTSピン制御）
    int rts = TIOCM_RTS;
    ioctl(serial_fd_, TIOCMBIS, &rts);  // RTS有効

    // RTS制御後の短い待機（通信安定化）
    std::this_thread::sleep_for(std::chrono::microseconds(500));

    // コマンド送信
    ssize_t bytes_written = write(serial_fd_, cmd_bytes, cmd_length);
    if (bytes_written != static_cast<ssize_t>(cmd_length)) {
      std::cerr << "Failed to write complete command" << std::endl;
      ioctl(serial_fd_, TIOCMBIC, &rts);  // RTS無効（エラー時も必ず実行）
      return -1;
    }

    // 送信完了待機
    tcdrain(serial_fd_);

    // 送信後の待機時間を延長（高速コマンドに対応）
    std::this_thread::sleep_for(std::chrono::milliseconds(2));

    // RS485受信制御
    ioctl(serial_fd_, TIOCMBIC, &rts);  // RTS無効

    if (!expect_response) {
      return 0;
    }

    // 応答受信待機（高速コマンドに対応して待機時間を調整）
    std::this_thread::sleep_for(std::chrono::milliseconds(5));

    // 応答受信（ブロッキング読み取りに変更）
    ssize_t bytes_read = 0;
    int retry_count = 0;
    const int max_retries = 3;  // リトライ回数を削減

    while (retry_count < max_retries && bytes_read <= 0) {
      // タイムアウト付きブロッキング読み取り
      fd_set read_fds;
      struct timeval timeout_val;
      FD_ZERO(&read_fds);
      FD_SET(serial_fd_, &read_fds);
      timeout_val.tv_sec = 0;
      timeout_val.tv_usec = 500000;  // 500ms（高速コマンド対応でタイムアウトを短縮）

      int select_result = select(serial_fd_ + 1, &read_fds, NULL, NULL, &timeout_val);
      if (select_result > 0 && FD_ISSET(serial_fd_, &read_fds)) {
        bytes_read = read(serial_fd_, response, max_response_length);
      } else if (select_result == 0) {
        std::cout << "Read timeout on attempt " << (retry_count + 1) << std::endl;
      } else {
        std::cerr << "Select error: " << strerror(errno) << std::endl;
      }

      if (bytes_read <= 0) {
        retry_count++;
        if (retry_count < max_retries) {
          std::this_thread::sleep_for(std::chrono::milliseconds(20));  // リトライ間隔を短縮
        }
      }
    }
    if (bytes_read > 0) {
      // デバッグ: 受信レスポンスを表示（読み取りコマンドのみ）
      if (cmd_bytes[1] == 3) {  // 読み取りコマンドのみ表示
        std::cout << "Received response (" << bytes_read << " bytes): ";
        for (ssize_t i = 0; i < bytes_read; i++) {
          printf("%02X ", response[i]);
        }
        std::cout << std::endl;
      }

      // チェックサム検証
      if (verifyChecksum(response, bytes_read)) {
        return bytes_read;
      } else {
        std::cerr << "Checksum verification failed" << std::endl;
        return -1;
      }
    } else {
      std::cerr << "No response received after " << max_retries
                << " attempts. bytes_read = " << bytes_read << std::endl;
      if (bytes_read < 0) {
        std::cerr << "Read error: " << strerror(errno) << std::endl;
      }
      return -1;
    }

  } catch (const std::exception& e) {
    std::cerr << "Communication error: " << e.what() << std::endl;
    return -1;
  }
}

int32_t FeetechServoController::readRegister(uint8_t servo_id, uint16_t address) {
  if (!connected_) {
    return -1;
  }

  uint8_t cmd[8];
  size_t cmd_length = createModbusCommand(servo_id, 3, address, 1, cmd);

  uint8_t response[50];
  int response_length = sendCommand(cmd, cmd_length, response, sizeof(response));

  if (response_length >= 5 && response[1] == 3 && response[2] == 2) {
    // Modbus読み取りレスポンス: [ID][03][バイト数][データH][データL][CRCL][CRCH]
    // レジスタ値を抽出（ビッグエンディアン）
    uint16_t value = (response[3] << 8) | response[4];
    std::cout << "Read register " << address << " = " << value << " (0x" << std::hex << value
              << std::dec << ")" << std::endl;
    return static_cast<int32_t>(value);
  } else if (response_length > 0 && (response[1] & 0x80)) {
    // エラーレスポンス
    std::cerr << "Error response: 0x" << std::hex << static_cast<int>(response[1]) << std::dec
              << std::endl;
    return -1;
  } else {
    std::cerr << "Invalid response length: " << response_length << std::endl;
    return -1;
  }
}

bool FeetechServoController::writeRegister(uint8_t servo_id, uint16_t address, uint16_t value) {
  if (!connected_) {
    return false;
  }

  uint8_t cmd[8];
  size_t cmd_length = createModbusCommand(servo_id, 6, address, value, cmd);

  uint8_t response[50];
  int response_length = sendCommand(cmd, cmd_length, response, sizeof(response));

  if (response_length >= 6 && response[1] == 6) {
    // Modbus書き込みレスポンス: エコーバック確認
    uint16_t echo_addr = (response[2] << 8) | response[3];
    uint16_t echo_value = (response[4] << 8) | response[5];

    bool success = (echo_addr == address && echo_value == value);
    std::cout << "Write register " << address << " = " << value << " -> "
              << (success ? "SUCCESS" : "FAILED") << std::endl;
    return success;
  } else if (response_length > 0 && (response[1] & 0x80)) {
    // エラーレスポンス
    std::cerr << "Write error response: 0x" << std::hex << static_cast<int>(response[1]) << std::dec
              << std::endl;
    return false;
  } else {
    std::cerr << "Invalid write response length: " << response_length << std::endl;
    return false;
  }
}

bool FeetechServoController::setPosition(uint8_t servo_id, uint16_t position, bool enable_torque,
                                         double timeout) {
  if (!connected_) {
    std::cerr << "Not connected to servo controller" << std::endl;
    return false;
  }

  std::cout << "Setting position for servo " << static_cast<int>(servo_id) << " to " << position
            << std::endl;

  try {
    // 位置コマンド送信（応答確認を簡素化）
    if (!writeRegister(servo_id, 128, position)) {  // Goal Position
      std::cerr << "Failed to set position for servo " << static_cast<int>(servo_id) << std::endl;
      return false;
    }

    // 高速コマンド対応：位置確認は省略して迅速に処理
    std::cout << "Position set successfully for servo " << static_cast<int>(servo_id) << " to "
              << position << std::endl;
    return true;

  } catch (const std::exception& e) {
    std::cerr << "setPosition error: " << e.what() << std::endl;
    return false;
  }
}

void FeetechServoController::initializeRegisterMap() {
  known_registers_[0] = {"Firmware main version No", 2009, "read",
                         "ファームウェアメインバージョン番号"};
  known_registers_[1] = {"Firmware sub version No", 2005, "read",
                         "ファームウェアサブバージョン番号"};
  known_registers_[2] = {"Firmware Release version No", 2025, "read",
                         "ファームウェアリリースバージョン番号"};
  known_registers_[3] = {"Firmware Release date", 423, "read", "ファームウェアリリース日"};
  known_registers_[10] = {"ID", 10, "read_write", "ID"};
  known_registers_[11] = {"Baudrate", 2, "read_write", "ボーレート"};
  known_registers_[12] = {"Return Delay Time", 500, "read_write", "リターン遅延時間"};
  known_registers_[128] = {"Goal Position", 2129, "read_write", "位置コマンド"};
  known_registers_[129] = {"Torque Enable", 1, "read_write", "トルク有効"};
  known_registers_[130] = {"Goal Acceleration", 0, "read_write", "目標加速度"};
  known_registers_[131] = {"Goal Velocity", 250, "read_write", "目標速度"};
  known_registers_[256] = {"Present Position", 2128, "read", "現在位置"};
  known_registers_[257] = {"Present Position", 2128, "read", "現在位置"};
  known_registers_[258] = {"Present Velocity", 500, "read", "現在速度"};
  known_registers_[259] = {"Present PWM", 500, "read", "現在PWM"};
  known_registers_[260] = {"Present Input Voltage", 500, "read", "電圧フィードバック"};
  known_registers_[261] = {"Present Temperature", 500, "read", "温度フィードバック"};
  known_registers_[262] = {"Moving Status", 500, "read", "移動ステータス"};
  known_registers_[263] = {"Present Current", 0, "read", "現在電流"};
}

// ShotController実装
ShotController::ShotController(std::shared_ptr<ServoControllerBase> servo_controller)
    : servo_controller_(servo_controller) {}

bool ShotController::aimAt(uint8_t pan_servo_id, uint8_t tilt_servo_id, uint16_t pan_position,
                           uint16_t tilt_position, double timeout) {
  if (!servo_controller_ || !servo_controller_->isConnected()) {
    return false;
  }

  // パンとチルトサーボを同時に移動
  bool pan_success = servo_controller_->setPosition(pan_servo_id, pan_position, true, timeout);
  bool tilt_success = servo_controller_->setPosition(tilt_servo_id, tilt_position, true, timeout);

  return pan_success && tilt_success;
}

bool ShotController::fire(uint8_t trigger_servo_id, uint16_t fire_position,
                          uint16_t return_position, double fire_duration) {
  if (!servo_controller_ || !servo_controller_->isConnected()) {
    return false;
  }

  // 1. 射撃位置に移動
  if (!servo_controller_->setPosition(trigger_servo_id, fire_position)) {
    return false;
  }

  // 2. 射撃持続時間待機
  std::this_thread::sleep_for(std::chrono::milliseconds(static_cast<int>(fire_duration * 1000)));

  // 3. 復帰位置に戻る
  return servo_controller_->setPosition(trigger_servo_id, return_position);
}

bool ShotController::returnHome(uint8_t pan_servo_id, uint8_t tilt_servo_id,
                                uint8_t trigger_servo_id, uint16_t pan_home, uint16_t tilt_home,
                                uint16_t trigger_home) {
  if (!servo_controller_ || !servo_controller_->isConnected()) {
    return false;
  }

  // 全てのサーボをホーム位置に戻す
  bool pan_success = servo_controller_->setPosition(pan_servo_id, pan_home);
  bool tilt_success = servo_controller_->setPosition(tilt_servo_id, tilt_home);
  bool trigger_success = servo_controller_->setPosition(trigger_servo_id, trigger_home);

  return pan_success && tilt_success && trigger_success;
}

bool ShotController::getCurrentAim(uint8_t pan_servo_id, uint8_t tilt_servo_id,
                                   int32_t& pan_position, int32_t& tilt_position) {
  if (!servo_controller_ || !servo_controller_->isConnected()) {
    return false;
  }

  pan_position = servo_controller_->getCurrentPosition(pan_servo_id);
  tilt_position = servo_controller_->getCurrentPosition(tilt_servo_id);

  return (pan_position != -1 && tilt_position != -1);
}

}  // namespace motor_control_lib
