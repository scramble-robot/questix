// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "motor_control_lib/differential_drive.hpp"

#include <cmath>
#include <rclcpp/rclcpp.hpp>

namespace motor_control_lib {

namespace {
// 減速スルーレート制限（drive_component の加減速クランプ）でゼロへ収束する途中の
// 微小な非ゼロ指令を「停止」とみなすための閾値。厳密な == 0.0 比較だと、収束の
// 最終ステップまでブレーキ(stopMotor)経路に入らず、低RPM・無ブレーキの指令が
// ファーム側速度クローズドループに送られ続けて微振動する（cf. スティックニュートラル
// 復帰時の足回り振動）。
constexpr double kZeroLinearEpsMps = 0.01;
constexpr double kZeroAngularEpsRadps = 0.01;
}  // namespace

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

  // ほぼゼロの twist は stopMotor 経路へ。これにより current モードの PI 積分が確実に
  // リセットされ、velocity モードでも brake_on_stop が効く。厳密な == 0.0 ではなく閾値
  // 判定にすることで、減速スルーレート制限が漸近的に 0 へ収束する間の微小な非ゼロ指令
  // （無ブレーキで低RPM指令を送り続け、微振動の原因になる）も停止として扱う。
  if (std::abs(linear_x) < kZeroLinearEpsMps && std::abs(angular_z) < kZeroAngularEpsRadps) {
    bool success = true;
    success &= motor_lib_->stopMotor(left_motor_id_);
    success &= motor_lib_->stopMotor(right_motor_id_);
    return success;
  }

  auto [left_rpm, right_rpm] = twistToMotorVelocities(linear_x, angular_z);

  RCLCPP_DEBUG(rclcpp::get_logger("DifferentialDrive"),
               "速度指令 - 線形: %.3f m/s, 角速度: %.3f rad/s -> 左: %.1f RPM, 右: %.1f RPM",
               linear_x, angular_z, left_rpm, right_rpm);

  bool success = true;
  success &= motor_lib_->setMotorVelocity(left_motor_id_, static_cast<int>(left_rpm));
  success &= motor_lib_->setMotorVelocity(right_motor_id_, static_cast<int>(right_rpm));

  return success;
}

void DifferentialDrive::stop() {
  if (motor_lib_) {
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
