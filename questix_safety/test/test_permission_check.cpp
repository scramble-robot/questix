// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#include <gtest/gtest.h>

#include <limits>
#include <map>
#include <string>
#include <vector>

#include "questix_safety/motion_permission_rule.hpp"
#include "questix_safety/permission_check.hpp"

using questix_safety::decideMotionPermission;
using questix_safety::evaluatePermission;
using questix_safety::PermissionInputs;
using questix_safety::PermissionState;
using questix_safety::Vote;

namespace {

PermissionInputs allowed() {
  PermissionInputs in;
  in.known = true;
  in.allowed = true;
  in.age_sec = 0.1;
  return in;
}

Vote vote(bool drive, bool launcher, double age_sec = 0.1) {
  Vote v;
  v.known = true;
  v.drive_allowed = drive;
  v.launcher_allowed = launcher;
  v.age_sec = age_sec;
  return v;
}

using Blockers = std::vector<std::string>;

}  // namespace

TEST(PermissionCheck, NeverHeardIsUnknownAndBlocks) {
  PermissionInputs in;  // defaults: required, nothing heard
  EXPECT_EQ(evaluatePermission(in), PermissionState::kUnknown);
  EXPECT_TRUE(questix_safety::blocks(evaluatePermission(in)));
}

TEST(PermissionCheck, FreshAllowedIsAllowed) {
  EXPECT_EQ(evaluatePermission(allowed()), PermissionState::kAllowed);
  EXPECT_FALSE(questix_safety::blocks(evaluatePermission(allowed())));
}

TEST(PermissionCheck, ReceivedNotAllowedIsOff) {
  auto in = allowed();
  in.allowed = false;
  EXPECT_EQ(evaluatePermission(in), PermissionState::kOff);
}

TEST(PermissionCheck, ALeaseAlwaysExpires) {
  auto in = allowed();
  in.age_sec = 0.5;
  EXPECT_EQ(evaluatePermission(in), PermissionState::kAllowed);  // exactly the lease
  in.age_sec = 0.51;
  EXPECT_EQ(evaluatePermission(in), PermissionState::kStale);
  // Silence wins over the last "not allowed" too: stale is reported, not off.
  in.allowed = false;
  EXPECT_EQ(evaluatePermission(in), PermissionState::kStale);
  in = allowed();
  in.age_sec = std::numeric_limits<double>::quiet_NaN();
  EXPECT_EQ(evaluatePermission(in), PermissionState::kStale);
}

TEST(PermissionCheck, AnInvalidLeaseFallsBackToTheDefaultAndNeverDisablesIt) {
  for (const double timeout : {0.0, -1.0, std::numeric_limits<double>::infinity(),
                               std::numeric_limits<double>::quiet_NaN()}) {
    EXPECT_DOUBLE_EQ(questix_safety::permissionLease(timeout), 0.5);
    auto in = allowed();
    in.timeout_sec = timeout;
    in.age_sec = 0.6;
    EXPECT_EQ(evaluatePermission(in), PermissionState::kStale) << timeout;
  }
  EXPECT_DOUBLE_EQ(questix_safety::permissionLease(1.0), 1.0);
}

TEST(PermissionCheck, DiagnosticOptOutLooksAtNothing) {
  PermissionInputs in;
  in.required = false;
  EXPECT_EQ(evaluatePermission(in), PermissionState::kAllowed);
  in.known = true;
  in.allowed = false;
  EXPECT_EQ(evaluatePermission(in), PermissionState::kAllowed);
}

TEST(PermissionCheck, StateNames) {
  EXPECT_STREQ(questix_safety::permissionStateName(PermissionState::kAllowed), "allowed");
  EXPECT_STREQ(questix_safety::permissionStateName(PermissionState::kUnknown),
               "permission_unknown");
  EXPECT_STREQ(questix_safety::permissionStateName(PermissionState::kStale), "permission_stale");
  EXPECT_STREQ(questix_safety::permissionStateName(PermissionState::kOff), "permission_off");
}

TEST(MotionPermissionRule, NoRequiredVoteIsAlwaysAllowed) {
  const auto decision = decideMotionPermission({}, {}, 1.0);
  EXPECT_TRUE(decision.drive_allowed);
  EXPECT_TRUE(decision.launcher_allowed);
  EXPECT_TRUE(decision.drive_blockers.empty());
  EXPECT_TRUE(decision.launcher_blockers.empty());
}

TEST(MotionPermissionRule, AMissingVoteIsUnknownForBothFlags) {
  const auto decision = decideMotionPermission({"teacher"}, {}, 1.0);
  EXPECT_FALSE(decision.drive_allowed);
  EXPECT_FALSE(decision.launcher_allowed);
  EXPECT_EQ(decision.drive_blockers, Blockers{"teacher:unknown"});
  EXPECT_EQ(decision.launcher_blockers, Blockers{"teacher:unknown"});
}

TEST(MotionPermissionRule, ASilentVoteIsStaleForBothFlags) {
  const auto decision =
      decideMotionPermission({"referee"}, {{"referee", vote(true, true, 1.2)}}, 1.0);
  EXPECT_EQ(decision.drive_blockers, Blockers{"referee:stale"});
  EXPECT_EQ(decision.launcher_blockers, Blockers{"referee:stale"});
}

TEST(MotionPermissionRule, EachFlagFollowsItsOwnVote) {
  const auto decision = decideMotionPermission({"teacher"}, {{"teacher", vote(true, false)}}, 1.0);
  EXPECT_TRUE(decision.drive_allowed);
  EXPECT_FALSE(decision.launcher_allowed);
  EXPECT_TRUE(decision.drive_blockers.empty());
  EXPECT_EQ(decision.launcher_blockers, Blockers{"teacher:off"});
}

TEST(MotionPermissionRule, VotesThatAreNotRequiredAreIgnored) {
  // A competition robot does not need the teacher: a teacher "off" changes nothing.
  const auto decision = decideMotionPermission(
      {"referee"}, {{"referee", vote(true, true)}, {"teacher", vote(false, false)}}, 1.0);
  EXPECT_TRUE(decision.drive_allowed);
  EXPECT_TRUE(decision.launcher_allowed);
}

TEST(MotionPermissionRule, EveryRequiredVoteMustAllowAndEveryBlockerIsListed) {
  const auto decision = decideMotionPermission(
      {"teacher", "obstacle"}, {{"teacher", vote(false, true)}, {"obstacle", vote(false, false)}},
      1.0);
  EXPECT_EQ(decision.drive_blockers, (Blockers{"teacher:off", "obstacle:off"}));
  EXPECT_EQ(decision.launcher_blockers, Blockers{"obstacle:off"});
}

TEST(MotionPermissionRule, AnInvalidLeaseStillExpires) {
  const auto decision = decideMotionPermission({"referee"}, {{"referee", vote(true, true, 0.6)}},
                                               std::numeric_limits<double>::infinity());
  EXPECT_EQ(decision.drive_blockers, Blockers{"referee:stale"});
}
