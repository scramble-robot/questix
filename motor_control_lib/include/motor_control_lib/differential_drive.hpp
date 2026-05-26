// Copyright 2026 scramble-robot
//
#ifndef MOTOR_CONTROL_LIB__DIFFERENTIAL_DRIVE_HPP_
#define MOTOR_CONTROL_LIB__DIFFERENTIAL_DRIVE_HPP_

#include <memory>

#include "motor_control_lib/base_motor_controller.hpp"
#include "motor_control_lib/ddt_motor_lib.hpp"

namespace motor_control_lib {

/**
 * @brief 差動駆動制御ラッパークラス
 * DDTモータライブラリを使用して差動駆動制御を実現
 */
class DifferentialDrive : public IDriveMotor {
public:
  explicit DifferentialDrive(std::shared_ptr<DdtMotorLib> motor_lib, int left_motor_id,
                             int right_motor_id, double wheel_radius, double wheel_separation);
  virtual ~DifferentialDrive() = default;

  // IDriveMotor implementation
  bool setVelocity(double linear_x, double angular_z) override;
  void stop() override;
  bool getCurrentVelocity(double& linear_x, double& angular_z) const override;

  // Configuration
  bool setWheelParams(double wheel_radius, double wheel_separation);
  bool setMotorIds(int left_motor_id, int right_motor_id);

  // Status
  bool isHealthy() const;
  struct DriveStatus {
    int left_motor_id;
    int right_motor_id;
    int left_rpm;
    int right_rpm;
    double current_linear_velocity;
    double current_angular_velocity;
    uint8_t left_temperature;
    uint8_t right_temperature;
    uint8_t left_fault_code;
    uint8_t right_fault_code;
    bool is_healthy;
  };
  DriveStatus getDriveStatus() const;

private:
  std::shared_ptr<DdtMotorLib> motor_lib_;
  int left_motor_id_;
  int right_motor_id_;
  double wheel_radius_;
  double wheel_separation_;

  // Conversion methods
  std::pair<double, double> twistToMotorVelocities(double linear_x, double angular_z) const;
  std::pair<double, double> motorVelocitiesToTwist(int left_rpm, int right_rpm) const;
};

}  // namespace motor_control_lib

#endif  // MOTOR_CONTROL_LIB__DIFFERENTIAL_DRIVE_HPP_
