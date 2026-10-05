// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// FeetechServoController on a pseudo terminal (no servo, no hardware): a fake servo on the other
// end of the pty answers Modbus read / write requests, stays silent (an unpowered servo) or
// answers with a broken checksum. Pins down the response deadline (issue #175: a short deadline
// keeps shot_component's startup probe from blocking its executor for 1.5 s) and the result
// classification the caller uses to log an expected no-response once instead of at every layer.
#include <gtest/gtest.h>
#include <poll.h>
#include <pty.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <string>
#include <thread>
#include <vector>

#include "motor_control_lib/feetech_protocol.hpp"
#include "motor_control_lib/servo_control.hpp"

namespace {

using motor_control_lib::FeetechServoController;
using Result = FeetechServoController::TransactionResult;

enum class Behavior { kAnswer, kSilent, kBadChecksum };

// The servo end of the pty. Reads 8-byte Modbus requests and answers them per behavior.
class FakeServo {
public:
  explicit FakeServo(Behavior behavior) : behavior_(behavior) {
    char name[256] = {};
    if (openpty(&master_, &slave_, name, nullptr, nullptr) == 0) {
      path_ = name;
      thread_ = std::thread([this]() { run(); });
    }
  }
  ~FakeServo() {
    stop_ = true;
    if (thread_.joinable()) thread_.join();
    if (slave_ >= 0) close(slave_);
    if (master_ >= 0) close(master_);
  }
  const std::string& path() const { return path_; }
  int requests() const { return requests_.load(); }

  static constexpr uint16_t kPosition = 2048;

private:
  void run() {
    std::vector<uint8_t> buffer;
    while (!stop_) {
      pollfd pfd{master_, POLLIN, 0};
      if (poll(&pfd, 1, 10) <= 0 || !(pfd.revents & POLLIN)) continue;
      uint8_t chunk[64];
      const ssize_t n = read(master_, chunk, sizeof(chunk));
      if (n <= 0) continue;
      buffer.insert(buffer.end(), chunk, chunk + n);
      while (buffer.size() >= 8) {
        const std::vector<uint8_t> request(buffer.begin(), buffer.begin() + 8);
        buffer.erase(buffer.begin(), buffer.begin() + 8);
        ++requests_;
        answer(request);
      }
    }
  }

  void answer(const std::vector<uint8_t>& request) {
    if (behavior_ == Behavior::kSilent) return;
    std::vector<uint8_t> response;
    if (request[1] == 3) {  // read: [id][03][02][valH][valL][crcL][crcH]
      response = {request[0], 3, 2, static_cast<uint8_t>(kPosition >> 8),
                  static_cast<uint8_t>(kPosition & 0xFF)};
    } else {  // write: echo [id][06][addrH][addrL][valH][valL][crcL][crcH]
      response.assign(request.begin(), request.begin() + 6);
    }
    uint16_t crc =
        motor_control_lib::feetech_protocol::calculateCrc16(response.data(), response.size());
    if (behavior_ == Behavior::kBadChecksum) crc ^= 0xFFFF;
    response.push_back(static_cast<uint8_t>(crc & 0xFF));  // CRC little endian (Modbus-RTU)
    response.push_back(static_cast<uint8_t>(crc >> 8));
    ASSERT_EQ(write(master_, response.data(), response.size()),
              static_cast<ssize_t>(response.size()));
  }

  Behavior behavior_;
  int master_{-1};
  int slave_{-1};
  std::string path_;
  std::thread thread_;
  std::atomic<bool> stop_{false};
  std::atomic<int> requests_{0};
};

double elapsedMs(std::chrono::steady_clock::time_point start) {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start)
      .count();
}

TEST(FeetechTransaction, DefaultDeadlineIsThePreviousFixedValueAndSetterClamps) {
  FeetechServoController servo("/dev/null", 115200);
  EXPECT_EQ(servo.responseTimeoutMs(), 1500);
  servo.setResponseTimeoutMs(0);
  EXPECT_EQ(servo.responseTimeoutMs(), 1);
  servo.setResponseTimeoutMs(100000);
  EXPECT_EQ(servo.responseTimeoutMs(), 5000);
  servo.setResponseTimeoutMs(100);
  EXPECT_EQ(servo.responseTimeoutMs(), 100);
}

TEST(FeetechTransaction, AnsweringServoReadsAndWrites) {
  FakeServo fake(Behavior::kAnswer);
  ASSERT_FALSE(fake.path().empty()) << "openpty failed";
  FeetechServoController servo(fake.path(), 115200);
  servo.setResponseTimeoutMs(100);
  ASSERT_TRUE(servo.connect());
  EXPECT_EQ(servo.getCurrentPosition(11), FakeServo::kPosition);
  EXPECT_EQ(servo.lastResult(), Result::kOk);
  EXPECT_TRUE(servo.setPosition(10, 1234, false));
  EXPECT_EQ(servo.lastResult(), Result::kOk);
}

// An unpowered servo answers nothing: the read ends at the configured deadline (plus the fixed
// RS485 turnaround waits of about 7.5 ms), not at the old 1.5 s, and is classified as no response.
TEST(FeetechTransaction, SilentServoEndsAtTheConfiguredDeadline) {
  FakeServo fake(Behavior::kSilent);
  ASSERT_FALSE(fake.path().empty()) << "openpty failed";
  FeetechServoController servo(fake.path(), 115200);
  servo.setResponseTimeoutMs(50);
  ASSERT_TRUE(servo.connect());
  const auto start = std::chrono::steady_clock::now();
  EXPECT_EQ(servo.getCurrentPosition(11), -1);
  const double ms = elapsedMs(start);
  EXPECT_EQ(servo.lastResult(), Result::kNoResponse);
  EXPECT_GE(ms, 50.0);
  EXPECT_LT(ms, 400.0);  // generous for a loaded CI runner; the old deadline alone was 1500 ms
  EXPECT_GE(fake.requests(), 1);

  const auto write_start = std::chrono::steady_clock::now();
  EXPECT_FALSE(servo.setPosition(10, 1234, false));
  EXPECT_EQ(servo.lastResult(), Result::kNoResponse);
  EXPECT_LT(elapsedMs(write_start), 400.0);
}

TEST(FeetechTransaction, BrokenChecksumIsNotNoResponse) {
  FakeServo fake(Behavior::kBadChecksum);
  ASSERT_FALSE(fake.path().empty()) << "openpty failed";
  FeetechServoController servo(fake.path(), 115200);
  servo.setResponseTimeoutMs(100);
  ASSERT_TRUE(servo.connect());
  EXPECT_EQ(servo.getCurrentPosition(11), -1);
  EXPECT_EQ(servo.lastResult(), Result::kChecksum);
}

TEST(FeetechTransaction, NotConnectedIsReported) {
  FeetechServoController servo("/dev/null", 115200);
  EXPECT_EQ(servo.readRegister(11, 257), -1);
  EXPECT_EQ(servo.lastResult(), Result::kNotConnected);
  EXPECT_STREQ(FeetechServoController::resultName(Result::kNoResponse), "no_response");
}

}  // namespace
