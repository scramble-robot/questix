// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "motor_control_lib/feetech_protocol.hpp"

namespace motor_control_lib::feetech_protocol {

uint16_t calculateCrc16(const uint8_t* data, size_t length) {
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

size_t createModbusCommand(uint8_t slave_id, uint8_t function_code, uint16_t address,
                           uint16_t value, uint8_t* command) {
  command[0] = slave_id;
  command[1] = function_code;
  command[2] = (address >> 8) & 0xFF;  // アドレス上位
  command[3] = address & 0xFF;         // アドレス下位
  command[4] = (value >> 8) & 0xFF;    // 値上位
  command[5] = value & 0xFF;           // 値下位

  uint16_t crc = calculateCrc16(command, 6);
  command[6] = crc & 0xFF;         // CRC下位
  command[7] = (crc >> 8) & 0xFF;  // CRC上位

  return 8;
}

bool verifyChecksum(const uint8_t* data, size_t length) {
  if (length < 3) {
    return false;
  }

  // データ部分（最後の2バイトを除く）
  size_t data_length = length - 2;
  // Modbus-RTUではCRCはリトルエンディアン
  uint16_t received_crc = data[length - 2] | (data[length - 1] << 8);
  uint16_t calculated_crc = calculateCrc16(data, data_length);

  return received_crc == calculated_crc;
}

}  // namespace motor_control_lib::feetech_protocol
