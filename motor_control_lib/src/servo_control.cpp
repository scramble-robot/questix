// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "motor_control_lib/servo_control.hpp"

#include <fcntl.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <termios.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstring>
#include <iomanip>
#include <rclcpp/logging.hpp>
#include <sstream>
#include <thread>
#include <vector>

#include "motor_control_lib/feetech_protocol.hpp"
#include "serial_utils/serial_port.hpp"

namespace motor_control_lib {

FeetechServoController::FeetechServoController(const std::string& port, int baudrate,
                                               const rclcpp::Logger& logger)
    : port_(port), baudrate_(baudrate), serial_fd_(-1), connected_(false), logger_(logger) {
  initializeRegisterMap();
}

FeetechServoController::~FeetechServoController() { disconnect(); }

bool FeetechServoController::connect() {
  // シリアルポートを開いて 8N1 raw 設定を適用（共通処理）
  serial_utils::SerialConfig cfg{O_RDWR | O_NOCTTY | O_NDELAY, baudrate_, 1, 100};
  serial_fd_ = serial_utils::openSerial(port_, cfg, logger_);
  if (serial_fd_ == -1) {
    RCLCPP_ERROR(logger_, "Failed to open serial port: %s - %s", port_.c_str(), strerror(errno));
    return false;
  }

  // バッファをクリア
  tcflush(serial_fd_, TCIOFLUSH);

  // RS485設定確認
  int status;
  ioctl(serial_fd_, TIOCMGET, &status);
  RCLCPP_DEBUG(logger_, "Serial port status: 0x%x", status);

  connected_ = true;
  RCLCPP_INFO(logger_, "Connected to servo controller: %s @ %d bps", port_.c_str(), baudrate_);
  return true;
}

int32_t FeetechServoController::getCurrentPosition(uint8_t servo_id) {
  RCLCPP_DEBUG(logger_, "Reading current position for servo %d...", static_cast<int>(servo_id));

  // Read Present Position (register 257 according to initializeRegisterMap)
  int32_t position = readRegister(servo_id, 257);

  if (position != -1) {
    RCLCPP_DEBUG(logger_, "Position read successfully: %d", position);
  } else {
    RCLCPP_ERROR(logger_, "Failed to read position");
  }

  return position;
}

void FeetechServoController::disconnect() {
  if (serial_fd_ != -1) {
    close(serial_fd_);
    serial_fd_ = -1;
    connected_ = false;
    RCLCPP_INFO(logger_, "Disconnected from servo controller");
  }
}

bool FeetechServoController::isConnected() const { return connected_; }

int FeetechServoController::sendCommand(const uint8_t* cmd_bytes, size_t cmd_length,
                                        uint8_t* response, size_t max_response_length,
                                        bool expect_response) {
  if (!connected_ || serial_fd_ == -1) {
    RCLCPP_ERROR(logger_, "Not connected to servo controller");
    return -1;
  }

  try {
    // デバッグ: 送信コマンドを16進ダンプ（高速コマンド時は出力を削減）
    if (cmd_bytes[1] != 6) {  // 書き込みコマンド以外のみ表示
      std::ostringstream oss;
      oss << std::hex << std::uppercase << std::setfill('0');
      for (size_t i = 0; i < cmd_length; i++) {
        oss << std::setw(2) << static_cast<int>(cmd_bytes[i]) << ' ';
      }
      RCLCPP_DEBUG(logger_, "Sending command: %s", oss.str().c_str());
    }

    // バッファクリア
    tcflush(serial_fd_, TCIOFLUSH);

    // RS485送信制御（RTSピン制御）
    int rts = TIOCM_RTS;
    ioctl(serial_fd_, TIOCMBIS, &rts);  // RTS有効

    // RTS制御後の短い待機（通信安定化）: RTS 立ち上げ後にドライバが送信方向へ
    // 切り替わるまでの安定化待ち。挙動維持のため据え置き（500us）。
    std::this_thread::sleep_for(std::chrono::microseconds(500));

    // コマンド送信
    ssize_t bytes_written = write(serial_fd_, cmd_bytes, cmd_length);
    if (bytes_written != static_cast<ssize_t>(cmd_length)) {
      RCLCPP_ERROR(logger_, "Failed to write complete command");
      ioctl(serial_fd_, TIOCMBIC, &rts);  // RTS無効（エラー時も必ず実行）
      return -1;
    }

    // 送信完了待機
    tcdrain(serial_fd_);

    // 送信後の待機（tcdrain 後もドライバ側 FIFO が空になるまでのマージン）。
    // 挙動維持のため据え置き（2ms）。
    std::this_thread::sleep_for(std::chrono::milliseconds(2));

    // RS485受信制御
    ioctl(serial_fd_, TIOCMBIC, &rts);  // RTS無効

    if (!expect_response) {
      return 0;
    }

    // 応答受信待機（サーボが応答を返し始めるまでのターンアラウンド待ち）。
    // TODO(#89): 読み溜め化により縮小検討可。実機タイミング依存のため据え置き（5ms）。
    std::this_thread::sleep_for(std::chrono::milliseconds(5));

    // 応答受信: RS485 では応答フレームが分割到着し得るため、期待長に達するまで
    // select() でタイムアウト監視しつつ read() を累積する。
    // 期待応答長は Modbus ファンクションコードから算出:
    //   read (0x03) : [ID][03][byte_count][data...][CRC_L][CRC_H] = 3 + byte_count + 2
    //                 （本コードの read は 1 レジスタ=2 バイトなので既定 7 バイト。
    //                  3 バイト目 byte_count 受信後に 3 + byte_count + 2 で再確定）
    //   write(0x06) : [ID][06][addr_H][addr_L][val_H][val_L][CRC_L][CRC_H] = 8 バイト
    //   error       : [ID][func|0x80][err][CRC_L][CRC_H] = 5 バイト（func の bit7 で検出）
    const uint8_t function_code = cmd_bytes[1];
    size_t expected_length = (function_code == 3) ? 7 : 8;  // read=7 / write=8 を初期値
    if (expected_length > max_response_length) {
      expected_length = max_response_length;
    }

    // 全体タイムアウト: 従来の 500ms x 最大 3 リトライ相当を上限として維持する。
    const auto overall_deadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(1500);

    size_t total = 0;
    bool timed_out = false;
    bool error_frame = false;

    while (total < expected_length) {
      auto now = std::chrono::steady_clock::now();
      if (now >= overall_deadline) {
        timed_out = true;
        break;
      }
      auto remaining =
          std::chrono::duration_cast<std::chrono::microseconds>(overall_deadline - now);

      fd_set read_fds;
      struct timeval timeout_val;
      FD_ZERO(&read_fds);
      FD_SET(serial_fd_, &read_fds);
      timeout_val.tv_sec = remaining.count() / 1000000;
      timeout_val.tv_usec = remaining.count() % 1000000;

      int select_result = select(serial_fd_ + 1, &read_fds, NULL, NULL, &timeout_val);
      if (select_result > 0 && FD_ISSET(serial_fd_, &read_fds)) {
        ssize_t n = read(serial_fd_, response + total, max_response_length - total);
        if (n > 0) {
          total += static_cast<size_t>(n);

          // 2 バイト目まで受信したらファンクションコードを確認し、
          // エラーレスポンス（bit7 立ち）なら期待長を 5 バイトへ切り替える。
          if (!error_frame && total >= 2 && (response[1] & 0x80)) {
            error_frame = true;
            expected_length = 5;
            if (expected_length > max_response_length) {
              expected_length = max_response_length;
            }
          }

          // read レスポンスは 3 バイト目 byte_count 確定後に期待長を再計算する。
          if (!error_frame && function_code == 3 && total >= 3) {
            size_t recalculated = 3 + static_cast<size_t>(response[2]) + 2;
            expected_length =
                (recalculated <= max_response_length) ? recalculated : max_response_length;
          }
        } else if (n == 0) {
          // EOF 相当（切断など）。これ以上読めないためループを終了。
          break;
        } else {
          RCLCPP_ERROR(logger_, "Read error: %s", strerror(errno));
          break;
        }
      } else if (select_result == 0) {
        RCLCPP_WARN(logger_, "Read timeout while waiting for response (received %zu/%zu bytes)",
                    total, expected_length);
        timed_out = true;
        break;
      } else {
        RCLCPP_ERROR(logger_, "Select error: %s", strerror(errno));
        break;
      }
    }

    if (total == 0) {
      RCLCPP_ERROR(logger_, "No response received (timeout=%s)", timed_out ? "true" : "false");
      return -1;
    }

    // デバッグ: 受信レスポンスを16進ダンプ（読み取りコマンドのみ）
    if (function_code == 3) {
      std::ostringstream oss;
      oss << std::hex << std::uppercase << std::setfill('0');
      for (size_t i = 0; i < total; i++) {
        oss << std::setw(2) << static_cast<int>(response[i]) << ' ';
      }
      RCLCPP_DEBUG(logger_, "Received response (%zu bytes): %s", total, oss.str().c_str());
    }

    // チェックサム検証（累積した total バイトに対して実施）
    if (feetech_protocol::verifyChecksum(response, total)) {
      return static_cast<int>(total);
    }

    RCLCPP_ERROR(logger_, "Checksum verification failed (received %zu bytes)", total);
    return -1;

  } catch (const std::exception& e) {
    RCLCPP_ERROR(logger_, "Communication error: %s", e.what());
    return -1;
  }
}

int32_t FeetechServoController::readRegister(uint8_t servo_id, uint16_t address) {
  if (!connected_) {
    return -1;
  }

  uint8_t cmd[8];
  size_t cmd_length = feetech_protocol::createModbusCommand(servo_id, 3, address, 1, cmd);

  uint8_t response[50];
  int response_length = sendCommand(cmd, cmd_length, response, sizeof(response));

  if (response_length >= 5 && response[1] == 3 && response[2] == 2) {
    // Modbus読み取りレスポンス: [ID][03][バイト数][データH][データL][CRCL][CRCH]
    // レジスタ値を抽出（ビッグエンディアン）
    uint16_t value = (response[3] << 8) | response[4];
    RCLCPP_DEBUG(logger_, "Read register %u = %u (0x%X)", address, value, value);
    return static_cast<int32_t>(value);
  } else if (response_length > 0 && (response[1] & 0x80)) {
    // エラーレスポンス
    RCLCPP_ERROR(logger_, "Error response: 0x%X", static_cast<int>(response[1]));
    return -1;
  } else {
    RCLCPP_ERROR(logger_, "Invalid response length: %d", response_length);
    return -1;
  }
}

bool FeetechServoController::writeRegister(uint8_t servo_id, uint16_t address, uint16_t value) {
  if (!connected_) {
    return false;
  }

  uint8_t cmd[8];
  size_t cmd_length = feetech_protocol::createModbusCommand(servo_id, 6, address, value, cmd);

  uint8_t response[50];
  int response_length = sendCommand(cmd, cmd_length, response, sizeof(response));

  if (response_length >= 6 && response[1] == 6) {
    // Modbus書き込みレスポンス: エコーバック確認
    uint16_t echo_addr = (response[2] << 8) | response[3];
    uint16_t echo_value = (response[4] << 8) | response[5];

    bool success = (echo_addr == address && echo_value == value);
    RCLCPP_DEBUG(logger_, "Write register %u = %u -> %s", address, value,
                 success ? "SUCCESS" : "FAILED");
    return success;
  } else if (response_length > 0 && (response[1] & 0x80)) {
    // エラーレスポンス
    RCLCPP_ERROR(logger_, "Write error response: 0x%X", static_cast<int>(response[1]));
    return false;
  } else {
    RCLCPP_ERROR(logger_, "Invalid write response length: %d", response_length);
    return false;
  }
}

bool FeetechServoController::setPosition(uint8_t servo_id, uint16_t position, bool enable_torque,
                                         double timeout) {
  if (!connected_) {
    RCLCPP_ERROR(logger_, "Not connected to servo controller");
    return false;
  }

  RCLCPP_DEBUG(logger_, "Setting position for servo %d to %u", static_cast<int>(servo_id),
               position);

  try {
    // 位置コマンド送信（応答確認を簡素化）
    if (!writeRegister(servo_id, 128, position)) {  // Goal Position
      RCLCPP_ERROR(logger_, "Failed to set position for servo %d", static_cast<int>(servo_id));
      return false;
    }

    // 高速コマンド対応：位置確認は省略して迅速に処理
    RCLCPP_DEBUG(logger_, "Position set successfully for servo %d to %u",
                 static_cast<int>(servo_id), position);
    return true;

  } catch (const std::exception& e) {
    RCLCPP_ERROR(logger_, "setPosition error: %s", e.what());
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
  // known_registers_[256] = {"Present Position", 2128, "read", "現在位置"};
  known_registers_[257] = {"Present Position", 2128, "read", "現在位置"};
  known_registers_[258] = {"Present Velocity", 500, "read", "現在速度"};
  known_registers_[259] = {"Present PWM", 500, "read", "現在PWM"};
  known_registers_[260] = {"Present Input Voltage", 500, "read", "電圧フィードバック"};
  known_registers_[261] = {"Present Temperature", 500, "read", "温度フィードバック"};
  known_registers_[262] = {"Moving Status", 500, "read", "移動ステータス"};
  known_registers_[263] = {"Present Current", 0, "read", "現在電流"};
}

}  // namespace motor_control_lib
