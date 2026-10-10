// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <deque>
#include <vector>

#include "questix_pwm_guard/core.hpp"
#include "questix_pwm_guard/protocol.hpp"
namespace q = questix_pwm_guard;
class Output : public q::Output {
public:
  bool write_pulse(int us) override {
    writes.push_back(us);
    bool ok = results.empty() || results.front();
    if (!results.empty()) results.pop_front();
    return ok;
  }
  int error() const override { return -EIO; }
  std::vector<int> writes;
  std::deque<bool> results;
};
struct GuardTest : testing::Test {
  Output out;
  q::Core core{out};
  void active() {
    ASSERT_TRUE(core.start());
    ASSERT_TRUE(core.authorize(0));
    ASSERT_TRUE(core.arm(42, 0));
    ASSERT_TRUE(core.complete(42, 1, 2000));
  }
};
TEST_F(GuardTest, NoAutomaticArmAndTicketExpires) {
  ASSERT_TRUE(core.start());
  EXPECT_FALSE(core.arm(42, 0));
  ASSERT_TRUE(core.authorize(0));
  EXPECT_FALSE(core.arm(42, 30000));
  EXPECT_EQ(out.writes.back(), 0);
}
TEST_F(GuardTest, ArmDeadlineCannotBeExtendedByNeutral) {
  core.start();
  core.authorize(0);
  ASSERT_TRUE(core.arm(42, 0));
  EXPECT_TRUE(core.command(42, 1, 1000, 2900));
  core.tick(3000);
  EXPECT_EQ(core.state(), q::State::FaultLow);
  EXPECT_FALSE(core.complete(42, 2, 3000));
  EXPECT_EQ(out.writes.back(), 0);
}
TEST_F(GuardTest, LeaseExpiryWinsOverQueuedCommand) {
  active();
  ASSERT_TRUE(core.command(42, 2, 1800, 2100));
  EXPECT_FALSE(core.command(42, 3, 1800, 3100));
  EXPECT_EQ(core.state(), q::State::FaultLow);
  EXPECT_EQ(core.applied(), 0);
  EXPECT_EQ(core.fault_error(), -ETIMEDOUT);
}
TEST_F(GuardTest, DrainFixedDeadlineAndOldCommandsCannotResume) {
  active();
  ASSERT_TRUE(core.command(42, 2, 1800, 2100));
  ASSERT_TRUE(core.shutdown(42, 3, 2200));
  EXPECT_FALSE(core.command(42, 4, 1000, 2250));
  EXPECT_TRUE(core.shutdown(42, 5, 2400));
  core.disconnected(2400);
  core.tick(2699);
  EXPECT_EQ(core.state(), q::State::Draining);
  core.tick(2700);
  EXPECT_EQ(core.state(), q::State::TerminalLow);
  EXPECT_FALSE(core.command(42, 6, 1000, 2800));
  EXPECT_EQ(out.writes.back(), 0);
}
TEST_F(GuardTest, UnexpectedDisconnectHasNoDrain) {
  active();
  core.command(42, 2, 1800, 2100);
  core.disconnected(2101);
  EXPECT_EQ(core.state(), q::State::FaultLow);
  EXPECT_EQ(out.writes.back(), 0);
}
TEST_F(GuardTest, SequenceAndGenerationRejectReplay) {
  active();
  EXPECT_FALSE(core.command(41, 2, 1800, 2100));
  EXPECT_FALSE(core.command(42, 1, 1800, 2100));
  ASSERT_TRUE(core.command(42, 2, 1800, 2100));
  EXPECT_FALSE(core.command(42, 2, 2000, 2101));
  EXPECT_EQ(core.applied(), 1800);
}
TEST_F(GuardTest, WriteFailureStopsAndLatchedCauseSurvivesStop) {
  active();
  out.results = {false, true};
  EXPECT_FALSE(core.command(42, 2, 1800, 2100));
  EXPECT_EQ(core.state(), q::State::FaultLow);
  EXPECT_EQ(core.fault_error(), -EIO);
  ASSERT_TRUE(core.stop(42, 3, 2200));
  EXPECT_EQ(core.state(), q::State::FaultLow);
  EXPECT_FALSE(core.command(42, 4, 1000, 2300));
  EXPECT_EQ(core.fault_error(), -EIO);
}
TEST_F(GuardTest, FailedLowIsUnknownAndCannotAuthorize) {
  active();
  out.results = {false, false};
  EXPECT_FALSE(core.command(42, 2, 1800, 2100));
  EXPECT_EQ(core.state(), q::State::FaultUnknown);
  EXPECT_EQ(core.applied(), -1);
  EXPECT_FALSE(core.authorize(2200));
}
TEST_F(GuardTest, InvalidPulseFailsClosedAndManualRecoveryIsRequired) {
  active();
  EXPECT_FALSE(core.command(42, 2, 499, 2100));
  EXPECT_EQ(core.applied(), 0);
  EXPECT_EQ(core.state(), q::State::FaultLow);
  EXPECT_FALSE(core.arm(43, 2200));
  ASSERT_TRUE(core.authorize(2300));
  ASSERT_TRUE(core.arm(43, 2300));
  EXPECT_FALSE(core.command(42, 3, 1000, 2400));
}
TEST(GuardProtocol, StrictUnsignedVersionedFields) {
  q::Request r;
  EXPECT_TRUE(q::parse_request("1 COMMAND 42 2 1800", r));
  for (const auto& s : {"2 ARM 0 0 0", "1 ARM -1 0 0", "1 ARM 0 +1 0", "1 COMMAND 42 2 1800 extra",
                        "1 BOGUS 0 0 0", "1 ARM 18446744073709551616 0 0"})
    EXPECT_FALSE(q::parse_request(s, r));
}
