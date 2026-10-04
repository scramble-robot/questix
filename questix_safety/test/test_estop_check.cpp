// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#include <gtest/gtest.h>

#include <limits>

#include "questix_safety/estop_check.hpp"

using questix_safety::EstopInputs;
using questix_safety::EstopState;
using questix_safety::evaluateEstop;

namespace {

EstopInputs released() {
  EstopInputs in;
  in.known = true;
  in.active = false;
  in.age_sec = 0.1;
  return in;
}

}  // namespace

TEST(EstopCheck, NeverHeardIsUnknownAndEngaged) {
  EstopInputs in;  // defaults: required, nothing heard
  EXPECT_EQ(evaluateEstop(in), EstopState::kUnknown);
  EXPECT_TRUE(questix_safety::engaged(evaluateEstop(in)));
}

TEST(EstopCheck, FreshReleaseIsReleased) {
  EXPECT_EQ(evaluateEstop(released()), EstopState::kReleased);
  EXPECT_FALSE(questix_safety::engaged(evaluateEstop(released())));
}

TEST(EstopCheck, ReceivedPressedIsPressedEvenWhenNotRequired) {
  auto in = released();
  in.active = true;
  EXPECT_EQ(evaluateEstop(in), EstopState::kPressed);
  in.required = false;
  EXPECT_EQ(evaluateEstop(in), EstopState::kPressed);
}

TEST(EstopCheck, SilenceAfterTheTimeoutIsStale) {
  auto in = released();
  in.age_sec = 1.0;  // exactly the timeout is still fresh
  EXPECT_EQ(evaluateEstop(in), EstopState::kReleased);
  in.age_sec = 1.01;
  EXPECT_EQ(evaluateEstop(in), EstopState::kStale);
  in.age_sec = std::numeric_limits<double>::quiet_NaN();
  EXPECT_EQ(evaluateEstop(in), EstopState::kStale);  // an unknown age is never fresh
  in.timeout_sec = 0.0;                              // staleness check disabled explicitly
  EXPECT_EQ(evaluateEstop(in), EstopState::kReleased);
}

// The diagnostic opt-out drops "unheard" and "silent", never "pressed".
TEST(EstopCheck, DiagnosticOptOutOnlyStopsOnAPressedMessage) {
  EstopInputs in;
  in.required = false;
  EXPECT_EQ(evaluateEstop(in), EstopState::kReleased);
  in = released();
  in.required = false;
  in.age_sec = 3600.0;
  EXPECT_EQ(evaluateEstop(in), EstopState::kReleased);
}

TEST(EstopCheck, NonFiniteTimeoutFallsBackToTheDefault) {
  EXPECT_DOUBLE_EQ(questix_safety::normalizeEstopTimeout(std::numeric_limits<double>::infinity()),
                   questix_safety::kDefaultEstopTimeoutSec);
  EXPECT_DOUBLE_EQ(questix_safety::normalizeEstopTimeout(std::numeric_limits<double>::quiet_NaN()),
                   questix_safety::kDefaultEstopTimeoutSec);
  EXPECT_DOUBLE_EQ(questix_safety::normalizeEstopTimeout(0.0), 0.0);  // "disabled" stays
  EXPECT_DOUBLE_EQ(questix_safety::normalizeEstopTimeout(2.5), 2.5);
}

TEST(EstopCheck, StateNamesMatchTheGateReasons) {
  EXPECT_STREQ(questix_safety::estopStateName(EstopState::kUnknown), "estop_unknown");
  EXPECT_STREQ(questix_safety::estopStateName(EstopState::kPressed), "estop_active");
  EXPECT_STREQ(questix_safety::estopStateName(EstopState::kStale), "estop_stale");
  EXPECT_STREQ(questix_safety::estopStateName(EstopState::kReleased), "released");
}
