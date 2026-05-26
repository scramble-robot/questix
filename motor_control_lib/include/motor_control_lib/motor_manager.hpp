// Copyright 2026 scramble-robot
//
#ifndef MOTOR_CONTROL_LIB__MOTOR_MANAGER_HPP_
#define MOTOR_CONTROL_LIB__MOTOR_MANAGER_HPP_

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "motor_control_lib/base_motor_controller.hpp"

namespace motor_control_lib {

/**
 * @brief モータ管理クラス
 * 複数のモータコントローラーを統合管理
 */
class MotorManager {
public:
  MotorManager() = default;
  virtual ~MotorManager() = default;

  /**
   * @brief モータコントローラーを登録
   * @param name コントローラー名
   * @param controller モータコントローラー
   * @return 登録成功/失敗
   */
  bool registerController(const std::string& name, std::shared_ptr<BaseMotorController> controller);

  /**
   * @brief 個別モータコントローラーを登録
   * @param name コントローラー名
   * @param controller 個別モータコントローラー
   * @return 登録成功/失敗
   */
  bool registerIndividualMotorController(const std::string& name,
                                         std::shared_ptr<IIndividualMotor> controller);

  /**
   * @brief 差動駆動コントローラーを登録
   * @param name コントローラー名
   * @param controller 差動駆動コントローラー
   * @return 登録成功/失敗
   */
  bool registerDriveController(const std::string& name, std::shared_ptr<IDriveMotor> controller);

  /**
   * @brief 射撃コントローラーを登録
   * @param name コントローラー名
   * @param controller 射撃コントローラー
   * @return 登録成功/失敗
   */
  bool registerShotController(const std::string& name, std::shared_ptr<IShotMotor> controller);

  /**
   * @brief 全コントローラーを初期化
   * @return 初期化成功/失敗
   */
  bool initializeAll();

  /**
   * @brief 全コントローラーを終了
   */
  void shutdownAll();

  /**
   * @brief 緊急停止
   */
  void emergencyStopAll();

  /**
   * @brief 全コントローラーの健康状態をチェック
   * @return 全て正常かどうか
   */
  bool isAllHealthy() const;

  /**
   * @brief コントローラーを取得
   */
  template <typename T>
  std::shared_ptr<T> getController(const std::string& name) const;

  /**
   * @brief 個別モータコントローラーを取得
   */
  std::shared_ptr<IIndividualMotor> getIndividualMotorController(const std::string& name) const;

  /**
   * @brief 差動駆動コントローラーを取得
   */
  std::shared_ptr<IDriveMotor> getDriveController(const std::string& name) const;

  /**
   * @brief 射撃コントローラーを取得
   */
  std::shared_ptr<IShotMotor> getShotController(const std::string& name) const;

  /**
   * @brief 登録されているコントローラー名の一覧を取得
   */
  std::vector<std::string> getControllerNames() const;

  /**
   * @brief システム全体のステータスを取得
   */
  struct SystemStatus {
    size_t total_controllers;
    size_t healthy_controllers;
    size_t initialized_controllers;
    std::map<std::string, bool> controller_health;
    std::map<std::string, bool> controller_initialized;
  };
  SystemStatus getSystemStatus() const;

private:
  std::map<std::string, std::shared_ptr<BaseMotorController>> base_controllers_;
  std::map<std::string, std::shared_ptr<IIndividualMotor>> individual_controllers_;
  std::map<std::string, std::shared_ptr<IDriveMotor>> drive_controllers_;
  std::map<std::string, std::shared_ptr<IShotMotor>> shot_controllers_;
};

// Template implementation
template <typename T>
std::shared_ptr<T> MotorManager::getController(const std::string& name) const {
  auto it = base_controllers_.find(name);
  if (it != base_controllers_.end()) {
    return std::dynamic_pointer_cast<T>(it->second);
  }
  return nullptr;
}

}  // namespace motor_control_lib

#endif  // MOTOR_CONTROL_LIB__MOTOR_MANAGER_HPP_
