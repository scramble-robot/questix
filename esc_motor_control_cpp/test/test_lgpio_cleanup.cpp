// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <string>
#include <vector>

#include "esc_motor_control_cpp/pwm_backend.hpp"

namespace {
std::vector<std::string> calls;
int servo_error = 0;
int low_error = 0;
int close_error = 0;
int open_error = 0;
int claim_error = 0;
int claimed_pin = -1;
class LgpioCleanupTest : public ::testing::Test {
protected:
  void SetUp() override {
    calls.clear();
    servo_error = low_error = close_error = open_error = claim_error = 0;
    claimed_pin = -1;
  }
};
}  // namespace

extern "C" {
int lgGpiochipOpen(int chip) {
  EXPECT_EQ(chip, 4);
  return open_error < 0 ? open_error : 10;
}
int lgGpioClaimOutput(int handle, int flags, int pin, int level) {
  EXPECT_EQ(handle, 10);
  EXPECT_EQ(flags, 0);
  EXPECT_EQ(level, 0);
  claimed_pin = pin;
  return claim_error;
}
int lgTxServo(int handle, int pin, int width, int frequency, int offset, int cycles) {
  EXPECT_EQ(handle, 10);
  EXPECT_EQ(pin, claimed_pin);
  EXPECT_EQ(width, 0);
  EXPECT_EQ(frequency, 50);
  EXPECT_EQ(offset, 0);
  EXPECT_EQ(cycles, 0);
  calls.emplace_back("stop");
  return servo_error;
}
int lgGpioWrite(int handle, int pin, int level) {
  EXPECT_EQ(handle, 10);
  EXPECT_EQ(pin, claimed_pin);
  EXPECT_EQ(level, 0);
  calls.emplace_back("low");
  return low_error;
}
int lgGpiochipClose(int handle) {
  EXPECT_EQ(handle, 10);
  calls.emplace_back("close");
  return close_error;
}
}

TEST_F(LgpioCleanupTest, StopsThenWritesLowThenClosesRememberedPin) {
  esc_motor_control_cpp::LgpioBackend backend(4);
  ASSERT_TRUE(backend.initialize(19));
  backend.cleanup();
  EXPECT_EQ(calls, std::vector<std::string>({"stop", "low", "close"}));
  backend.cleanup();
  EXPECT_EQ(calls.size(), 3u);
}

TEST_F(LgpioCleanupTest, EveryFailureStillProceedsToClose) {
  esc_motor_control_cpp::LgpioBackend backend(4);
  ASSERT_TRUE(backend.initialize(13));
  servo_error = -42;
  low_error = -43;
  close_error = -44;
  backend.cleanup();
  EXPECT_EQ(calls, std::vector<std::string>({"stop", "low", "close"}));
  EXPECT_EQ(backend.last_error(), -42);
}

TEST_F(LgpioCleanupTest, LowFailureIsReportedEvenWhenStopSucceeds) {
  esc_motor_control_cpp::LgpioBackend backend(4);
  ASSERT_TRUE(backend.initialize(13));
  low_error = -43;
  EXPECT_FALSE(backend.stop_signal(13));
  EXPECT_EQ(backend.last_error(), -43);
  EXPECT_EQ(calls, std::vector<std::string>({"stop", "low"}));
}

TEST_F(LgpioCleanupTest, InitializationErrorsAreRetained) {
  esc_motor_control_cpp::LgpioBackend backend(4);
  open_error = -20;
  EXPECT_FALSE(backend.initialize(13));
  EXPECT_EQ(backend.last_error(), -20);
  open_error = 0;
  claim_error = -21;
  EXPECT_FALSE(backend.initialize(13));
  EXPECT_EQ(backend.last_error(), -21);
  EXPECT_EQ(calls, std::vector<std::string>({"close"}));
}
