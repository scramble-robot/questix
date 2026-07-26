// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_LIB__DRIVE_STOP_GATE_HPP_
#define MOTOR_CONTROL_LIB__DRIVE_STOP_GATE_HPP_

#include <algorithm>

namespace motor_control_lib::drive_stop_gate {

// 停止 -> 走行へ抜けるときの上乗せ [RPM]。入りと同じ閾値だと境界付近で停止フレームと
// 走行フレームが指令レートでトグルし、それ自体が振動源になるためヒステリシスを持たせる。
inline constexpr int kExitMarginRpm = 2;

// 停止/走行モードを車輪 RPM で判定する。
//
// min_command_rpm は「これ未満の車輪速度は指令せず停止扱いにする」下限値。M0602C の
// ファーム速度ループは低速域ほど減衰が悪く、わずかな速度を保持させようとすると収束せずに
// 振動し続ける。その領域を指令しないための不感帯。
//
// 0 を指定しても停止判定自体は生きる（max_abs_rpm == 0 で停止）。
//
// @param stop_mode     現在のモード（true=停止中）
// @param max_abs_rpm   左右輪の指令 RPM 絶対値の大きい方
// @param min_command_rpm 指令を許す最低車輪 RPM（不感帯の幅）
// @return 更新後のモード（true=停止）
inline bool updateStopMode(bool stop_mode, int max_abs_rpm, int min_command_rpm) {
  const int enter_rpm = std::max(1, min_command_rpm);
  if (stop_mode) {
    return max_abs_rpm < enter_rpm + kExitMarginRpm;
  }
  return max_abs_rpm < enter_rpm;
}

}  // namespace motor_control_lib::drive_stop_gate

#endif  // MOTOR_CONTROL_LIB__DRIVE_STOP_GATE_HPP_
