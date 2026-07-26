// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "motor_control_lib/ddt_protocol.hpp"

namespace motor_control_lib::ddt_protocol {

uint8_t crc8Maxim(const std::vector<uint8_t>& data) {
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

std::vector<uint8_t> packModeFrame(uint8_t motor_id, uint8_t mode_value) {
  // Protocol 3 (モード切替)
  // 仕様書: {ID, 0xA0, 0,0,0,0,0,0, 0, mode_value} （DATA[9] が mode_value で CRC 無し）
  // 既存実装互換: DATA[8] に mode_value を入れ DATA[9] を CRC8(data[0..8]) とする独自レイアウト。
  //   既存 velocity 切替 (mode_value=0) はこの形で実機動作実績がある。
  //   電流モードで意図通り切替できない場合は仕様書通りの形 (DATA[9]=mode_value, CRC無し) に
  //   フォールバックすること。
  std::vector<uint8_t> data_fields = {motor_id, 0xA0, 0, 0, 0, 0, 0, 0, mode_value};
  uint8_t crc = crc8Maxim(data_fields);
  data_fields.push_back(crc);
  return data_fields;
}

std::vector<uint8_t> packVelocityFrame(uint8_t motor_id, int16_t velocity_rpm, uint8_t accel_time,
                                       bool brake) {
  // 仕様 (M0602C プロトコル1): DATA[2]=指令上位8bit, DATA[3]=指令下位8bit。
  // マルチバイトは big-endian (high, low)。packCurrentFrame と同じ並び。
  uint8_t vel_high = static_cast<uint8_t>((velocity_rpm >> 8) & 0xFF);
  uint8_t vel_low = static_cast<uint8_t>(velocity_rpm & 0xFF);

  // DATA[6]=加速時間, DATA[7]=ブレーキ（0xFF でブレーキ、速度ループモードのみ有効）。
  uint8_t brake_byte = brake ? 0xFF : 0x00;
  std::vector<uint8_t> data_fields = {motor_id, 0x64,       vel_high,   vel_low, 0,
                                      0,        accel_time, brake_byte, 0};

  uint8_t crc = crc8Maxim(data_fields);
  data_fields.push_back(crc);
  return data_fields;
}

std::vector<uint8_t> packCurrentFrame(uint8_t motor_id, int16_t current_raw) {
  // Protocol 1 (0x64) を電流指令として送信。
  // 仕様: DATA[2]=指令上位, DATA[3]=指令下位（電流モードでは -32767..32767 が -8A..8A）
  // 電流モードでは acceleration / brake バイトは無効。
  // マルチバイトは big-endian (high, low)。
  uint8_t cur_high = static_cast<uint8_t>((current_raw >> 8) & 0xFF);
  uint8_t cur_low = static_cast<uint8_t>(current_raw & 0xFF);

  std::vector<uint8_t> data_fields = {motor_id, 0x64, cur_high, cur_low, 0, 0, 0, 0, 0};
  uint8_t crc = crc8Maxim(data_fields);
  data_fields.push_back(crc);
  return data_fields;
}

bool isZeroVelocityFrame(const std::vector<uint8_t>& frame) {
  // Protocol 1 (0x64) で指令値 DATA[2..3] (big-endian) が 0 のフレーム。
  return frame.size() == 10 && frame[1] == 0x64 && frame[2] == 0x00 && frame[3] == 0x00;
}

ParseResult parseFeedbackFrame(uint8_t expected_motor_id, const std::vector<uint8_t>& frame,
                               Feedback& out) {
  if (frame.size() != 10) {
    return ParseResult::kBadLength;
  }
  if (frame[0] != expected_motor_id) {
    return ParseResult::kIdMismatch;
  }
  // CRC8 検証（readFeedbackFrame 側でも検証済みだが、二重ガード）
  std::vector<uint8_t> payload(frame.begin(), frame.begin() + 9);
  uint8_t expected_crc = crc8Maxim(payload);
  if (expected_crc != frame[9]) {
    return ParseResult::kCrcMismatch;
  }

  // Protocol 1 応答フォーマット (DDT M0602C 仕様):
  //  DATA[1]=mode, DATA[2..3]=torque current, DATA[4..5]=speed (signed),
  //  DATA[6..7]=position, DATA[8]=fault code
  // マルチバイトは big-endian (high, low)。
  out.mode = frame[1];
  out.current = static_cast<int16_t>((frame[2] << 8) | frame[3]);
  out.speed = static_cast<int16_t>((frame[4] << 8) | frame[5]);
  out.position = static_cast<uint16_t>((frame[6] << 8) | frame[7]);
  out.fault_code = frame[8];
  return ParseResult::kOk;
}

}  // namespace motor_control_lib::ddt_protocol
