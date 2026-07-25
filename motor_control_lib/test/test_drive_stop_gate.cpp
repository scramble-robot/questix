// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include "motor_control_lib/drive_stop_gate.hpp"

namespace gate = motor_control_lib::drive_stop_gate;

TEST(DriveStopGate, ZeroRpmAlwaysStopsEvenWithoutDeadband) {
  // min_command_rpm=0（不感帯なし）でも RPM 0 なら停止する
  EXPECT_TRUE(gate::updateStopMode(false, 0, 0));
  EXPECT_TRUE(gate::updateStopMode(true, 0, 0));
  // 1 RPM 出ていれば走行（ヒステリシス分の上乗せは要る）
  EXPECT_FALSE(gate::updateStopMode(false, 1, 0));
}

TEST(DriveStopGate, EntersStopBelowDeadband) {
  // 走行中に指令が不感帯を下回ったら停止へ
  EXPECT_TRUE(gate::updateStopMode(false, 7, 8));
  EXPECT_FALSE(gate::updateStopMode(false, 8, 8));
}

TEST(DriveStopGate, ExitRequiresHysteresisMargin) {
  // 停止中は不感帯ちょうどでは復帰せず、上乗せ分を超えて初めて走行へ
  EXPECT_TRUE(gate::updateStopMode(true, 8, 8));
  EXPECT_TRUE(gate::updateStopMode(true, 8 + gate::kExitMarginRpm - 1, 8));
  EXPECT_FALSE(gate::updateStopMode(true, 8 + gate::kExitMarginRpm, 8));
}

TEST(DriveStopGate, NoToggleAtBoundary) {
  // 境界値を往復させてもトグルしないこと（停止フレームと走行フレームの交互送信を防ぐ）
  bool mode = false;  // 走行中
  mode = gate::updateStopMode(mode, 8, 8);
  EXPECT_FALSE(mode);
  mode = gate::updateStopMode(mode, 7, 8);  // 不感帯へ落ちる -> 停止
  EXPECT_TRUE(mode);
  mode = gate::updateStopMode(mode, 8, 8);  // 戻っても上乗せ未満なので停止のまま
  EXPECT_TRUE(mode);
  mode = gate::updateStopMode(mode, 9, 8);
  EXPECT_TRUE(mode);
  mode = gate::updateStopMode(mode, 10, 8);  // 上乗せを超えて走行へ
  EXPECT_FALSE(mode);
}

TEST(DriveStopGate, NegativeDeadbandTreatedAsZero) {
  // 呼び出し側が 0 未満を渡しても RPM 0 判定に退化するだけ（クランプは setter 側）
  EXPECT_TRUE(gate::updateStopMode(false, 0, -5));
  EXPECT_FALSE(gate::updateStopMode(false, 3, -5));
}
