// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// DdtMotorLib with serial write failures injected (no motor, no hardware): a pseudo terminal
// stands in for /dev/ttyACM0 so the library opens a real descriptor, and a subclass decides
// whether each write succeeds and records the frames that would have gone out. No feedback arrives
// (unless a test sets answer_fd), so the idle feedback refresh always sees stale feedback.
#include <gtest/gtest.h>
#include <pty.h>
#include <unistd.h>

#include <cstdint>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "motor_control_lib/ddt_motor_lib.hpp"
#include "motor_control_lib/ddt_protocol.hpp"
#include "motor_control_lib/differential_drive.hpp"

namespace {

using motor_control_lib::ControlMode;
using motor_control_lib::DdtMotorLib;
using motor_control_lib::ddt_protocol::isZeroCommandFrame;

class FaultyDdtMotorLib : public DdtMotorLib {
public:
  using DdtMotorLib::DdtMotorLib;

  bool fail_writes{false};
  std::vector<std::vector<uint8_t>> writes;
  // >= 0: answer each motion frame with a feedback frame (speed 0) written to this pty master.
  int answer_fd{-1};
  uint8_t answer_mode{0x01};
  uint8_t answer_fault{0};
  bool corrupt_crc{false};
  bool wrong_id{false};
  std::set<int> silent;
  bool simulated_clock{false};
  void advance(std::chrono::milliseconds duration) { test_now_ += duration; }

protected:
  std::chrono::steady_clock::time_point controlNow() const override {
    return simulated_clock ? test_now_ : DdtMotorLib::controlNow();
  }
  std::chrono::steady_clock::time_point test_now_{std::chrono::seconds(1000)};
  ssize_t writeSerial(const void* data, size_t size) override {
    if (fail_writes) {
      return -1;  // e.g. EIO after the motor power was cut
    }
    const auto* bytes = static_cast<const uint8_t*>(data);
    writes.emplace_back(bytes, bytes + size);
    if (answer_fd >= 0 && size == 10 && bytes[1] == 0x64 && silent.count(bytes[0]) == 0) {
      std::vector<uint8_t> frame = {static_cast<uint8_t>(wrong_id ? 9 : bytes[0]),
                                    answer_mode,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    0,
                                    answer_fault};
      frame.push_back(motor_control_lib::ddt_protocol::crc8Maxim(frame));
      if (corrupt_crc) frame.back() ^= 0xFF;
      if (write(answer_fd, frame.data(), frame.size()) != static_cast<ssize_t>(frame.size())) {
        return -1;
      }
    }
    return static_cast<ssize_t>(size);
  }
};

class PseudoTerminal {
public:
  PseudoTerminal() {
    char name[256] = {};
    if (openpty(&master_, &slave_, name, nullptr, nullptr) == 0) {
      path_ = name;
    }
  }
  ~PseudoTerminal() {
    if (slave_ >= 0) close(slave_);
    if (master_ >= 0) close(master_);
  }
  const std::string& path() const { return path_; }
  int master() const { return master_; }

private:
  int master_{-1};
  int slave_{-1};
  std::string path_;
};

constexpr int kLeft = 4;
constexpr int kRight = 5;

class DdtFaultInjection : public ::testing::Test {
protected:
  void SetUp() override {
    ASSERT_FALSE(pty_.path().empty()) << "openpty failed";
    lib_ = std::make_shared<FaultyDdtMotorLib>(pty_.path(), 115200);
    lib_->simulated_clock = true;
    lib_->answer_fd = pty_.master();
    lib_->answer_mode = 0x02;
    lib_->setMaxRpm(475);
    lib_->setStopResendIntervalMs(0);  // no throttle: a refresh that may send, sends
    ASSERT_TRUE(lib_->initialize());
    ASSERT_TRUE(lib_->initializeMotor(kLeft, ControlMode::Velocity));
    ASSERT_TRUE(lib_->initializeMotor(kRight, ControlMode::Velocity));
    lib_->writes.clear();
  }

  // What an idle tick sends for feedback (drive_component's kIdle branch).
  std::vector<std::vector<uint8_t>> idleRefresh(int motor_id) {
    lib_->writes.clear();
    lib_->refreshMotorFeedback(motor_id, 0.0);
    return lib_->writes;
  }

  PseudoTerminal pty_;
  std::shared_ptr<FaultyDdtMotorLib> lib_;
};

// The real read/parse path decides validity; no private state is injected.
TEST_F(DdtFaultInjection, VelocityThirdMissStopsAllAndBlocksHeldTargets) {
  motor_control_lib::DifferentialDrive drive(lib_, kLeft, kRight, 0.1, 0.5);
  ASSERT_TRUE(drive.setWheelRpm(120, -120));
  lib_->silent.insert(kRight);
  for (int i = 0; i < 2; ++i) {
    ASSERT_TRUE(drive.setWheelRpm(120, -120));
    EXPECT_FALSE(lib_->velocityLinkLatched());
    EXPECT_TRUE(lib_->isHealthy());
    EXPECT_TRUE(drive.isHealthy());
  }
  ASSERT_TRUE(drive.setWheelRpm(120, -120));
  EXPECT_TRUE(lib_->velocityLinkLatched());
  EXPECT_FALSE(lib_->currentLinkLatched());
  EXPECT_FALSE(lib_->isHealthy());
  EXPECT_FALSE(drive.isHealthy());
  EXPECT_TRUE(drive.lastSentIsZero());
  lib_->writes.clear();
  for (int i = 0; i < 10; ++i) ASSERT_TRUE(drive.setWheelRpm(120, -120));
  ASSERT_FALSE(lib_->writes.empty());
  for (const auto& frame : lib_->writes) EXPECT_TRUE(isZeroCommandFrame(frame));
  EXPECT_TRUE(lib_->velocityLinkLatched());
}

TEST_F(DdtFaultInjection, VelocityFirstNonzeroWithoutFeedbackWaitsWithoutLatching) {
  lib_->silent.insert(kRight);
  ASSERT_TRUE(lib_->initializeMotor(kRight, ControlMode::Velocity));
  lib_->writes.clear();
  motor_control_lib::DifferentialDrive drive(lib_, kLeft, kRight, 0.1, 0.5);
  ASSERT_TRUE(drive.setWheelRpm(120, -120));  // even the first (healthy) wheel must stay zero
  EXPECT_FALSE(lib_->velocityLinkLatched());
  EXPECT_TRUE(lib_->velocityFeedbackWaiting());
  EXPECT_FALSE(lib_->isHealthy());
  EXPECT_FALSE(drive.isHealthy());
  ASSERT_FALSE(lib_->writes.empty());
  for (const auto& frame : lib_->writes) EXPECT_TRUE(isZeroCommandFrame(frame));
  lib_->silent.clear();
  ASSERT_TRUE(lib_->stopMotorNow(kLeft));
  ASSERT_TRUE(lib_->stopMotorNow(kRight));
  EXPECT_FALSE(lib_->velocityFeedbackWaiting());
  EXPECT_TRUE(lib_->isHealthy());
}

TEST_F(DdtFaultInjection, VelocityGateAllowsTwoMissedIdleRepliesAndUsesOneSecondBoundary) {
  EXPECT_DOUBLE_EQ(DdtMotorLib::kVelocityFeedbackMaxAgeSec, 1.0);
  for (int age_ms : {320, 640, 960, 1000}) {
    // Both wheels start with fresh replies, then the controlled clock ages them equally.
    ASSERT_TRUE(lib_->stopMotorNow(kLeft));
    ASSERT_TRUE(lib_->stopMotorNow(kRight));
    lib_->advance(std::chrono::milliseconds(age_ms));
    lib_->writes.clear();
    ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 120));
    EXPECT_FALSE(lib_->velocityFeedbackWaiting()) << age_ms;
    EXPECT_TRUE(lib_->isHealthy()) << age_ms;
    ASSERT_EQ(lib_->writes.size(), 1u);
    EXPECT_FALSE(isZeroCommandFrame(lib_->writes.front())) << age_ms;
  }
  ASSERT_TRUE(lib_->stopMotorNow(kLeft));
  ASSERT_TRUE(lib_->stopMotorNow(kRight));
  lib_->advance(std::chrono::milliseconds(1001));
  lib_->silent.insert(kLeft);
  lib_->silent.insert(kRight);
  lib_->writes.clear();
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 120));
  EXPECT_TRUE(lib_->velocityFeedbackWaiting());
  EXPECT_FALSE(lib_->velocityLinkLatched());
  EXPECT_FALSE(lib_->isHealthy());
  for (const auto& frame : lib_->writes) EXPECT_TRUE(isZeroCommandFrame(frame));
  lib_->silent.clear();
  ASSERT_TRUE(lib_->stopMotorNow(kLeft));
  EXPECT_FALSE(lib_->isHealthy());  // right still waiting
  ASSERT_TRUE(lib_->stopMotorNow(kRight));
  EXPECT_TRUE(lib_->isHealthy());
}

TEST_F(DdtFaultInjection, VelocityImmediateZeroAnswerCannotHideGateClosureFromTheNextTick) {
  lib_->advance(std::chrono::milliseconds(1001));
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 120));  // zero is answered immediately
  EXPECT_TRUE(lib_->velocityFeedbackWaiting());
  EXPECT_FALSE(lib_->isHealthy());
  EXPECT_FALSE(lib_->velocityLinkLatched());
  for (int i = 0; i < 4; ++i) ASSERT_TRUE(lib_->setMotorVelocity(kRight, -120));
  for (const auto& frame : lib_->writes) EXPECT_TRUE(isZeroCommandFrame(frame));
  ASSERT_TRUE(lib_->stopMotorNow(kLeft));
  ASSERT_TRUE(lib_->stopMotorNow(kRight));
  EXPECT_TRUE(lib_->isHealthy());
}

TEST_F(DdtFaultInjection, VelocityGateCannotDisappearWithinMixedZeroAndNonzeroWheelCommands) {
  motor_control_lib::DifferentialDrive drive(lib_, kLeft, kRight, 0.1, 0.5);
  for (bool left_moves : {true, false}) {
    // Only the stationary wheel is stale when the first (moving) wheel is commanded.
    lib_->advance(std::chrono::milliseconds(1001));
    if (left_moves) {
      ASSERT_TRUE(lib_->stopMotorNow(kLeft));
    }
    lib_->writes.clear();
    ASSERT_TRUE(drive.setWheelRpm(left_moves ? 120 : 0, left_moves ? 0 : -120));
    EXPECT_TRUE(lib_->velocityFeedbackWaiting());
    EXPECT_FALSE(drive.isHealthy());
    EXPECT_FALSE(lib_->velocityLinkLatched());
    for (const auto& frame : lib_->writes) EXPECT_TRUE(isZeroCommandFrame(frame));
    ASSERT_TRUE(drive.stopNow());  // the existing next-tick fault-stop can now reopen the gate
    EXPECT_FALSE(lib_->velocityFeedbackWaiting());
    EXPECT_TRUE(drive.isHealthy());
  }
}

TEST_F(DdtFaultInjection, VelocityGateRejectsWrongModeFaultCrcAndWrongIdUntilHealthyZeroAnswer) {
  for (int invalid = 0; invalid < 4; ++invalid) {
    lib_->resetVelocityFeedbackGate();
    ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 120));
    ASSERT_TRUE(lib_->velocityFeedbackWaiting());
    lib_->answer_mode = invalid == 0 ? 0x01 : 0x02;
    lib_->answer_fault = invalid == 1 ? 1 : 0;
    lib_->corrupt_crc = invalid == 2;
    lib_->wrong_id = invalid == 3;
    ASSERT_TRUE(lib_->stopMotorNow(kLeft));
    ASSERT_TRUE(lib_->stopMotorNow(kRight));
    EXPECT_TRUE(lib_->velocityFeedbackWaiting());
    EXPECT_FALSE(lib_->isHealthy());
    EXPECT_FALSE(lib_->velocityLinkLatched());
    lib_->answer_mode = 0x02;
    lib_->answer_fault = 0;
    lib_->corrupt_crc = false;
    lib_->wrong_id = false;
    ASSERT_TRUE(lib_->stopMotorNow(kLeft));
    ASSERT_TRUE(lib_->stopMotorNow(kRight));
    EXPECT_TRUE(lib_->isHealthy());
  }
}

TEST_F(DdtFaultInjection, VelocityNewSessionCannotReusePreviouslyValidFeedback) {
  lib_->resetVelocityFeedbackGate();
  lib_->silent.insert(kLeft);
  lib_->writes.clear();
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 120));
  EXPECT_TRUE(lib_->velocityFeedbackWaiting());
  EXPECT_FALSE(lib_->velocityLinkLatched());
  for (const auto& frame : lib_->writes) EXPECT_TRUE(isZeroCommandFrame(frame));
}

TEST_F(DdtFaultInjection, VelocityRecoveryRequiresThreePerWheelAndNonzeroRestartsBothCounts) {
  lib_->silent.insert(kRight);
  for (int i = 0; i < 3; ++i) ASSERT_TRUE(lib_->setMotorVelocity(kRight, 120));
  ASSERT_TRUE(lib_->velocityLinkLatched());
  lib_->silent.clear();
  for (int i = 0; i < 2; ++i) {
    ASSERT_TRUE(lib_->stopMotorNow(kLeft));
    ASSERT_TRUE(lib_->stopMotorNow(kRight));
  }
  ASSERT_TRUE(lib_->velocityLinkLatched());
  ASSERT_TRUE(lib_->setMotorVelocity(kRight, -120));  // rejected, not a recovery answer
  for (int i = 0; i < 3; ++i) ASSERT_TRUE(lib_->stopMotorNow(kLeft));
  for (int i = 0; i < 2; ++i) ASSERT_TRUE(lib_->stopMotorNow(kRight));
  EXPECT_TRUE(lib_->velocityLinkLatched());
  ASSERT_TRUE(lib_->stopMotorNow(kRight));
  EXPECT_FALSE(lib_->velocityLinkLatched());
  EXPECT_TRUE(lib_->isHealthy());
  lib_->writes.clear();
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 120));
  ASSERT_EQ(lib_->writes.size(), 1u);
  EXPECT_FALSE(isZeroCommandFrame(lib_->writes.front()));
}

TEST_F(DdtFaultInjection, VelocityRecoveryRejectsWrongModeFaultCrcAndWrongId) {
  lib_->silent.insert(kRight);
  for (int i = 0; i < 3; ++i) ASSERT_TRUE(lib_->setMotorVelocity(kRight, 120));
  lib_->silent.clear();
  for (int invalid = 0; invalid < 4; ++invalid) {
    for (int i = 0; i < 2; ++i) {
      ASSERT_TRUE(lib_->stopMotorNow(kLeft));
      ASSERT_TRUE(lib_->stopMotorNow(kRight));
    }
    lib_->answer_mode = invalid == 0 ? 0x01 : 0x02;
    lib_->answer_fault = invalid == 1 ? 1 : 0;
    lib_->corrupt_crc = invalid == 2;
    lib_->wrong_id = invalid == 3;
    ASSERT_TRUE(lib_->stopMotorNow(kRight));
    lib_->answer_mode = 0x02;
    lib_->answer_fault = 0;
    lib_->corrupt_crc = false;
    lib_->wrong_id = false;
    for (int i = 0; i < 2; ++i) {
      ASSERT_TRUE(lib_->stopMotorNow(kLeft));
      ASSERT_TRUE(lib_->stopMotorNow(kRight));
      EXPECT_TRUE(lib_->velocityLinkLatched());
    }
    // Reset all recovery counts for the next invalid case.
    ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 120));
  }
  for (int i = 0; i < 3; ++i) {
    ASSERT_TRUE(lib_->stopMotorNow(kLeft));
    ASSERT_TRUE(lib_->stopMotorNow(kRight));
  }
  EXPECT_FALSE(lib_->velocityLinkLatched());
}

TEST_F(DdtFaultInjection, VelocityRejectedTargetCannotCompleteAsymmetricRecovery) {
  for (int first : {kLeft, kRight}) {
    const int second = first == kLeft ? kRight : kLeft;
    lib_->silent.insert(first);
    for (int i = 0; i < 3; ++i) ASSERT_TRUE(lib_->setMotorVelocity(first, 120));
    ASSERT_TRUE(lib_->velocityLinkLatched());
    lib_->silent.clear();
    ASSERT_TRUE(lib_->setMotorVelocity(first, 120));  // clear all counts
    for (int i = 0; i < 2; ++i) {
      ASSERT_TRUE(lib_->stopMotorNow(first));
      ASSERT_TRUE(lib_->stopMotorNow(second));
    }
    ASSERT_TRUE(lib_->stopMotorNow(second));
    ASSERT_TRUE(lib_->velocityLinkLatched());
    ASSERT_TRUE(lib_->setMotorVelocity(first, 120));
    EXPECT_TRUE(lib_->velocityLinkLatched());
    for (int i = 0; i < 2; ++i) {
      ASSERT_TRUE(lib_->stopMotorNow(first));
      ASSERT_TRUE(lib_->stopMotorNow(second));
      EXPECT_TRUE(lib_->velocityLinkLatched());
    }
    ASSERT_TRUE(lib_->stopMotorNow(first));
    EXPECT_TRUE(lib_->velocityLinkLatched());
    ASSERT_TRUE(lib_->stopMotorNow(second));
    EXPECT_FALSE(lib_->velocityLinkLatched());
  }
}

TEST_F(DdtFaultInjection, VelocityThrottleDoesNotCountSkippedStopsOrBypassInitialStop) {
  lib_->setStopResendIntervalMs(10000);
  ASSERT_TRUE(lib_->stopMotor(kRight));
  lib_->silent.insert(kRight);
  lib_->writes.clear();
  for (int i = 0; i < 10; ++i) ASSERT_TRUE(lib_->stopMotor(kRight));
  EXPECT_TRUE(lib_->writes.empty());
  EXPECT_FALSE(lib_->velocityLinkLatched());
  for (int i = 0; i < 3; ++i) ASSERT_TRUE(lib_->setMotorVelocity(kRight, 120));
  EXPECT_TRUE(lib_->velocityLinkLatched());
  EXPECT_TRUE(lib_->lastSentFrameIsZero(kRight));
  EXPECT_TRUE(lib_->lastSentFrameIsZero(kLeft));
  lib_->writes.clear();
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 120));
  ASSERT_EQ(lib_->writes.size(), 1u);
  EXPECT_TRUE(isZeroCommandFrame(lib_->writes.front()));
}

TEST_F(DdtFaultInjection, VelocityIsolatedMissesNeverLatch) {
  for (int i = 0; i < 145; ++i) {
    lib_->silent.insert(kRight);
    ASSERT_TRUE(lib_->setMotorVelocity(kRight, -120));
    lib_->silent.clear();
    ASSERT_TRUE(lib_->setMotorVelocity(kRight, -120));
    EXPECT_FALSE(lib_->velocityLinkLatched());
  }
}

TEST_F(DdtFaultInjection, VelocityCrcAndWrongIdCountAsMisses) {
  lib_->corrupt_crc = true;
  ASSERT_TRUE(lib_->setMotorVelocity(kRight, 120));
  lib_->corrupt_crc = false;
  lib_->wrong_id = true;
  ASSERT_TRUE(lib_->setMotorVelocity(kRight, 120));
  EXPECT_FALSE(lib_->velocityLinkLatched());
  ASSERT_TRUE(lib_->setMotorVelocity(kRight, 120));
  EXPECT_TRUE(lib_->velocityLinkLatched());
  EXPECT_FALSE(lib_->isHealthy());
}

TEST_F(DdtFaultInjection, VelocityIdleAndStopMissesNeverLatchOrMakeHealthyIdleUnhealthy) {
  lib_->silent.insert(kLeft);
  lib_->silent.insert(kRight);
  for (int i = 0; i < 4; ++i) {
    lib_->advance(std::chrono::milliseconds(320));
    ASSERT_TRUE(lib_->stopMotor(kLeft));
    ASSERT_TRUE(lib_->stopMotorNow(kRight));
    lib_->refreshMotorFeedback(kLeft, 0.0);
    lib_->refreshMotorFeedback(kRight, 0.0);
    EXPECT_FALSE(lib_->velocityLinkLatched());
    EXPECT_FALSE(lib_->velocityFeedbackWaiting());
    EXPECT_TRUE(lib_->isHealthy());
  }
  // A new nonzero request uses the gate instead of counting the preceding stopped misses.
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 120));
  EXPECT_FALSE(lib_->velocityLinkLatched());
  EXPECT_TRUE(lib_->velocityFeedbackWaiting());
}

TEST_F(DdtFaultInjection, VelocityStoppedMissesDoNotAdvanceOrEraseDrivingMisses) {
  lib_->silent.insert(kRight);
  for (int i = 0; i < 2; ++i) ASSERT_TRUE(lib_->setMotorVelocity(kRight, 120));
  for (int i = 0; i < 4; ++i) {
    ASSERT_TRUE(lib_->stopMotorNow(kRight));
    EXPECT_FALSE(lib_->velocityLinkLatched());
    EXPECT_TRUE(lib_->isHealthy());
  }
  ASSERT_TRUE(lib_->setMotorVelocity(kRight, 120));  // the third nonzero exchange without an answer
  EXPECT_TRUE(lib_->velocityLinkLatched());
}

TEST_F(DdtFaultInjection, VelocityAnsweredStopClearsDrivingMisses) {
  lib_->silent.insert(kRight);
  for (int i = 0; i < 2; ++i) ASSERT_TRUE(lib_->setMotorVelocity(kRight, 120));
  lib_->silent.clear();
  ASSERT_TRUE(lib_->stopMotorNow(kRight));  // fresh evidence ends the missing-answer streak
  lib_->silent.insert(kRight);
  for (int i = 0; i < 2; ++i) ASSERT_TRUE(lib_->setMotorVelocity(kRight, 120));
  EXPECT_FALSE(lib_->velocityLinkLatched());
  EXPECT_TRUE(lib_->isHealthy());
}

TEST_F(DdtFaultInjection, VelocityShutdownClearsLatchAndWaitingState) {
  lib_->silent.insert(kRight);
  for (int i = 0; i < 3; ++i) ASSERT_TRUE(lib_->setMotorVelocity(kRight, 120));
  ASSERT_TRUE(lib_->velocityLinkLatched());
  lib_->shutdown();
  EXPECT_FALSE(lib_->velocityLinkLatched());
  lib_->silent.clear();
  ASSERT_TRUE(lib_->initialize());
  ASSERT_TRUE(lib_->initializeMotor(kLeft));
  lib_->resetVelocityFeedbackGate();
  lib_->silent.insert(kLeft);
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 120));
  ASSERT_TRUE(lib_->velocityFeedbackWaiting());
  lib_->shutdown();
  EXPECT_FALSE(lib_->velocityFeedbackWaiting());
  EXPECT_FALSE(lib_->velocityLinkLatched());
}

// Nonzero, then a zero that was sent: idle refresh re-sends only that zero.
TEST_F(DdtFaultInjection, SuccessfulZeroIsTheOnlyFrameIdleRefreshSends) {
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 120));
  ASSERT_TRUE(lib_->stopMotorNow(kLeft));
  EXPECT_TRUE(lib_->lastSentFrameIsZero(kLeft));
  const auto sent = idleRefresh(kLeft);
  ASSERT_EQ(sent.size(), 1u);
  EXPECT_TRUE(isZeroCommandFrame(sent[0]));
}

// Nonzero, then the zero could not be written: the cache is not faked as zero and idle refresh
// never replays the nonzero frame.
TEST_F(DdtFaultInjection, FailedZeroNeverReplaysTheNonzeroFrame) {
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 120));
  lib_->fail_writes = true;
  EXPECT_FALSE(lib_->stopMotorNow(kLeft));
  EXPECT_FALSE(lib_->lastSentFrameIsZero(kLeft));
  lib_->fail_writes = false;
  EXPECT_TRUE(idleRefresh(kLeft).empty());
  EXPECT_TRUE(idleRefresh(kLeft).empty());
  // The throttled stop path does not treat it as stopped either: it sends the zero again.
  lib_->writes.clear();
  EXPECT_TRUE(lib_->stopMotor(kLeft));
  ASSERT_EQ(lib_->writes.size(), 1u);
  EXPECT_TRUE(isZeroCommandFrame(lib_->writes[0]));
}

// A safe-zero recovery clears the condition; still nothing but a zero goes out afterwards.
TEST_F(DdtFaultInjection, ZeroRecoveryAfterAFailureRestoresOnlyTheZeroRefresh) {
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 120));
  lib_->fail_writes = true;
  EXPECT_FALSE(lib_->stopMotorNow(kLeft));
  lib_->fail_writes = false;
  EXPECT_TRUE(lib_->stopMotorNow(kLeft));
  EXPECT_TRUE(lib_->lastSentFrameIsZero(kLeft));
  const auto sent = idleRefresh(kLeft);
  ASSERT_EQ(sent.size(), 1u);
  EXPECT_TRUE(isZeroCommandFrame(sent[0]));
}

// No frame ever sent to this motor (never initialized): idle refresh sends nothing.
TEST_F(DdtFaultInjection, NoCacheMeansNoIdleFrame) { EXPECT_TRUE(idleRefresh(9).empty()); }

// Priming failed at initialization: nothing cached, nothing sent for feedback.
TEST(DdtFaultInjectionInit, FailedPrimingLeavesNoFrameToRefresh) {
  PseudoTerminal pty;
  ASSERT_FALSE(pty.path().empty());
  FaultyDdtMotorLib lib(pty.path(), 115200);
  ASSERT_TRUE(lib.initialize());
  lib.fail_writes = true;
  lib.initializeMotor(kLeft, ControlMode::Velocity);  // the mode frame or the priming fails
  lib.fail_writes = false;
  lib.writes.clear();
  EXPECT_FALSE(lib.lastSentFrameIsZero(kLeft));
  lib.refreshMotorFeedback(kLeft, 0.2);
  EXPECT_TRUE(lib.writes.empty());
}

// Current mode: the same rule for the current frame (nonzero current is never replayed).
TEST(DdtFaultInjectionCurrent, FailedZeroNeverReplaysANonzeroCurrent) {
  PseudoTerminal pty;
  ASSERT_FALSE(pty.path().empty());
  FaultyDdtMotorLib lib(pty.path(), 115200);
  lib.answer_fd = pty.master();  // current mode sends a nonzero current only with fresh feedback
  // Back-to-back answers on the real clock give no 10-40 ms intervals for the speed from the
  // position; this test is about the replayed frame, so the PI runs on the reported speed.
  lib.setCurrentMeasuredSource(motor_control_lib::CurrentMeasuredSource::Reported);
  lib.setMaxRpm(475);
  lib.setStopResendIntervalMs(0);
  lib.setCurrentControlParams(0.001, 0.0, 1.0, 0.3);
  ASSERT_TRUE(lib.initialize());
  ASSERT_TRUE(lib.initializeMotor(kLeft, ControlMode::Current));
  ASSERT_TRUE(lib.setMotorVelocity(kLeft, 200));
  EXPECT_FALSE(lib.lastSentFrameIsZero(kLeft));  // a nonzero current went out
  lib.answer_fd = -1;
  lib.fail_writes = true;
  EXPECT_FALSE(lib.stopMotorNow(kLeft));
  lib.fail_writes = false;
  lib.writes.clear();
  lib.refreshMotorFeedback(kLeft, 0.0);  // max age 0: the held feedback always counts as stale
  EXPECT_TRUE(lib.writes.empty());
  EXPECT_TRUE(lib.stopMotorNow(kLeft));
  lib.writes.clear();
  lib.refreshMotorFeedback(kLeft, 0.0);
  ASSERT_EQ(lib.writes.size(), 1u);
  EXPECT_TRUE(isZeroCommandFrame(lib.writes[0]));
}

// Current mode without any answer: the current loop cannot be confirmed, so current mode does not
// start, and nothing but zeros went out.
TEST(DdtFaultInjectionCurrent, NoAnswerRefusesCurrentMode) {
  PseudoTerminal pty;
  ASSERT_FALSE(pty.path().empty());
  FaultyDdtMotorLib lib(pty.path(), 115200);
  lib.setMaxRpm(475);
  lib.setCurrentControlParams(0.01, 0.0, 1.0, 0.3);
  ASSERT_TRUE(lib.initialize());
  EXPECT_FALSE(lib.initializeMotor(kLeft, ControlMode::Current));
  for (const auto& frame : lib.writes) {
    if (frame[1] == 0x64) {
      EXPECT_TRUE(isZeroCommandFrame(frame));
    }
  }
}

// The drive's safety stop reports a failure on either wheel and always tries both.
TEST_F(DdtFaultInjection, DifferentialStopNowReportsFailureAndTriesBothWheels) {
  motor_control_lib::DifferentialDrive drive(lib_, kLeft, kRight, 0.1, 0.5);
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 100));
  ASSERT_TRUE(lib_->setMotorVelocity(kRight, -100));
  lib_->fail_writes = true;
  EXPECT_FALSE(drive.stopNow());
  EXPECT_FALSE(drive.lastSentIsZero());
  lib_->fail_writes = false;
  lib_->writes.clear();
  EXPECT_TRUE(drive.stopNow());
  EXPECT_EQ(lib_->writes.size(), 2u);  // one zero per wheel, unthrottled
  EXPECT_TRUE(drive.lastSentIsZero());
}

}  // namespace
