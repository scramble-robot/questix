// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <deque>
#include <tuple>
#include <vector>

#include "esc_motor_control_cpp/pwm_command.hpp"
#include "esc_motor_control_cpp/roller_lab_logic.hpp"

namespace {
class FakeBackend : public esc_motor_control_cpp::PwmBackend {
public:
  bool initialize(int) override { return true; }
  bool set_servo_pulse(int, int pulse) override {
    pulses.push_back(pulse);
    const bool ok = results.empty() ? true : results.front();
    if (!results.empty()) results.pop_front();
    return ok;
  }
  bool stop_signal(int) override {
    ++stops;
    return stop_ok;
  }
  int last_error() const override { return -42; }
  void cleanup() override {}
  std::string name() const override { return "fake"; }
  std::deque<bool> results;
  std::vector<int> pulses;
  int stops{0};
  bool stop_ok{true};
};

class PwmCommandTest : public ::testing::Test {
protected:
  bool send(int pulse, double speed) {
    return command.send(backend, 13, pulse, speed, changed(), error());
  }
  esc_motor_control_cpp::PwmCommand::ChangeLog changed() {
    return
        [this](int before, int after, double speed) { changes.emplace_back(before, after, speed); };
  }
  esc_motor_control_cpp::PwmCommand::ErrorLog error() {
    return [this](int code) { errors.push_back(code); };
  }
  FakeBackend backend;
  esc_motor_control_cpp::PwmCommand command;
  std::vector<std::tuple<int, int, double>> changes;
  std::vector<int> errors;
};
}  // namespace

TEST_F(PwmCommandTest, FailedRunImmediatelyStopsSignalAndLatchesFault) {
  ASSERT_TRUE(send(1800, 0.8));
  backend.results = {false};
  EXPECT_FALSE(send(2000, 1.0));
  EXPECT_EQ(command.applied_pulse_us(), 0);
  EXPECT_EQ(backend.stops, 1);
  EXPECT_TRUE(command.fault());
  EXPECT_EQ(errors, std::vector<int>({-42}));
  EXPECT_FALSE(command.needs_stop(1000));
}

TEST_F(PwmCommandTest, FaultRejectsEveryNonzeroCommandUntilRestart) {
  backend.results = {false};
  EXPECT_FALSE(send(1800, 0.8));
  EXPECT_FALSE(send(2000, 1.0));
  EXPECT_FALSE(send(0, -1.0));
  EXPECT_EQ(backend.pulses, std::vector<int>({1800}));
  EXPECT_FALSE(send(1000, 0.0));
  EXPECT_TRUE(command.fault());
  EXPECT_FALSE(send(2000, 1.0));
  EXPECT_FALSE(command.needs_stop(1000));
}

TEST_F(PwmCommandTest, StopRetriesOnceAndKeepsFaultAfterSuccess) {
  ASSERT_TRUE(send(2000, 1.0));
  backend.results = {false, true};
  EXPECT_TRUE(send(1000, 0.0));
  EXPECT_EQ(backend.pulses, std::vector<int>({2000, 1000, 1000}));
  EXPECT_EQ(command.applied_pulse_us(), 1000);
  EXPECT_TRUE(command.fault());
  EXPECT_EQ(backend.stops, 0);
}

TEST_F(PwmCommandTest, DoubleStopFailureStopsSignal) {
  ASSERT_TRUE(send(2000, 1.0));
  backend.results = {false, false};
  EXPECT_FALSE(send(1000, 0.0));
  EXPECT_EQ(backend.pulses, std::vector<int>({2000, 1000, 1000}));
  EXPECT_EQ(backend.stops, 1);
  EXPECT_EQ(command.applied_pulse_us(), 0);
  EXPECT_FALSE(command.needs_stop(1000));
  EXPECT_TRUE(command.fault());
}

TEST_F(PwmCommandTest, FailedSignalStopRetainsRunningPulseForGateRetry) {
  ASSERT_TRUE(send(2000, 1.0));
  backend.results = {false, false};
  backend.stop_ok = false;
  EXPECT_FALSE(send(1000, 0.0));
  EXPECT_EQ(command.applied_pulse_us(), 2000);
  EXPECT_TRUE(command.needs_stop(1000));
  EXPECT_EQ(errors.size(), 3u);
  EXPECT_TRUE(send(1000, 0.0));
}

TEST_F(PwmCommandTest, FailedArmNeverDeclaresReadyEvenAfterRetry) {
  backend.results = {false, true};
  EXPECT_FALSE(command.initialize(backend, 13, 1000, changed(), error()));
  EXPECT_TRUE(command.fault());
  EXPECT_EQ(command.applied_pulse_us(), 1000);
}

TEST_F(PwmCommandTest, DoubleArmFailureUsesFallbackAndNeverDeclaresReady) {
  backend.results = {false, false};
  EXPECT_FALSE(command.initialize(backend, 13, 1000, changed(), error()));
  EXPECT_TRUE(command.fault());
  EXPECT_EQ(backend.stops, 1);
  EXPECT_EQ(command.applied_pulse_us(), 0);
}

TEST_F(PwmCommandTest, SuccessfulArmDeclaresReady) {
  EXPECT_TRUE(command.initialize(backend, 13, 1000, changed(), error()));
  EXPECT_FALSE(command.fault());
}

TEST_F(PwmCommandTest, LogsOnlyRequestChangesIncludingFailedRequests) {
  EXPECT_TRUE(send(1000, 0.0));
  EXPECT_TRUE(send(1000, 0.0));
  backend.results = {false};
  backend.stop_ok = false;
  EXPECT_FALSE(send(2000, 1.0));
  EXPECT_TRUE(send(1000, 0.0));
  EXPECT_TRUE(send(1000, 0.0));
  ASSERT_EQ(changes.size(), 3u);
  EXPECT_EQ(changes[0], std::make_tuple(-1, 1000, 0.0));
  EXPECT_EQ(changes[1], std::make_tuple(1000, 2000, 1.0));
  EXPECT_EQ(changes[2], std::make_tuple(2000, 1000, 0.0));
}

TEST(PwmConfigurationTest, ValidAndInvalidLgpioPulseWidths) {
  using esc_motor_control_cpp::PwmCommand;
  for (int pulse : {0, 500, 1000, 2000, 2500}) EXPECT_TRUE(PwmCommand::valid_pulse(pulse));
  for (int pulse : {-1, 1, 499, 2501}) EXPECT_FALSE(PwmCommand::valid_pulse(pulse));
}

TEST(PwmStatusTest, AddsDiagnosticsWithoutRemovingExistingKeys) {
  esc_motor_control_cpp::RollerStatus status;
  status.pwm_fault = true;
  status.applied_pulse_us = 2000;
  status.pwm_backend = "simulation";
  const auto json = esc_motor_control_cpp::rollerStatusJson(status);
  EXPECT_NE(json.find("\"pwm_fault\": true"), std::string::npos);
  EXPECT_NE(json.find("\"applied_pulse_us\": 2000"), std::string::npos);
  EXPECT_NE(json.find("\"pwm_backend\": \"simulation\""), std::string::npos);
  for (const auto* key :
       {"command", "source", "lab_accepted", "lab_locked", "estop", "authority", "lab_max_speed"}) {
    EXPECT_NE(json.find(std::string("\"") + key + "\""), std::string::npos);
  }
}

TEST_F(PwmCommandTest, LowFallbackRejectsLaterNeutralEvenForLegacyBackend) {
  ASSERT_TRUE(send(2000, 1.0));
  backend.results = {false, false};
  EXPECT_FALSE(send(1000, 0.0));
  const auto writes = backend.pulses.size();
  EXPECT_FALSE(send(1000, 0.0));
  EXPECT_FALSE(send(1800, .8));
  EXPECT_EQ(backend.pulses.size(), writes);
  EXPECT_EQ(command.applied_pulse_us(), 0);
}

TEST_F(PwmCommandTest, IntermediateInvalidPulseNeverReachesBackend) {
  ASSERT_TRUE(send(1000, 0));
  EXPECT_FALSE(send(250, -.75));
  EXPECT_EQ(backend.pulses, std::vector<int>({1000}));
  EXPECT_EQ(backend.stops, 1);
  EXPECT_EQ(command.applied_pulse_us(), 0);
  EXPECT_TRUE(command.fault());
  EXPECT_FALSE(send(1000, 0));
}
