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
// 停止/走行モードの2閾値ヒステリシス。
// 入り（走行->停止）: 両軸ともこの値未満。減速スルーレート制限がゼロへ収束する途中の
// 微小な非ゼロ指令を「停止」とみなすため、厳密な == 0.0 ではなく閾値判定にする。
// 抜け（停止->走行）: どちらかの軸がこの値を超える。入りと同じ閾値だと境界付近の
// ノイズやランプのディザで停止/走行フレームが指令レートでトグルするため、抜けは
// 高めに取る（0.02 m/s は車輪約 2 RPM 相当で、実用上の最低速度指令より十分小さい）。
constexpr double kStopEnterLinearMps = 0.005;
constexpr double kStopEnterAngularRadps = 0.005;
constexpr double kStopExitLinearMps = 0.02;
constexpr double kStopExitAngularRadps = 0.02;

// 電気ブレーキ投入を許す実測RPMの上限。これより速く回っている間にブレーキを送ると
// 毎回新規の制動として作用し、収束しない振動（リミットサイクル）を起こすことがある。
constexpr int kBrakeMaxMeasuredRpm = 15;
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

  // 停止/走行モードを2閾値で更新（境界でのフレームトグル防止。閾値は冒頭の定数参照）。
  if (stop_mode_) {
    if (std::abs(linear_x) > kStopExitLinearMps || std::abs(angular_z) > kStopExitAngularRadps) {
      stop_mode_ = false;
    }
  } else {
    if (std::abs(linear_x) < kStopEnterLinearMps &&
        std::abs(angular_z) < kStopEnterAngularRadps) {
      stop_mode_ = true;
    }
  }

  if (stop_mode_) {
    return commandStop();
  }

  auto [left_rpm, right_rpm] = twistToMotorVelocities(linear_x, angular_z);

  RCLCPP_DEBUG(rclcpp::get_logger("DifferentialDrive"),
               "速度指令 - 線形: %.3f m/s, 角速度: %.3f rad/s -> 左: %.1f RPM, 右: %.1f RPM",
               linear_x, angular_z, left_rpm, right_rpm);

  // ゼロ方向への切り捨ては左右で量子化が非対称になるため最近接整数へ丸める
  bool success = true;
  success &= motor_lib_->setMotorVelocity(left_motor_id_, static_cast<int>(std::lround(left_rpm)));
  success &=
      motor_lib_->setMotorVelocity(right_motor_id_, static_cast<int>(std::lround(right_rpm)));

  return success;
}

bool DifferentialDrive::commandStop() {
  // 残留回転が大きい間に電気ブレーキを送ると毎回新規の制動として作用し、収束しない
  // 振動（リミットサイクル）を起こすことがある。実測RPMが閾値を超える間は目標0
  // （無ブレーキ）を送ってファーム側の accel_time ランプで減速させ、閾値未満に
  // なってから stopMotor（ブレーキ+再送スロットル）へ移行する。
  // フィードバック未受信時は getMotorStatus が目標値を返すため、そのままブレーキ経路に入る。
  int left_rpm = 0;
  int right_rpm = 0;
  uint8_t temp, fault;
  bool have_status = motor_lib_->getMotorStatus(left_motor_id_, left_rpm, temp, fault) &&
                     motor_lib_->getMotorStatus(right_motor_id_, right_rpm, temp, fault);
  if (have_status &&
      (std::abs(left_rpm) > kBrakeMaxMeasuredRpm || std::abs(right_rpm) > kBrakeMaxMeasuredRpm)) {
    bool success = true;
    success &= motor_lib_->setMotorVelocity(left_motor_id_, 0);
    success &= motor_lib_->setMotorVelocity(right_motor_id_, 0);
    return success;
  }

  // stopMotor は current モードの PI 積分リセットと velocity モードの brake_on_stop を担う。
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
