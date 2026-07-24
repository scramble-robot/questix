// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#include <gtest/gtest.h>

#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

#include "operation_manager/gpio_safety_evaluator.hpp"

namespace {

using operation_manager::GpioSafetyEvaluator;

TEST(GpioSafetyEvaluatorTest, SafeLowPinUsesFalseAsSafeState) {
  GpioSafetyEvaluator evaluator({5}, {}, 1.0);
  EXPECT_FALSE(evaluator.evaluate(0.0).controllable);

  evaluator.update(5, false, 0.0);
  EXPECT_TRUE(evaluator.evaluate(0.5).controllable);

  evaluator.update(5, true, 0.6);
  const auto stopped = evaluator.evaluate(0.7);
  EXPECT_FALSE(stopped.controllable);
  EXPECT_EQ(stopped.reason, "pin 5 is true, expected false; ");
}

TEST(GpioSafetyEvaluatorTest, SafeHighPinUsesTrueAsSafeState) {
  GpioSafetyEvaluator evaluator({}, {27}, 1.0);
  evaluator.update(27, true, 0.0);
  EXPECT_TRUE(evaluator.evaluate(0.5).controllable);

  evaluator.update(27, false, 0.6);
  const auto stopped = evaluator.evaluate(0.7);
  EXPECT_FALSE(stopped.controllable);
  EXPECT_EQ(stopped.reason, "pin 27 is false, expected true; ");
}

TEST(GpioSafetyEvaluatorTest, PracticeMonitorsOnlyPhysicalEstop) {
  GpioSafetyEvaluator evaluator({5}, {}, 1.0);
  EXPECT_EQ(evaluator.monitored_pins(), std::vector<unsigned int>({5}));

  evaluator.update(5, false, 0.0);
  EXPECT_TRUE(evaluator.evaluate(0.5).controllable);
}

TEST(GpioSafetyEvaluatorTest, CompetitionRequiresBothSafeInputs) {
  GpioSafetyEvaluator evaluator({5}, {27}, 1.0);
  evaluator.update(5, false, 0.0);
  const auto partial = evaluator.evaluate(0.1);
  EXPECT_FALSE(partial.controllable);
  EXPECT_EQ(partial.reason, "pin 27 not received; ");

  evaluator.update(27, true, 0.1);
  EXPECT_TRUE(evaluator.evaluate(0.2).controllable);

  evaluator.update(5, true, 0.3);
  EXPECT_FALSE(evaluator.evaluate(0.4).controllable);
  evaluator.update(5, false, 0.5);
  evaluator.update(27, false, 0.5);
  EXPECT_FALSE(evaluator.evaluate(0.6).controllable);
}

TEST(GpioSafetyEvaluatorTest, StartupReportsEveryUnreceivedPin) {
  GpioSafetyEvaluator evaluator({5}, {27}, 1.0);
  const auto initial = evaluator.evaluate(0.0);
  EXPECT_FALSE(initial.controllable);
  EXPECT_EQ(initial.reason, "pin 5 not received; pin 27 not received; ");
  ASSERT_EQ(initial.pins.size(), 2U);
  EXPECT_FALSE(initial.pins[0].received);
  EXPECT_FALSE(initial.pins[1].received);
}

TEST(GpioSafetyEvaluatorTest, AnyStaleInputStopsCompetitionMode) {
  GpioSafetyEvaluator evaluator({5}, {27}, 1.0);
  evaluator.update(5, false, 0.0);
  evaluator.update(27, true, 0.5);
  EXPECT_TRUE(evaluator.evaluate(0.9).controllable);

  const auto stale = evaluator.evaluate(1.1);
  EXPECT_FALSE(stale.controllable);
  EXPECT_EQ(stale.reason, "pin 5 timeout; ");
  EXPECT_GT(stale.pins[0].age_seconds, 1.0);
}

TEST(GpioSafetyEvaluatorTest, TimeMovingBackwardsIsFailSafe) {
  GpioSafetyEvaluator evaluator({5}, {}, 1.0);
  evaluator.update(5, false, 10.0);

  const auto backwards = evaluator.evaluate(9.0);
  EXPECT_FALSE(backwards.controllable);
  EXPECT_EQ(backwards.reason, "pin 5 time moved backwards; ");
  ASSERT_EQ(backwards.pins.size(), 1U);
  EXPECT_TRUE(std::isinf(backwards.pins[0].age_seconds));
}

TEST(GpioSafetyEvaluatorTest, NonFiniteTimeIsFailSafe) {
  constexpr double nan = std::numeric_limits<double>::quiet_NaN();
  constexpr double infinity = std::numeric_limits<double>::infinity();

  GpioSafetyEvaluator update_nan({5}, {}, 1.0);
  update_nan.update(5, false, nan);
  EXPECT_EQ(update_nan.evaluate(1.0).reason, "pin 5 time is not finite; ");

  GpioSafetyEvaluator evaluate_nan({5}, {}, 1.0);
  evaluate_nan.update(5, false, 1.0);
  EXPECT_EQ(evaluate_nan.evaluate(nan).reason, "pin 5 time is not finite; ");

  const auto evaluate_infinity = evaluate_nan.evaluate(infinity);
  EXPECT_FALSE(evaluate_infinity.controllable);
  EXPECT_EQ(evaluate_infinity.reason, "pin 5 time is not finite; ");
  ASSERT_EQ(evaluate_infinity.pins.size(), 1U);
  EXPECT_TRUE(std::isinf(evaluate_infinity.pins[0].age_seconds));
}

TEST(GpioSafetyEvaluatorTest, RejectsOverlappingPolarity) {
  EXPECT_THROW(GpioSafetyEvaluator({5}, {5}, 1.0), std::invalid_argument);
}

TEST(GpioSafetyEvaluatorTest, RejectsDuplicatePins) {
  EXPECT_THROW(GpioSafetyEvaluator({5, 5}, {}, 1.0), std::invalid_argument);
  EXPECT_THROW(GpioSafetyEvaluator({}, {27, 27}, 1.0), std::invalid_argument);
}

TEST(GpioSafetyEvaluatorTest, RejectsInvalidPinValues) {
  EXPECT_THROW(GpioSafetyEvaluator({-1}, {}, 1.0), std::invalid_argument);
  EXPECT_THROW(GpioSafetyEvaluator({}, {54}, 1.0), std::invalid_argument);
}

TEST(GpioSafetyEvaluatorTest, RejectsUnsafeEmptyOrInvalidTimeoutConfiguration) {
  EXPECT_THROW(GpioSafetyEvaluator({}, {}, 1.0), std::invalid_argument);
  EXPECT_THROW(GpioSafetyEvaluator({5}, {}, 0.0), std::invalid_argument);
  EXPECT_THROW(GpioSafetyEvaluator({5}, {}, -1.0), std::invalid_argument);
  EXPECT_THROW(GpioSafetyEvaluator({5}, {}, std::numeric_limits<double>::quiet_NaN()),
               std::invalid_argument);
  EXPECT_THROW(GpioSafetyEvaluator({5}, {}, std::numeric_limits<double>::infinity()),
               std::invalid_argument);
}

}  // namespace

int main(int argc, char** argv) {
  testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
