// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// DdtMotorLib with serial write failures injected (no motor, no hardware): a pseudo terminal
// stands in for /dev/ttyACM0 so the library opens a real descriptor, and a subclass decides
// whether each write succeeds and records the frames that would have gone out. No feedback ever
// arrives, so the idle feedback refresh always sees stale feedback.
#include <gtest/gtest.h>
#include <pty.h>
#include <unistd.h>

#include <cstdint>
#include <memory>
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

protected:
  ssize_t writeSerial(const void* data, size_t size) override {
    if (fail_writes) {
      return -1;  // e.g. EIO after the motor power was cut
    }
    const auto* bytes = static_cast<const uint8_t*>(data);
    writes.emplace_back(bytes, bytes + size);
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
    lib_->refreshMotorFeedback(motor_id, 0.2);
    return lib_->writes;
  }

  PseudoTerminal pty_;
  std::shared_ptr<FaultyDdtMotorLib> lib_;
};

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
  lib.setMaxRpm(475);
  lib.setStopResendIntervalMs(0);
  lib.setCurrentControlParams(0.001, 0.0, 1.0, 0.3);
  ASSERT_TRUE(lib.initialize());
  ASSERT_TRUE(lib.initializeMotor(kLeft, ControlMode::Current));
  ASSERT_TRUE(lib.setMotorVelocity(kLeft, 200));
  EXPECT_FALSE(lib.lastSentFrameIsZero(kLeft));  // a nonzero current went out
  lib.fail_writes = true;
  EXPECT_FALSE(lib.stopMotorNow(kLeft));
  lib.fail_writes = false;
  lib.writes.clear();
  lib.refreshMotorFeedback(kLeft, 0.2);
  EXPECT_TRUE(lib.writes.empty());
  EXPECT_TRUE(lib.stopMotorNow(kLeft));
  lib.writes.clear();
  lib.refreshMotorFeedback(kLeft, 0.2);
  ASSERT_EQ(lib.writes.size(), 1u);
  EXPECT_TRUE(isZeroCommandFrame(lib.writes[0]));
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
