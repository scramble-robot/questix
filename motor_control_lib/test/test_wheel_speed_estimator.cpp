// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// The speed from the wheel position (Issue #222, G1): the two-interval estimate and its validity
// rules, fed with synthetic answers (no serial line, no ROS).
#include <gtest/gtest.h>

#include <cmath>
#include <cstdint>

#include "motor_control_lib/wheel_speed_estimator.hpp"

namespace {

namespace wse = motor_control_lib::wheel_speed_estimator;
using motor_control_lib::ddt_protocol::kPositionRawPerTurn;

constexpr double kTick = 0.020;

// Feeds answers of a wheel turning at a constant speed, one every `interval` seconds.
class Feeder {
public:
  explicit Feeder(double rpm, double start_turns = 0.0) : rpm_(rpm), turns_(start_turns) {}

  wse::Sample next(double interval = kTick, uint8_t mode = 0x01, uint8_t fault = 0) {
    t_ += interval;
    turns_ += rpm_ / 60.0 * interval;
    return sampleNow(mode, fault);
  }

  wse::Sample sampleNow(uint8_t mode = 0x01, uint8_t fault = 0) {
    double turn = std::fmod(turns_, 1.0);
    if (turn < 0.0) turn += 1.0;
    const auto raw =
        static_cast<uint16_t>(std::lround(turn * kPositionRawPerTurn) % kPositionRawPerTurn);
    return wse::Sample{raw, t_, ++count_, mode, fault};
  }

  double t() const { return t_; }
  uint64_t count() const { return count_; }
  void setRpm(double rpm) { rpm_ = rpm; }

private:
  double rpm_;
  double turns_;
  double t_{100.0};
  uint64_t count_{0};
};

// One turn of position is 32767 raw counts: the resolution limits how close the estimate is.
constexpr double kTolRpm = 0.5;

TEST(WheelSpeedEstimator, NeedsTwoValidIntervals) {
  wse::WheelSpeedEstimator est;
  Feeder f(100.0);
  EXPECT_EQ(est.estimate(f.t()).reason, wse::Invalid::kWarmingUp);
  est.update(f.sampleNow());
  EXPECT_FALSE(est.estimate(f.t()).valid);
  EXPECT_EQ(est.estimate(f.t()).reason, wse::Invalid::kWarmingUp);
  est.update(f.next());
  EXPECT_FALSE(est.estimate(f.t()).valid);
  est.update(f.next());
  const auto e = est.estimate(f.t());
  ASSERT_TRUE(e.valid);
  EXPECT_NEAR(e.rpm, 100.0, kTolRpm);
  EXPECT_EQ(e.reason, wse::Invalid::kNone);
  EXPECT_DOUBLE_EQ(e.age_sec, 0.0);
}

TEST(WheelSpeedEstimator, ConstantSpeedForwardAndBackward) {
  for (const double rpm : {191.0, -191.0, 5.0, -475.0}) {
    wse::WheelSpeedEstimator est;
    Feeder f(rpm, 0.3);
    est.update(f.sampleNow());
    for (int i = 0; i < 50; ++i) {
      est.update(f.next());
      if (i >= 1) {
        const auto e = est.estimate(f.t());
        ASSERT_TRUE(e.valid) << rpm;
        EXPECT_NEAR(e.rpm, rpm, kTolRpm) << rpm;
      }
    }
  }
}

// Crossing 32767 -> 0 (and back) takes the shortest difference, as #210.
TEST(WheelSpeedEstimator, WrapsAroundOneTurn) {
  for (const double rpm : {300.0, -300.0}) {
    wse::WheelSpeedEstimator est;
    Feeder f(rpm, rpm > 0 ? 0.95 : 0.05);  // a wrap within the first few answers
    est.update(f.sampleNow());
    for (int i = 0; i < 10; ++i) {
      est.update(f.next());
      if (i >= 1) {
        const auto e = est.estimate(f.t());
        ASSERT_TRUE(e.valid);
        EXPECT_NEAR(e.rpm, rpm, kTolRpm);
      }
    }
  }
  EXPECT_NEAR(wse::shortestTurns(kPositionRawPerTurn - 100, 100), 200.0 / kPositionRawPerTurn,
              1e-12);
  EXPECT_NEAR(wse::shortestTurns(100, kPositionRawPerTurn - 100), -200.0 / kPositionRawPerTurn,
              1e-12);
  EXPECT_DOUBLE_EQ(wse::shortestTurns(kPositionRawPerTurn, 0), 0.0);  // the same point
}

// The two-interval estimate uses the receive times: uneven intervals give the mean speed.
TEST(WheelSpeedEstimator, UsesTheReceiveTimes) {
  wse::WheelSpeedEstimator est;
  Feeder f(120.0);
  est.update(f.sampleNow());
  est.update(f.next(0.012));
  est.update(f.next(0.038));
  const auto e = est.estimate(f.t());
  ASSERT_TRUE(e.valid);
  EXPECT_NEAR(e.rpm, 120.0, kTolRpm);
}

TEST(WheelSpeedEstimator, RepeatedAnswerIsInvalidAndNotUsed) {
  wse::WheelSpeedEstimator est;
  Feeder f(100.0);
  est.update(f.sampleNow());
  est.update(f.next());
  est.update(f.next());
  ASSERT_TRUE(est.estimate(f.t()).valid);
  auto repeated = f.sampleNow();
  repeated.feedback_count = f.count() - 1;  // the same answer once more
  repeated.time_sec += 0.020;
  est.update(repeated);
  EXPECT_FALSE(est.estimate(f.t()).valid);
  EXPECT_EQ(est.estimate(f.t()).reason, wse::Invalid::kRepeated);
}

TEST(WheelSpeedEstimator, IntervalOutsideTenToFortyMsIsInvalid) {
  for (const double gap : {0.041, 0.060, 0.009, 0.002}) {
    wse::WheelSpeedEstimator est;
    Feeder f(100.0);
    est.update(f.sampleNow());
    est.update(f.next());
    est.update(f.next());
    ASSERT_TRUE(est.estimate(f.t()).valid);
    est.update(f.next(gap));
    const auto e = est.estimate(f.t());
    EXPECT_FALSE(e.valid) << gap;
    EXPECT_EQ(e.reason, wse::Invalid::kInterval) << gap;
  }
  // 40 ms (one lost answer) and 10 ms are still used.
  wse::WheelSpeedEstimator est;
  Feeder f(100.0);
  est.update(f.sampleNow());
  est.update(f.next(0.0399));
  est.update(f.next(0.0101));
  EXPECT_TRUE(est.estimate(f.t()).valid);
}

TEST(WheelSpeedEstimator, FaultAndModeAreInvalid) {
  wse::WheelSpeedEstimator est;
  Feeder f(100.0);
  est.update(f.sampleNow());
  est.update(f.next());
  est.update(f.next());
  ASSERT_TRUE(est.estimate(f.t()).valid);
  est.update(f.next(kTick, 0x01, /*fault=*/0x02));
  EXPECT_EQ(est.estimate(f.t()).reason, wse::Invalid::kFault);
  // The interval that starts at the faulted answer is invalid too.
  est.update(f.next());
  EXPECT_FALSE(est.estimate(f.t()).valid);
  EXPECT_EQ(est.estimate(f.t()).reason, wse::Invalid::kFault);

  wse::WheelSpeedEstimator est2;
  Feeder g(100.0);
  est2.update(g.sampleNow());
  est2.update(g.next());
  est2.update(g.next());
  ASSERT_TRUE(est2.estimate(g.t()).valid);
  est2.update(g.next(kTick, /*mode=*/0x02));
  EXPECT_EQ(est2.estimate(g.t()).reason, wse::Invalid::kMode);
}

// A first answer that already reports a fault (or another mode) says so instead of "warming up".
TEST(WheelSpeedEstimator, BadFirstAnswerIsReported) {
  wse::WheelSpeedEstimator est;
  Feeder f(0.0);
  est.update(f.sampleNow(/*mode=*/0x02));
  EXPECT_EQ(est.estimate(f.t()).reason, wse::Invalid::kMode);
}

TEST(WheelSpeedEstimator, SegmentFasterThanTheLimitIsInvalid) {
  wse::WheelSpeedEstimator est;
  Feeder f(100.0);
  est.update(f.sampleNow());
  est.update(f.next());
  est.update(f.next());
  ASSERT_TRUE(est.estimate(f.t()).valid);
  f.setRpm(600.0);  // above 475 * 1.2 = 570 rpm (a misread position looks like this)
  est.update(f.next());
  EXPECT_EQ(est.estimate(f.t()).reason, wse::Invalid::kSegmentSpeed);
  // 560 rpm is still accepted.
  wse::WheelSpeedEstimator est2;
  Feeder g(560.0);
  est2.update(g.sampleNow());
  est2.update(g.next());
  est2.update(g.next());
  const auto e = est2.estimate(g.t());
  ASSERT_TRUE(e.valid);
  EXPECT_NEAR(e.rpm, 560.0, kTolRpm);
}

// After an invalid interval the estimate stays invalid until two valid intervals follow.
TEST(WheelSpeedEstimator, RecoversOnlyAfterTwoValidIntervals) {
  wse::WheelSpeedEstimator est;
  Feeder f(80.0);
  est.update(f.sampleNow());
  est.update(f.next());
  est.update(f.next());
  ASSERT_TRUE(est.estimate(f.t()).valid);
  est.update(f.next(0.080));  // two answers lost
  EXPECT_FALSE(est.estimate(f.t()).valid);
  est.update(f.next());
  EXPECT_FALSE(est.estimate(f.t()).valid);
  EXPECT_EQ(est.estimate(f.t()).reason, wse::Invalid::kInterval);  // the cause is kept
  est.update(f.next());
  const auto e = est.estimate(f.t());
  ASSERT_TRUE(e.valid);
  EXPECT_NEAR(e.rpm, 80.0, kTolRpm);
}

TEST(WheelSpeedEstimator, OldNewestAnswerIsStale) {
  wse::WheelSpeedEstimator est;
  Feeder f(100.0);
  est.update(f.sampleNow());
  est.update(f.next());
  est.update(f.next());
  EXPECT_TRUE(est.estimate(f.t() + 0.049).valid);
  const auto e = est.estimate(f.t() + 0.051);
  EXPECT_FALSE(e.valid);
  EXPECT_EQ(e.reason, wse::Invalid::kStale);
  EXPECT_NEAR(e.age_sec, 0.051, 1e-9);
}

TEST(WheelSpeedEstimator, ResetForgetsEverything) {
  wse::WheelSpeedEstimator est;
  Feeder f(100.0);
  est.update(f.sampleNow());
  est.update(f.next());
  est.update(f.next());
  ASSERT_TRUE(est.estimate(f.t()).valid);
  est.reset();
  const auto e = est.estimate(f.t());
  EXPECT_FALSE(e.valid);
  EXPECT_EQ(e.reason, wse::Invalid::kWarmingUp);
  EXPECT_TRUE(std::isinf(e.age_sec));
}

TEST(WheelSpeedEstimator, InvalidNamesAreDistinct) {
  EXPECT_STREQ(wse::invalidName(wse::Invalid::kNone), "none");
  EXPECT_STREQ(wse::invalidName(wse::Invalid::kStale), "stale");
  EXPECT_STREQ(wse::invalidName(wse::Invalid::kSegmentSpeed), "segment_speed");
}

}  // namespace
