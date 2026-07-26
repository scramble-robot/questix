// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "motor_control_lib/differential_drive.hpp"

#include <algorithm>
#include <cmath>
#include <rclcpp/rclcpp.hpp>

#include "motor_control_lib/drive_stop_gate.hpp"

namespace motor_control_lib {

DifferentialDrive::DifferentialDrive(std::shared_ptr<DdtMotorLib> motor_lib, int left_motor_id,
                                     int right_motor_id, double wheel_radius,
                                     double wheel_separation)
    : motor_lib_(motor_lib),
      left_motor_id_(left_motor_id),
      right_motor_id_(right_motor_id),
      wheel_radius_(wheel_radius),
      wheel_separation_(wheel_separation) {}

bool DifferentialDrive::setVelocity(double linear_x, double angular_z) {
  if (!motor_lib_) {
    return false;
  }

  auto [left_rpm, right_rpm] = twistToMotorVelocities(linear_x, angular_z);

  // ゼロ方向への切り捨ては左右で量子化が非対称になるため最近接整数へ丸める
  const int left_cmd = static_cast<int>(std::lround(left_rpm));
  const int right_cmd = static_cast<int>(std::lround(right_rpm));

  // 停止/走行モードを車輪 RPM で判定する（前後と旋回が合成された実際の車輪速度で見る）。
  // ヒステリシス付き。詳細は drive_stop_gate.hpp。
  const int max_abs_rpm = std::max(std::abs(left_cmd), std::abs(right_cmd));
  stop_mode_ = drive_stop_gate::updateStopMode(stop_mode_, max_abs_rpm, min_command_rpm_);

  if (stop_mode_) {
    return commandStop();
  }

  RCLCPP_DEBUG(rclcpp::get_logger("DifferentialDrive"),
               "速度指令 - 線形: %.3f m/s, 角速度: %.3f rad/s -> 左: %d RPM, 右: %d RPM", linear_x,
               angular_z, left_cmd, right_cmd);

  bool success = true;
  success &= motor_lib_->setMotorVelocity(left_motor_id_, left_cmd);
  success &= motor_lib_->setMotorVelocity(right_motor_id_, right_cmd);

  return success;
}

void DifferentialDrive::setMinCommandRpm(int min_command_rpm) {
  min_command_rpm_ = std::max(0, min_command_rpm);
}

bool DifferentialDrive::commandStop() {
  // 停止は必ずブレーキ経路（stopMotor）を通す。
  // 実測RPMで「まだ回っているうちはブレーキを送らない」ゲートを一度入れたが、これは
  // 危険な回帰だった: 速度ループでブレーキ無しの目標0は能動的な0保持にならないため、
  // 車輪を浮かせて摩擦が無い状態では減速せず、実測が閾値を超えたままブレーキが永久に
  // 入らず回り続ける（実機で確認）。加えて getMotorStatus には鮮度ゲートが無く、
  // 固まった古い実測値でも同じラッチに入る。
  // 残留回転中のブレーキ連打によるリミットサイクルは、DdtMotorLib 側の
  // stop_resend_interval_ms（再送スロットル）で抑える方針に一本化する。
  bool success = true;
  success &= motor_lib_->stopMotor(left_motor_id_);
  success &= motor_lib_->stopMotor(right_motor_id_);
  return success;
}

void DifferentialDrive::stop() {
  // ウォッチドッグ・非常停止・シャットダウン用の即時停止。安全経路のため実測RPMに
  // よるゲートは通さず、常に即座にブレーキ（stopMotor）を送る。
  if (motor_lib_) {
    stop_mode_ = true;
    motor_lib_->stopMotor(left_motor_id_);
    motor_lib_->stopMotor(right_motor_id_);
  }
}

bool DifferentialDrive::getCurrentVelocity(double& linear_x, double& angular_z) const {
  if (!motor_lib_) {
    return false;
  }

  int left_rpm, right_rpm;
  uint8_t temp, fault;

  if (!motor_lib_->getMotorStatus(left_motor_id_, left_rpm, temp, fault) ||
      !motor_lib_->getMotorStatus(right_motor_id_, right_rpm, temp, fault)) {
    return false;
  }

  auto [linear, angular] = motorVelocitiesToTwist(left_rpm, right_rpm);
  linear_x = linear;
  angular_z = angular;

  return true;
}

bool DifferentialDrive::setWheelParams(double wheel_radius, double wheel_separation) {
  wheel_radius_ = wheel_radius;
  wheel_separation_ = wheel_separation;
  return true;
}

bool DifferentialDrive::setMotorIds(int left_motor_id, int right_motor_id) {
  left_motor_id_ = left_motor_id;
  right_motor_id_ = right_motor_id;
  return true;
}

bool DifferentialDrive::isHealthy() const {
  if (!motor_lib_) {
    return false;
  }

  int velocity;
  uint8_t temp, fault_left, fault_right;

  bool left_ok = motor_lib_->getMotorStatus(left_motor_id_, velocity, temp, fault_left);
  bool right_ok = motor_lib_->getMotorStatus(right_motor_id_, velocity, temp, fault_right);

  return left_ok && right_ok && (fault_left == 0) && (fault_right == 0);
}

DifferentialDrive::DriveStatus DifferentialDrive::getDriveStatus() const {
  DriveStatus status;
  status.left_motor_id = left_motor_id_;
  status.right_motor_id = right_motor_id_;

  if (motor_lib_) {
    uint8_t left_temp, right_temp;
    motor_lib_->getMotorStatus(left_motor_id_, status.left_rpm, left_temp, status.left_fault_code);
    motor_lib_->getMotorStatus(right_motor_id_, status.right_rpm, right_temp,
                               status.right_fault_code);
    status.left_temperature = left_temp;
    status.right_temperature = right_temp;

    auto [linear, angular] = motorVelocitiesToTwist(status.left_rpm, status.right_rpm);
    status.current_linear_velocity = linear;
    status.current_angular_velocity = angular;
    status.is_healthy = isHealthy();
  } else {
    status.left_rpm = 0;
    status.right_rpm = 0;
    status.current_linear_velocity = 0.0;
    status.current_angular_velocity = 0.0;
    status.left_temperature = 0;
    status.right_temperature = 0;
    status.left_fault_code = 255;  // Error state
    status.right_fault_code = 255;
    status.is_healthy = false;
  }

  return status;
}

std::pair<double, double> DifferentialDrive::twistToMotorVelocities(double linear_x,
                                                                    double angular_z) const {
  double v_left = linear_x - (angular_z * wheel_separation_ / 2.0);
  double v_right = linear_x + (angular_z * wheel_separation_ / 2.0);

  double rpm_left = (v_left / (2.0 * M_PI * wheel_radius_)) * 60.0;
  double rpm_right = -1 * (v_right / (2.0 * M_PI * wheel_radius_)) * 60.0;

  return std::make_pair(rpm_left, rpm_right);
}

std::pair<double, double> DifferentialDrive::motorVelocitiesToTwist(int left_rpm,
                                                                    int right_rpm) const {
  // RPMから並進・角速度に変換
  double left_velocity = (left_rpm / 60.0) * (2.0 * M_PI * wheel_radius_);
  double right_velocity = -1 * (right_rpm / 60.0) * (2.0 * M_PI * wheel_radius_);

  double linear_x = (left_velocity + right_velocity) / 2.0;
  double angular_z = (right_velocity - left_velocity) / wheel_separation_;

  return std::make_pair(linear_x, angular_z);
}

}  // namespace motor_control_lib
