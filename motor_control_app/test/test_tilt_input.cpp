// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <limits>

#include "motor_control_app/tilt_input.hpp"

using motor_control_app::TiltInputEdges;
using motor_control_app::tiltInputPressed;

TEST(TiltInput, MixedDirectionsStepOncePerPress) {
  TiltInputEdges edges;
  const auto sample = [&edges](float axis, int button) {
    return edges.update(tiltInputPressed({axis}, {button}, 0, 1, 0),
                        tiltInputPressed({axis}, {button}, -1, -1, 0));
  };
  EXPECT_EQ(sample(0.0F, 0), 0);
  EXPECT_EQ(sample(1.0F, 0), 1);
  EXPECT_EQ(sample(1.0F, 0), 0);
  EXPECT_EQ(sample(0.0F, 0), 0);
  EXPECT_EQ(sample(0.0F, 1), -1);
  EXPECT_EQ(sample(0.0F, 1), 0);
  edges.reset();
  EXPECT_EQ(sample(0.0F, 1), -1);
}

TEST(TiltInput, AxisDirectionsAndThresholds) {
  TiltInputEdges edges;
  const auto sample = [&edges](float axis) {
    return edges.update(tiltInputPressed({axis}, {}, 0, 1, 0),
                        tiltInputPressed({axis}, {}, 0, -1, 0));
  };
  EXPECT_EQ(sample(0.5F), 0);
  EXPECT_EQ(sample(-0.5F), 0);
  EXPECT_EQ(sample(0.6F), 1);
  EXPECT_EQ(sample(-0.6F), -1);
  EXPECT_EQ(sample(-1.0F), 0);
  EXPECT_EQ(sample(0.0F), 0);
  EXPECT_EQ(sample(-1.0F), -1);
}

TEST(TiltInput, ConflictingInputsRequireAnotherPress) {
  TiltInputEdges edges;
  EXPECT_EQ(edges.update(true, true), 0);
  EXPECT_EQ(edges.update(true, false), 0);
  EXPECT_EQ(edges.update(false, false), 0);
  EXPECT_EQ(edges.update(false, true), -1);
  EXPECT_EQ(edges.update(true, true), 0);
  EXPECT_EQ(edges.update(true, false), 0);
}

TEST(TiltInput, ButtonsWorkWithoutAxesAndMissingInputsNeverFallback) {
  EXPECT_TRUE(tiltInputPressed({}, {0, 1}, -1, 1, 1));
  EXPECT_FALSE(tiltInputPressed({}, {1}, 7, 1, 0));
  EXPECT_FALSE(tiltInputPressed({}, {1}, -2, 1, 0));
  EXPECT_FALSE(tiltInputPressed({1}, {}, -1, 1, 0));
  EXPECT_FALSE(tiltInputPressed({}, {1}, -1, 1, 63));
  EXPECT_FALSE(tiltInputPressed({}, {1}, -1, 1, -1));
  EXPECT_FALSE(tiltInputPressed({1}, {}, 0, 0, 0));
  EXPECT_FALSE(tiltInputPressed({std::numeric_limits<float>::infinity()}, {}, 0, 1, 0));
  EXPECT_FALSE(tiltInputPressed({std::numeric_limits<float>::quiet_NaN()}, {}, 0, 1, 0));
}
