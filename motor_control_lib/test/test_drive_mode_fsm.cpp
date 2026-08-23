// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include "motor_control_lib/drive_mode_fsm.hpp"
#include "motor_control_lib/drive_stop_gate.hpp"

namespace fsm = motor_control_lib::drive_mode_fsm;
namespace gate = motor_control_lib::drive_stop_gate;
using fsm::DriveMode;

namespace {
fsm::Config legacyConfig() {
  fsm::Config c;
  c.min_command_rpm = 5;
  c.run_enter_rpm = 0;
  c.run_exit_rpm = 0;
  return c;
}
fsm::Config runConfig() {
  fsm::Config c;
  c.min_command_rpm = 5;
  c.run_enter_rpm = 40;
  c.run_exit_rpm = 30;
  return c;
}
}  // namespace

TEST(DriveModeFsm, LegacyConfigMatchesStopGateExactly) {
  // RUN 閾値が無効なら、停止/走行の 2 状態で drive_stop_gate と同じ判定になる
  const auto cfg = legacyConfig();
  bool stop_mode = true;
  DriveMode mode = DriveMode::kStop;
  for (int rpm : {0, 3, 5, 6, 7, 8, 100, 7, 6, 5, 4, 0, 7, 8}) {
    stop_mode = gate::updateStopMode(stop_mode, rpm, cfg.min_command_rpm);
    mode = fsm::update(mode, rpm, cfg);
    EXPECT_EQ(stop_mode, mode == DriveMode::kStop) << "rpm=" << rpm;
    if (!stop_mode) {
      EXPECT_EQ(mode, DriveMode::kRun) << "rpm=" << rpm;  // CREEP は空集合
    }
  }
}

TEST(DriveModeFsm, CreepBetweenDeadbandAndRunThreshold) {
  const auto cfg = runConfig();
  DriveMode mode = DriveMode::kStop;
  mode = fsm::update(mode, 10, cfg);  // 不感帯は抜けたが RUN 未満
  EXPECT_EQ(mode, DriveMode::kCreep);
  mode = fsm::update(mode, 39, cfg);
  EXPECT_EQ(mode, DriveMode::kCreep);
  mode = fsm::update(mode, 40, cfg);  // 入り閾値で RUN
  EXPECT_EQ(mode, DriveMode::kRun);
}

TEST(DriveModeFsm, RunExitHasHysteresis) {
  const auto cfg = runConfig();
  DriveMode mode = DriveMode::kRun;
  mode = fsm::update(mode, 35, cfg);  // 入り閾値未満だが抜け閾値以上 -> RUN 維持
  EXPECT_EQ(mode, DriveMode::kRun);
  mode = fsm::update(mode, 30, cfg);
  EXPECT_EQ(mode, DriveMode::kRun);
  mode = fsm::update(mode, 29, cfg);  // 抜け閾値未満で CREEP
  EXPECT_EQ(mode, DriveMode::kCreep);
  mode = fsm::update(mode, 35, cfg);  // 戻っても入り閾値未満なので CREEP のまま
  EXPECT_EQ(mode, DriveMode::kCreep);
}

TEST(DriveModeFsm, NoToggleAtRunBoundary) {
  const auto cfg = runConfig();
  DriveMode mode = DriveMode::kRun;
  int transitions = 0;
  DriveMode prev = mode;
  for (int i = 0; i < 100; ++i) {
    const int rpm = (i % 2 == 0) ? 30 : 39;  // 抜け閾値と入り閾値の間を往復
    mode = fsm::update(mode, rpm, cfg);
    if (mode != prev) ++transitions;
    prev = mode;
  }
  EXPECT_EQ(transitions, 0);
}

TEST(DriveModeFsm, StopFromAnyModeGoesThroughStopGate) {
  const auto cfg = runConfig();
  EXPECT_EQ(fsm::update(DriveMode::kRun, 4, cfg), DriveMode::kStop);
  EXPECT_EQ(fsm::update(DriveMode::kCreep, 4, cfg), DriveMode::kStop);
  // 停止中は不感帯 + ヒステリシス上乗せを超えるまで停止のまま
  EXPECT_EQ(fsm::update(DriveMode::kStop, 5 + gate::kExitMarginRpm - 1, cfg), DriveMode::kStop);
  EXPECT_EQ(fsm::update(DriveMode::kStop, 5 + gate::kExitMarginRpm, cfg), DriveMode::kCreep);
  // 停止から一気に RUN 域へ
  EXPECT_EQ(fsm::update(DriveMode::kStop, 100, cfg), DriveMode::kRun);
}

TEST(DriveModeFsm, OnlyOneThresholdGivenUsesItForBoth) {
  fsm::Config c;
  c.min_command_rpm = 5;
  c.run_enter_rpm = 40;
  c.run_exit_rpm = 0;
  EXPECT_EQ(fsm::update(DriveMode::kCreep, 40, c), DriveMode::kRun);
  EXPECT_EQ(fsm::update(DriveMode::kRun, 39, c), DriveMode::kCreep);
  c.run_enter_rpm = 0;
  c.run_exit_rpm = 30;
  EXPECT_EQ(fsm::update(DriveMode::kCreep, 30, c), DriveMode::kRun);
  EXPECT_EQ(fsm::update(DriveMode::kRun, 29, c), DriveMode::kCreep);
}

TEST(DriveModeFsm, ExitAboveEnterIsClampedToEnter) {
  fsm::Config c;
  c.min_command_rpm = 5;
  c.run_enter_rpm = 30;
  c.run_exit_rpm = 40;  // 逆転設定
  EXPECT_EQ(fsm::update(DriveMode::kCreep, 30, c), DriveMode::kRun);
  EXPECT_EQ(fsm::update(DriveMode::kRun, 30, c), DriveMode::kRun);
  EXPECT_EQ(fsm::update(DriveMode::kRun, 29, c), DriveMode::kCreep);
}
