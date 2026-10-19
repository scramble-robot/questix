// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <limits>

#include "motor_control_app/drive_rearm.hpp"

using motor_control_app::drive_rearm::Rearm;
using D = Rearm::Decision;
namespace rearm = motor_control_app::drive_rearm;

TEST(DriveRearm, StartupRejectsHeldInputUntilStrictZero) {
  Rearm r;
  EXPECT_EQ(r.command(0.1, 0, 0, 1, false, 0, 0), D::kNeedsNeutral);
  EXPECT_EQ(r.command(0, -0.0, 0.1, 1, false, 0, 0), D::kNeutral);
  EXPECT_EQ(r.command(0.1, 0, 0.2, 1, false, 0, 0), D::kAccept);
}
TEST(DriveRearm, EveryStopResetRequiresFreshNeutral) {
  for (const auto* cause : {"activate", "permission", "estop", "estop_stale", "stop_fault",
                            "command_timeout", "motor_fault"}) {
    SCOPED_TRACE(cause);
    Rearm r;
    ASSERT_EQ(r.command(0, 0, 0, 1, false, 0, 0), D::kNeutral);
    r.reset();
    EXPECT_EQ(r.command(0.1, 0, 1, 1, false, 0, 0), D::kNeedsNeutral);
    EXPECT_EQ(r.command(0, 0, 1.1, 1, false, 0, 0), D::kNeutral);
  }
}
TEST(DriveRearm, InhibitedZeroCannotRearm) {
  Rearm r;
  EXPECT_EQ(r.command(0, 0, 0, 1, true, 0, 0), D::kInhibited);
  EXPECT_EQ(r.command(0.1, 0, 0.1, 1, false, 0, 0), D::kNeedsNeutral);
}
TEST(DriveRearm, BandBoundaryAndUnfilteredSubsequentCommand) {
  Rearm r;
  EXPECT_EQ(r.command(0.05001, 0, 0, 1, false, .05, .1), D::kNeedsNeutral);
  EXPECT_EQ(r.command(0, .10001, 0, 1, false, .05, .1), D::kNeedsNeutral);
  EXPECT_EQ(r.command(-.05, .1, .1, 1, false, .05, .1), D::kNeutral);
  EXPECT_EQ(r.command(.001, .002, .2, 1, false, .05, .1), D::kAccept);
}
TEST(DriveRearm, ZeroBandRejectsArbitrarilySmallNonzero) {
  EXPECT_FALSE(rearm::neutral(1e-12, 0, 0, 0));
  EXPECT_TRUE(rearm::neutral(-0.0, 0, 0, 0));
}
TEST(DriveRearm, InvalidInputNeverRearmsOrRefreshesDeadline) {
  for (const double value :
       {std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::infinity()}) {
    Rearm r;
    EXPECT_EQ(r.command(value, 0, 0, 1, false, 0, 0), D::kInvalid);
    EXPECT_TRUE(r.needsNeutral());
    ASSERT_EQ(r.command(0, 0, 0, 1, false, 0, 0), D::kNeutral);
    EXPECT_EQ(r.command(0, value, .8, 1, false, 0, 0), D::kInvalid);
    EXPECT_TRUE(r.expired(1.1, 1));
  }
}
TEST(DriveRearm, LateCallbackCannotHideTimeoutEvenWhenNeutral) {
  Rearm r;
  ASSERT_EQ(r.command(0, 0, 0, 1, false, 0, 0), D::kNeutral);
  EXPECT_FALSE(r.expired(1, 1));
  EXPECT_EQ(r.command(.1, 0, 1.01, 1, false, 0, 0), D::kTimeout);
  EXPECT_EQ(r.command(0, 0, 1.02, 1, false, 0, 0), D::kTimeout);
  r.reset();  // control tick completed the existing timeout stop
  EXPECT_EQ(r.command(.1, 0, 1.03, 1, false, 0, 0), D::kNeedsNeutral);
  EXPECT_EQ(r.command(0, 0, 1.04, 1, false, 0, 0), D::kNeutral);
}
TEST(DriveRearm, InvalidBandsUseZeroRatherThanClamp) {
  for (const double value : {-1.0, .051, std::numeric_limits<double>::quiet_NaN(),
                             std::numeric_limits<double>::infinity()}) {
    EXPECT_FALSE(rearm::validBand(value, rearm::kMaxLinear));
    EXPECT_EQ(rearm::bandOrZero(value, rearm::kMaxLinear), 0);
  }
  EXPECT_EQ(rearm::bandOrZero(.05, rearm::kMaxLinear), .05);
  EXPECT_EQ(rearm::bandOrZero(.10001, rearm::kMaxAngular), 0);
}
