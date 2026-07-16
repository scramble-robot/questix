// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__SHOT_ANGLE_HPP_
#define MOTOR_CONTROL_APP__SHOT_ANGLE_HPP_

#include <algorithm>
#include <cmath>

namespace motor_control_app::shot_angle {

// 角度制限関数
inline double clampAngle(double angle_deg, double min_deg, double max_deg) {
  return std::max(min_deg, std::min(max_deg, angle_deg));
}

// 角度からサーボ位置への変換（角度 -> 0-4095）
inline int angleToServoPosition(double angle_deg) {
  if (!std::isfinite(angle_deg)) {
    return 0;
  }

  // 角度を直接サーボ位置に変換（0度=0, 360度=4095）
  // 角度を0-360度の範囲で正規化
  angle_deg = std::fmod(angle_deg, 360.0);
  if (angle_deg < 0.0) {
    angle_deg += 360.0;
  }

  // サーボ位置に変換
  double normalized = angle_deg / 360.0;
  int position = static_cast<int>(normalized * 4096.0);
  return std::max(0, std::min(4095, position));
}

// サーボ位置から角度への変換（0-4095 -> 角度）
inline double servoPositionToAngle(int position) {
  // 位置を0-4095の範囲にクランプ
  position = std::max(0, std::min(4095, position));
  // 角度に変換（0-4095 -> 0-360度）
  double normalized = static_cast<double>(position) / 4096.0;
  return normalized * 360.0;
}

}  // namespace motor_control_app::shot_angle

#endif  // MOTOR_CONTROL_APP__SHOT_ANGLE_HPP_
