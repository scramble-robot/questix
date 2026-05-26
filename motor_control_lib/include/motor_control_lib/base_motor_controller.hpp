// Copyright 2026 scramble-robot
//
#ifndef MOTOR_CONTROL_LIB__BASE_MOTOR_CONTROLLER_HPP_
#define MOTOR_CONTROL_LIB__BASE_MOTOR_CONTROLLER_HPP_

#include <cstdint>
#include <memory>
#include <rclcpp/rclcpp.hpp>
#include <string>

namespace motor_control_lib {

/**
 * @brief モータ制御の基底クラス
 */
class BaseMotorController {
public:
  explicit BaseMotorController(const std::string& name) : name_(name), initialized_(false) {}
  virtual ~BaseMotorController() = default;

  /**
   * @brief モータの初期化
   * @return 初期化成功/失敗
   */
  virtual bool initialize() = 0;

  /**
   * @brief モータの終了処理
   */
  virtual void shutdown() = 0;

  /**
   * @brief モータの状態チェック
   * @return モータが正常か
   */
  virtual bool isHealthy() const = 0;

  /**
   * @brief 緊急停止
   */
  virtual void emergencyStop() = 0;

  /**
   * @brief モータ名を取得
   */
  const std::string& getName() const { return name_; }

  /**
   * @brief 初期化状態を確認
   */
  bool isInitialized() const { return initialized_; }

protected:
  std::string name_;
  bool initialized_;
  rclcpp::Logger logger_{rclcpp::get_logger("BaseMotorController")};
};

/**
 * @brief 個別モータ制御のインターフェース
 */
class IIndividualMotor {
public:
  virtual ~IIndividualMotor() = default;

  /**
   * @brief 指定したモータを初期化
   * @param motor_id モータID
   * @return 初期化成功/失敗
   */
  virtual bool initializeMotor(int motor_id) = 0;

  /**
   * @brief 指定したモータの速度を設定
   * @param motor_id モータID
   * @param velocity_rpm 目標速度 [RPM]
   * @return 設定成功/失敗
   */
  virtual bool setMotorVelocity(int motor_id, int velocity_rpm) = 0;

  /**
   * @brief 指定したモータの状態を取得
   * @param motor_id モータID
   * @param velocity_rpm 現在の速度 [RPM]
   * @param temperature 温度
   * @param fault_code 故障コード
   * @return 取得成功/失敗
   */
  virtual bool getMotorStatus(int motor_id, int& velocity_rpm, uint8_t& temperature,
                              uint8_t& fault_code) = 0;

  /**
   * @brief 指定したモータを停止
   * @param motor_id モータID
   * @return 停止成功/失敗
   */
  virtual bool stopMotor(int motor_id) = 0;

  /**
   * @brief 全モータを停止
   * @return 停止成功/失敗
   */
  virtual bool stopAllMotors() = 0;

  /**
   * @brief モータ設定の取得/設定
   */
  virtual bool setMaxRpm(int max_rpm) = 0;
  virtual int getMaxRpm() const = 0;
};

/**
 * @brief Drive機能のインターフェース
 */
class IDriveMotor {
public:
  virtual ~IDriveMotor() = default;

  /**
   * @brief 速度指令を送信
   * @param linear_x 前進速度 [m/s]
   * @param angular_z 角速度 [rad/s]
   * @return 指令送信成功/失敗
   */
  virtual bool setVelocity(double linear_x, double angular_z) = 0;

  /**
   * @brief 停止
   */
  virtual void stop() = 0;

  /**
   * @brief 現在の速度を取得
   * @param linear_x 現在の前進速度 [m/s]
   * @param angular_z 現在の角速度 [rad/s]
   * @return 取得成功/失敗
   */
  virtual bool getCurrentVelocity(double& linear_x, double& angular_z) const = 0;
};

/**
 * @brief Shot機能のインターフェース
 */
class IShotMotor {
public:
  virtual ~IShotMotor() = default;

  /**
   * @brief 発射速度を設定
   * @param speed 発射速度（モータ依存の単位）
   * @return 設定成功/失敗
   */
  virtual bool setShotSpeed(double speed) = 0;

  /**
   * @brief 発射角度を設定
   * @param angle 発射角度 [degree]
   * @return 設定成功/失敗
   */
  virtual bool setShotAngle(double angle) = 0;

  /**
   * @brief 発射実行
   * @return 発射成功/失敗
   */
  virtual bool executeFire() = 0;

  /**
   * @brief 発射準備完了状態を確認
   * @return 準備完了かどうか
   */
  virtual bool isReadyToFire() const = 0;

  /**
   * @brief 発射機構を停止
   */
  virtual void stopFiring() = 0;
};

}  // namespace motor_control_lib

#endif  // MOTOR_CONTROL_LIB__BASE_MOTOR_CONTROLLER_HPP_
