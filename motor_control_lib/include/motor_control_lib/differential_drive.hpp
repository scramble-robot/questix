// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
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

  /**
   * @brief 指令を許す最低車輪 RPM（低速不感帯）を設定する。
   *  - 左右輪の指令 RPM がいずれもこの値未満なら、その twist は停止として扱う。
   *  - M0602C のファーム速度ループは低速域ほど減衰が悪く、わずかな速度を保持させようと
   *    すると収束せず振動し続ける（実機ログで確認）。その領域を指令しないための不感帯。
   *  - 0 で不感帯なし（RPM 0 のときのみ停止）。
   *  - 注意: 旋回のみの指令では車輪 RPM は wheel_separation/2 × angular_z 相当までしか
   *    出ないため、この値を上げすぎると旋回の低速側が丸ごと使えなくなる。
   */
  void setMinCommandRpm(int min_command_rpm);

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

  // 停止/走行モード状態（車輪 RPM でヒステリシス判定。詳細は drive_stop_gate.hpp）。
  // 単一閾値だと境界付近で {目標0+ブレーキ} と {目標N+無ブレーキ} のフレームが指令
  // レートでトグルし振動の原因になるため、入り/抜けで別の閾値を使う。初期状態は停止。
  bool stop_mode_{true};

  // 指令を許す最低車輪 RPM（低速不感帯）。0 で不感帯なし。
  int min_command_rpm_{0};

  // 停止モード中の停止指令送信。残留回転が大きい間は目標0（無ブレーキ）で
  // ファームランプに減速させ、実測RPMが閾値未満になってからブレーキを投入する。
  bool commandStop();

  // Conversion methods
  std::pair<double, double> twistToMotorVelocities(double linear_x, double angular_z) const;
  std::pair<double, double> motorVelocitiesToTwist(int left_rpm, int right_rpm) const;
};

}  // namespace motor_control_lib

#endif  // MOTOR_CONTROL_LIB__DIFFERENTIAL_DRIVE_HPP_
