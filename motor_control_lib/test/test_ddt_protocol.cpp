// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <cstdint>
#include <vector>

#include "motor_control_lib/ddt_protocol.hpp"

namespace ddt = motor_control_lib::ddt_protocol;

namespace {

std::vector<uint8_t> payloadOf(const std::vector<uint8_t>& frame) {
  return std::vector<uint8_t>(frame.begin(), frame.begin() + 9);
}

}  // namespace

TEST(Crc8Maxim, KnownAnswerAscii123456789) {
  // CRC-8/MAXIM 標準チェック値: "123456789" -> 0xA1
  std::vector<uint8_t> data = {'1', '2', '3', '4', '5', '6', '7', '8', '9'};
  EXPECT_EQ(ddt::crc8Maxim(data), 0xA1);
}

TEST(Crc8Maxim, EmptyVectorIsZero) { EXPECT_EQ(ddt::crc8Maxim(std::vector<uint8_t>{}), 0x00); }

TEST(PackVelocityFrame, ByteOrderPositiveRpm) {
  auto frame = ddt::packVelocityFrame(1, 100, 10, false);
  ASSERT_EQ(frame.size(), 10u);
  // 全10バイトの既知解 (CRC 0x25 は独立実装で事前計算した値)。
  // CRC 実装が変わればこのテストで検出される。
  const std::vector<uint8_t> expected = {0x01, 0x64, 0x00, 0x64, 0x00,
                                         0x00, 0x0A, 0x00, 0x00, 0x25};
  EXPECT_EQ(frame, expected);
  EXPECT_EQ(frame[9], ddt::crc8Maxim(payloadOf(frame)));
}

TEST(PackVelocityFrame, NegativeRpmIsBigEndian) {
  // -100 = 0xFF9C: DATA[2]=上位 0xFF, DATA[3]=下位 0x9C (big-endian 符号回帰テスト)
  auto frame = ddt::packVelocityFrame(1, -100, 10, false);
  ASSERT_EQ(frame.size(), 10u);
  EXPECT_EQ(frame[2], 0xFF);
  EXPECT_EQ(frame[3], 0x9C);
  EXPECT_EQ(frame[9], ddt::crc8Maxim(payloadOf(frame)));
}

TEST(PackVelocityFrame, BrakeSetsByte7) {
  auto frame = ddt::packVelocityFrame(1, 100, 10, true);
  ASSERT_EQ(frame.size(), 10u);
  EXPECT_EQ(frame[7], 0xFF);
  EXPECT_EQ(frame[9], ddt::crc8Maxim(payloadOf(frame)));
}

TEST(PackVelocityFrame, AccelTimeSetsByte6) {
  // DATA[6] = 加速時間（0.1 ms/rpm 単位、M0602C 仕様）
  auto frame = ddt::packVelocityFrame(1, 100, 50, false);
  ASSERT_EQ(frame.size(), 10u);
  EXPECT_EQ(frame[6], 50);
  EXPECT_EQ(frame[9], ddt::crc8Maxim(payloadOf(frame)));
}

TEST(PackCurrentFrame, NegativeRawIsBigEndian) {
  auto frame = ddt::packCurrentFrame(1, -100);
  ASSERT_EQ(frame.size(), 10u);
  const std::vector<uint8_t> expected_payload = {0x01, 0x64, 0xFF, 0x9C, 0x00,
                                                 0x00, 0x00, 0x00, 0x00};
  EXPECT_EQ(payloadOf(frame), expected_payload);
  EXPECT_EQ(frame[9], ddt::crc8Maxim(payloadOf(frame)));
}

TEST(PackCurrentFrame, MaxRawAndZeroTailBytes) {
  auto frame = ddt::packCurrentFrame(1, 32767);
  ASSERT_EQ(frame.size(), 10u);
  EXPECT_EQ(frame[2], 0x7F);
  EXPECT_EQ(frame[3], 0xFF);
  // 電流モードでは acceleration / brake バイトは無効（常に 0）
  EXPECT_EQ(frame[6], 0x00);
  EXPECT_EQ(frame[7], 0x00);
  EXPECT_EQ(frame[9], ddt::crc8Maxim(payloadOf(frame)));
}

TEST(PackModeFrame, ModeValueLandsInByte8) {
  // 既存実装互換の独自レイアウト: mode_value は DATA[8]
  auto current_frame = ddt::packModeFrame(1, 0x01);
  ASSERT_EQ(current_frame.size(), 10u);
  EXPECT_EQ(current_frame[1], 0xA0);
  EXPECT_EQ(current_frame[8], 0x01);
  EXPECT_EQ(current_frame[9], ddt::crc8Maxim(payloadOf(current_frame)));

  auto velocity_frame = ddt::packModeFrame(1, 0x02);
  ASSERT_EQ(velocity_frame.size(), 10u);
  EXPECT_EQ(velocity_frame[1], 0xA0);
  EXPECT_EQ(velocity_frame[8], 0x02);
  EXPECT_EQ(velocity_frame[9], ddt::crc8Maxim(payloadOf(velocity_frame)));
}

TEST(ParseFeedbackFrame, ValidFrame) {
  // speed = 0xFF9C = -100 (int16 符号拡張回帰テスト), current = 0x0102, position = 0x0304
  std::vector<uint8_t> frame = {0x01, 0x01, 0x01, 0x02, 0xFF, 0x9C, 0x03, 0x04, 0x00};
  frame.push_back(ddt::crc8Maxim(frame));

  ddt::Feedback fb{};
  EXPECT_EQ(ddt::parseFeedbackFrame(0x01, frame, fb), ddt::ParseResult::kOk);
  EXPECT_EQ(fb.mode, 0x01);
  EXPECT_EQ(fb.current, 0x0102);
  EXPECT_EQ(fb.speed, -100);
  EXPECT_EQ(fb.position, 0x0304);
  EXPECT_EQ(fb.fault_code, 0x00);
}

TEST(ParseFeedbackFrame, CurrentIsSignExtended) {
  // current = 0xFF9C = -100 (int16 符号拡張回帰テスト。旧実装は uint16 で 0xFF9C を返していた)
  std::vector<uint8_t> frame = {0x01, 0x02, 0xFF, 0x9C, 0x00, 0x00, 0x00, 0x00, 0x00};
  frame.push_back(ddt::crc8Maxim(frame));

  ddt::Feedback fb{};
  EXPECT_EQ(ddt::parseFeedbackFrame(0x01, frame, fb), ddt::ParseResult::kOk);
  EXPECT_EQ(fb.current, -100);
}

TEST(CurrentRawToAmp, KnownAnswers) {
  EXPECT_FLOAT_EQ(ddt::currentRawToAmp(0), 0.0f);
  EXPECT_FLOAT_EQ(ddt::currentRawToAmp(32767), 8.0f);
  EXPECT_FLOAT_EQ(ddt::currentRawToAmp(-32767), -8.0f);
}

TEST(ParseFeedbackFrame, BadLength) {
  ddt::Feedback fb{};
  std::vector<uint8_t> short_frame(9, 0x00);
  short_frame[0] = 0x01;
  EXPECT_EQ(ddt::parseFeedbackFrame(0x01, short_frame, fb), ddt::ParseResult::kBadLength);

  std::vector<uint8_t> long_frame(11, 0x00);
  long_frame[0] = 0x01;
  EXPECT_EQ(ddt::parseFeedbackFrame(0x01, long_frame, fb), ddt::ParseResult::kBadLength);
}

TEST(ParseFeedbackFrame, IdMismatch) {
  std::vector<uint8_t> frame = {0x01, 0x01, 0x01, 0x02, 0xFF, 0x9C, 0x00, 0x00, 0x00};
  frame.push_back(ddt::crc8Maxim(frame));

  ddt::Feedback fb{};
  EXPECT_EQ(ddt::parseFeedbackFrame(0x02, frame, fb), ddt::ParseResult::kIdMismatch);
}

TEST(ParseFeedbackFrame, CrcMismatch) {
  std::vector<uint8_t> frame = {0x01, 0x01, 0x01, 0x02, 0xFF, 0x9C, 0x00, 0x00, 0x00};
  frame.push_back(static_cast<uint8_t>(ddt::crc8Maxim(frame) ^ 0xFF));

  ddt::Feedback fb{};
  EXPECT_EQ(ddt::parseFeedbackFrame(0x01, frame, fb), ddt::ParseResult::kCrcMismatch);
}

TEST(PackVelocityFrame, RoundTripCrcMatches) {
  for (int16_t rpm : {int16_t{-330}, int16_t{-1}, int16_t{0}, int16_t{1}, int16_t{330}}) {
    auto frame = ddt::packVelocityFrame(1, rpm, 10, false);
    ASSERT_EQ(frame.size(), 10u);
    EXPECT_EQ(frame[9], ddt::crc8Maxim(payloadOf(frame))) << "rpm=" << rpm;
  }
}

int main(int argc, char** argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
