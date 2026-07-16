// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <cstddef>
#include <cstdint>

#include "motor_control_lib/feetech_protocol.hpp"

namespace mp = motor_control_lib::feetech_protocol;

TEST(FeetechProtocolTest, Crc16StandardCheckValue) {
  // CRC-16/MODBUS standard check value: ASCII "123456789" -> 0x4B37.
  const uint8_t data[] = {'1', '2', '3', '4', '5', '6', '7', '8', '9'};
  EXPECT_EQ(mp::calculateCrc16(data, sizeof(data)), 0x4B37u);
}

TEST(FeetechProtocolTest, CreateModbusCommandWrite) {
  // slave=1, fc=6 (write), address=128 (Goal Position), value=2048.
  uint8_t cmd[8] = {0};
  size_t len = mp::createModbusCommand(1, 6, 128, 2048, cmd);

  EXPECT_EQ(len, 8u);

  // Header + big-endian address/value.
  EXPECT_EQ(cmd[0], 0x01u);  // slave id
  EXPECT_EQ(cmd[1], 0x06u);  // function code
  EXPECT_EQ(cmd[2], 0x00u);  // address high (128 = 0x0080)
  EXPECT_EQ(cmd[3], 0x80u);  // address low
  EXPECT_EQ(cmd[4], 0x08u);  // value high (2048 = 0x0800)
  EXPECT_EQ(cmd[5], 0x00u);  // value low

  // CRC is little-endian (Modbus-RTU): [crcL][crcH] over the first 6 bytes.
  uint16_t crc = mp::calculateCrc16(cmd, 6);
  EXPECT_EQ(cmd[6], static_cast<uint8_t>(crc & 0xFF));
  EXPECT_EQ(cmd[7], static_cast<uint8_t>((crc >> 8) & 0xFF));

  // Fully hardcoded known-answer frame so that any CRC change is caught.
  const uint8_t expected[8] = {0x01, 0x06, 0x00, 0x80, 0x08, 0x00, 0x8F, 0xE2};
  for (size_t i = 0; i < 8; ++i) {
    EXPECT_EQ(cmd[i], expected[i]) << "byte mismatch at index " << i;
  }
}

TEST(FeetechProtocolTest, CreateModbusCommandRead) {
  // slave=1, fc=3 (read), address=257 (real hardware Present Position), value=1.
  uint8_t cmd[8] = {0};
  size_t len = mp::createModbusCommand(1, 3, 257, 1, cmd);

  EXPECT_EQ(len, 8u);

  EXPECT_EQ(cmd[0], 0x01u);  // slave id
  EXPECT_EQ(cmd[1], 0x03u);  // function code
  EXPECT_EQ(cmd[2], 0x01u);  // address high (257 = 0x0101)
  EXPECT_EQ(cmd[3], 0x01u);  // address low
  EXPECT_EQ(cmd[4], 0x00u);  // value high (1 = 0x0001)
  EXPECT_EQ(cmd[5], 0x01u);  // value low

  // Hardcoded known-answer frame including little-endian CRC.
  const uint8_t expected[8] = {0x01, 0x03, 0x01, 0x01, 0x00, 0x01, 0xD4, 0x36};
  for (size_t i = 0; i < 8; ++i) {
    EXPECT_EQ(cmd[i], expected[i]) << "byte mismatch at index " << i;
  }
}

TEST(FeetechProtocolTest, VerifyChecksumRoundTrip) {
  uint8_t cmd[8] = {0};
  mp::createModbusCommand(1, 6, 128, 2048, cmd);

  // A freshly created command verifies true.
  EXPECT_TRUE(mp::verifyChecksum(cmd, 8));

  // Corrupting each single byte in turn must fail verification.
  for (size_t i = 0; i < 8; ++i) {
    uint8_t corrupted[8];
    for (size_t k = 0; k < 8; ++k) {
      corrupted[k] = cmd[k];
    }
    corrupted[i] ^= 0xFF;
    EXPECT_FALSE(mp::verifyChecksum(corrupted, 8))
        << "corruption at index " << i << " not detected";
  }
}

TEST(FeetechProtocolTest, VerifyChecksumLengthGuards) {
  // length < 3 -> false.
  const uint8_t two[2] = {0x01, 0x06};
  EXPECT_FALSE(mp::verifyChecksum(two, 2));

  // Minimal valid length-3 path: one data byte + 2-byte little-endian CRC.
  uint8_t frame[3];
  frame[0] = 0x11;
  uint16_t crc = mp::calculateCrc16(frame, 1);
  frame[1] = static_cast<uint8_t>(crc & 0xFF);
  frame[2] = static_cast<uint8_t>((crc >> 8) & 0xFF);
  EXPECT_TRUE(mp::verifyChecksum(frame, 3));

  frame[2] ^= 0xFF;
  EXPECT_FALSE(mp::verifyChecksum(frame, 3));
}
