// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// DdtMotorLib's per-motor transaction record (the diagnostic /drive_control_sample reads it), with
// no motor and no hardware: a pseudo terminal stands in for /dev/ttyACM0, and a subclass answers
// each written command by writing a feedback frame into the master side (or stays silent), so the
// library's real read path (select + CRC resync + parse) runs.
#include <gtest/gtest.h>
#include <pty.h>
#include <unistd.h>

#include <chrono>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "motor_control_lib/ddt_motor_lib.hpp"
#include "motor_control_lib/ddt_protocol.hpp"

namespace {

using motor_control_lib::ControlMode;
using motor_control_lib::DdtMotorLib;
using Stats = motor_control_lib::DdtMotorLib::MotorTransactionStats;

// A valid Protocol 1 response frame (multi-byte fields big-endian, CRC-8/MAXIM over DATA[0..8]).
std::vector<uint8_t> feedbackFrame(uint8_t motor_id, int16_t speed, uint16_t position) {
  std::vector<uint8_t> frame = {motor_id,
                                0x02,
                                0x00,
                                0x00,
                                static_cast<uint8_t>((static_cast<uint16_t>(speed) >> 8) & 0xFF),
                                static_cast<uint8_t>(static_cast<uint16_t>(speed) & 0xFF),
                                static_cast<uint8_t>((position >> 8) & 0xFF),
                                static_cast<uint8_t>(position & 0xFF),
                                0x00};
  frame.push_back(motor_control_lib::ddt_protocol::crc8Maxim(frame));
  return frame;
}

class AnsweringDdtMotorLib : public DdtMotorLib {
public:
  using DdtMotorLib::DdtMotorLib;

  int master_fd{-1};
  bool answer{true};
  bool corrupt_crc{false};  // answer with a full 10-byte frame whose CRC does not match
  int16_t speed{0};

protected:
  ssize_t writeSerial(const void* data, size_t size) override {
    const auto* bytes = static_cast<const uint8_t*>(data);
    // Answer motion commands (10-byte frames) only; the mode frame needs no response.
    if (answer && master_fd >= 0 && size == 10 && bytes[1] != 0xA0) {
      auto frame = feedbackFrame(bytes[0], speed, 1234);
      if (corrupt_crc) {
        frame.back() ^= 0xFF;
      }
      if (write(master_fd, frame.data(), frame.size()) != static_cast<ssize_t>(frame.size())) {
        return -1;
      }
    }
    return static_cast<ssize_t>(size);
  }
};

constexpr int kLeft = 4;

class DdtTransactionStats : public ::testing::Test {
protected:
  void SetUp() override {
    char name[256] = {};
    ASSERT_EQ(openpty(&master_, &slave_, name, nullptr, nullptr), 0);
    lib_ = std::make_unique<AnsweringDdtMotorLib>(name, 115200);
    lib_->master_fd = master_;
    lib_->setMaxRpm(475);
    lib_->setStopResendIntervalMs(0);
    ASSERT_TRUE(lib_->initialize());
  }
  void TearDown() override {
    lib_.reset();
    close(slave_);
    close(master_);
  }

  Stats stats(int motor_id) {
    Stats out;
    EXPECT_TRUE(lib_->getMotorTransactionStats(motor_id, out));
    return out;
  }

  int master_{-1};
  int slave_{-1};
  std::unique_ptr<AnsweringDdtMotorLib> lib_;
};

TEST_F(DdtTransactionStats, UnknownMotorHasNoRecord) {
  Stats out;
  out.feedback_count = 99;
  EXPECT_FALSE(lib_->getMotorTransactionStats(9, out));
  EXPECT_EQ(out.feedback_count, 0u);
  EXPECT_TRUE(std::isnan(out.last_roundtrip_ms));
}

TEST_F(DdtTransactionStats, EachAnsweredCommandCountsOneFrame) {
  ASSERT_TRUE(lib_->initializeMotor(kLeft, ControlMode::Velocity));  // primes with one zero
  const Stats primed = stats(kLeft);
  EXPECT_EQ(primed.feedback_count, 1u);
  EXPECT_EQ(primed.transactions, 1u);

  lib_->speed = -37;
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 40));
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 41));
  const Stats after = stats(kLeft);
  EXPECT_EQ(after.feedback_count, 3u);
  EXPECT_EQ(after.transactions, 3u);
  EXPECT_EQ(after.response_timeouts, 0u);
  EXPECT_FALSE(after.last_response_timeout);
  EXPECT_TRUE(std::isfinite(after.last_roundtrip_ms));
  EXPECT_GE(after.last_roundtrip_ms, 0.0);
  EXPECT_EQ(after.last_current_raw_sent, 0);  // velocity mode sends no current

  DdtMotorLib::MotorFeedbackData fb;
  ASSERT_TRUE(lib_->getMotorFeedbackData(kLeft, fb));
  EXPECT_EQ(fb.velocity_rpm_raw, -37);  // the wire sign, untouched
  EXPECT_EQ(fb.position_raw, 1234);
}

TEST_F(DdtTransactionStats, SilentMotorCountsATimeoutAndNoFrame) {
  ASSERT_TRUE(lib_->initializeMotor(kLeft, ControlMode::Velocity));
  lib_->answer = false;
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 40));  // the write succeeds; nothing comes back
  const Stats after = stats(kLeft);
  EXPECT_EQ(after.feedback_count, 1u);  // only the priming answer
  EXPECT_EQ(after.transactions, 2u);
  EXPECT_EQ(after.response_timeouts, 1u);
  EXPECT_TRUE(after.last_response_timeout);
  EXPECT_TRUE(std::isnan(after.last_roundtrip_ms));
  // The next answered exchange clears the flag; the counters keep counting.
  lib_->answer = true;
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 40));
  EXPECT_FALSE(stats(kLeft).last_response_timeout);
  EXPECT_EQ(stats(kLeft).feedback_count, 2u);
}

// A frame that arrives but is not valid feedback (CRC mismatch) counts as "no valid response" in
// both the per-motor record (the diagnostic topic) and the latency statistics (the deactivate log).
TEST_F(DdtTransactionStats, InvalidFrameCountsAsNoValidResponseEverywhere) {
  ASSERT_TRUE(lib_->initializeMotor(kLeft, ControlMode::Velocity));
  const Stats before = stats(kLeft);
  const auto latency_before = lib_->getSerialLatencyStats();
  lib_->corrupt_crc = true;
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 40));
  const Stats after = stats(kLeft);
  const auto latency_after = lib_->getSerialLatencyStats();
  EXPECT_EQ(after.transactions, before.transactions + 1);
  EXPECT_EQ(after.feedback_count, before.feedback_count);  // nothing valid was parsed
  EXPECT_EQ(after.response_timeouts, before.response_timeouts + 1);
  EXPECT_TRUE(after.last_response_timeout);
  EXPECT_TRUE(std::isnan(after.last_roundtrip_ms));
  EXPECT_EQ(latency_after.samples, latency_before.samples);  // no round trip recorded
  EXPECT_EQ(latency_after.timeouts, latency_before.timeouts + 1);
}

TEST_F(DdtTransactionStats, CurrentModeKeepsTheLastCurrentSent) {
  lib_->setCurrentControlParams(0.01, 0.0, 1.0, 0.3);
  lib_->setCurrentZeroDeadbandRpm(0);
  ASSERT_TRUE(lib_->initializeMotor(kLeft, ControlMode::Current));
  lib_->speed = 0;
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 50));
  // Pure P: 0.01 A/rpm * 50 rpm = 0.5 A -> 0.5 / 8 * 32767 = 2048 raw.
  EXPECT_EQ(stats(kLeft).last_current_raw_sent, 2048);
  ASSERT_TRUE(lib_->stopMotorNow(kLeft));
  EXPECT_EQ(stats(kLeft).last_current_raw_sent, 0);
}

TEST_F(DdtTransactionStats, CountersSurviveReinitialization) {
  ASSERT_TRUE(lib_->initializeMotor(kLeft, ControlMode::Velocity));
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 10));
  ASSERT_TRUE(lib_->initializeMotor(kLeft, ControlMode::Velocity));
  EXPECT_EQ(stats(kLeft).feedback_count, 3u);  // cumulative: a duplicate is never re-counted
}

// The response timeout: the library default is the former fixed 10 ms, and a set value is clamped.
TEST(DdtResponseTimeout, DefaultIsTheFormerFixedValueAndSetValuesAreClamped) {
  EXPECT_EQ(DdtMotorLib::kDefaultResponseTimeoutMs, 10);
  DdtMotorLib lib("/nonexistent", 57600);  // never opened
  EXPECT_EQ(lib.getResponseTimeoutMs(), 10);
  EXPECT_EQ(lib.setResponseTimeoutMs(1), 2);
  EXPECT_EQ(lib.setResponseTimeoutMs(-5), 2);
  EXPECT_EQ(lib.setResponseTimeoutMs(2), 2);
  EXPECT_EQ(lib.setResponseTimeoutMs(17), 17);
  EXPECT_EQ(lib.setResponseTimeoutMs(50), 50);
  EXPECT_EQ(lib.setResponseTimeoutMs(51), 50);
  EXPECT_EQ(lib.getResponseTimeoutMs(), 50);
  EXPECT_EQ(DdtMotorLib::clampResponseTimeoutMs(10), 10);
}

// A silent motor costs the configured wait (a lower bound only: the scheduler may add to it).
TEST_F(DdtTransactionStats, SilentMotorWaitsTheConfiguredTimeout) {
  ASSERT_TRUE(lib_->initializeMotor(kLeft, ControlMode::Velocity));
  lib_->answer = false;
  lib_->setResponseTimeoutMs(40);
  const auto start = std::chrono::steady_clock::now();
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 40));
  const double waited_ms =
      std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
  EXPECT_GE(waited_ms, 39.0);
  EXPECT_TRUE(stats(kLeft).last_response_timeout);
}

}  // namespace
