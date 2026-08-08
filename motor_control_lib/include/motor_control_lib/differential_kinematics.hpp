// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_LIB__DIFFERENTIAL_KINEMATICS_HPP_
#define MOTOR_CONTROL_LIB__DIFFERENTIAL_KINEMATICS_HPP_

#include <cmath>
#include <utility>

namespace motor_control_lib::differential_kinematics {

// 差動二輪の運動学（車体 twist <-> 左右車輪 RPM）。純粋関数として切り出してあるため、
// シリアル接続なしにホスト側の制御チェーン（motor_control_app の control_core）から
// 呼べる。DifferentialDrive もこの関数群に委譲するので、変換式の単一ソースになる。
//
// 車輪 RPM の符号規約: 左輪は前進で正、右輪は前進で負。M0602C の取り付け向きが左右で
// 逆のため右輪だけ符号を反転している。この反転は twistToWheelRpm と wheelRpmToTwist の
// 両方に対称に入っているので、往復すると元の twist に戻る。

// 車体 twist [m/s, rad/s] を左右車輪 RPM に変換する。
// wheel_radius <= 0（設定ミス）では inf/NaN を返さず {0, 0} を返す。不正な設定で
// 暴走指令を出さないためのガード。
inline std::pair<double, double> twistToWheelRpm(double linear_x, double angular_z,
                                                 double wheel_radius, double wheel_separation) {
  const double circumference = 2.0 * M_PI * wheel_radius;
  if (!(circumference > 0.0)) {
    return {0.0, 0.0};
  }
  const double v_left = linear_x - (angular_z * wheel_separation / 2.0);
  const double v_right = linear_x + (angular_z * wheel_separation / 2.0);
  const double rpm_left = (v_left / circumference) * 60.0;
  const double rpm_right = -1.0 * (v_right / circumference) * 60.0;
  return {rpm_left, rpm_right};
}

// 左右車輪 RPM を車体 twist [m/s, rad/s] に変換する（twistToWheelRpm の逆変換）。
// wheel_separation <= 0（設定ミス）では角速度を 0 として返す。
inline std::pair<double, double> wheelRpmToTwist(int left_rpm, int right_rpm, double wheel_radius,
                                                 double wheel_separation) {
  const double circumference = 2.0 * M_PI * wheel_radius;
  const double left_velocity = (left_rpm / 60.0) * circumference;
  const double right_velocity = -1.0 * (right_rpm / 60.0) * circumference;

  const double linear_x = (left_velocity + right_velocity) / 2.0;
  const double angular_z =
      (wheel_separation > 0.0) ? (right_velocity - left_velocity) / wheel_separation : 0.0;
  return {linear_x, angular_z};
}

}  // namespace motor_control_lib::differential_kinematics

#endif  // MOTOR_CONTROL_LIB__DIFFERENTIAL_KINEMATICS_HPP_
