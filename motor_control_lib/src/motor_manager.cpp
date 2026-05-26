// Copyright 2026 scramble-robot
//
#include "motor_control_lib/motor_manager.hpp"

#include <algorithm>
#include <rclcpp/rclcpp.hpp>

namespace motor_control_lib {

bool MotorManager::registerController(const std::string& name,
                                      std::shared_ptr<BaseMotorController> controller) {
  if (!controller) {
    RCLCPP_ERROR(rclcpp::get_logger("MotorManager"), "コントローラー '%s' が null です",
                 name.c_str());
    return false;
  }

  base_controllers_[name] = controller;
  RCLCPP_INFO(rclcpp::get_logger("MotorManager"), "コントローラー '%s' を登録しました",
              name.c_str());
  return true;
}

bool MotorManager::registerIndividualMotorController(const std::string& name,
                                                     std::shared_ptr<IIndividualMotor> controller) {
  if (!controller) {
    RCLCPP_ERROR(rclcpp::get_logger("MotorManager"), "個別モータコントローラー '%s' が null です",
                 name.c_str());
    return false;
  }

  individual_controllers_[name] = controller;
  RCLCPP_INFO(rclcpp::get_logger("MotorManager"), "個別モータコントローラー '%s' を登録しました",
              name.c_str());
  return true;
}

bool MotorManager::registerDriveController(const std::string& name,
                                           std::shared_ptr<IDriveMotor> controller) {
  if (!controller) {
    RCLCPP_ERROR(rclcpp::get_logger("MotorManager"), "差動駆動コントローラー '%s' が null です",
                 name.c_str());
    return false;
  }

  drive_controllers_[name] = controller;
  RCLCPP_INFO(rclcpp::get_logger("MotorManager"), "差動駆動コントローラー '%s' を登録しました",
              name.c_str());
  return true;
}

bool MotorManager::registerShotController(const std::string& name,
                                          std::shared_ptr<IShotMotor> controller) {
  if (!controller) {
    RCLCPP_ERROR(rclcpp::get_logger("MotorManager"), "射撃コントローラー '%s' が null です",
                 name.c_str());
    return false;
  }

  shot_controllers_[name] = controller;
  RCLCPP_INFO(rclcpp::get_logger("MotorManager"), "射撃コントローラー '%s' を登録しました",
              name.c_str());
  return true;
}

bool MotorManager::initializeAll() {
  bool all_success = true;

  for (auto& [name, controller] : base_controllers_) {
    if (!controller->initialize()) {
      RCLCPP_ERROR(rclcpp::get_logger("MotorManager"), "コントローラー '%s' の初期化に失敗しました",
                   name.c_str());
      all_success = false;
    } else {
      RCLCPP_INFO(rclcpp::get_logger("MotorManager"), "コントローラー '%s' を初期化しました",
                  name.c_str());
    }
  }

  if (all_success) {
    RCLCPP_INFO(rclcpp::get_logger("MotorManager"), "全コントローラーの初期化が完了しました");
  } else {
    RCLCPP_WARN(rclcpp::get_logger("MotorManager"), "一部のコントローラーの初期化に失敗しました");
  }

  return all_success;
}

void MotorManager::shutdownAll() {
  for (auto& [name, controller] : base_controllers_) {
    try {
      controller->shutdown();
      RCLCPP_INFO(rclcpp::get_logger("MotorManager"), "コントローラー '%s' を終了しました",
                  name.c_str());
    } catch (const std::exception& e) {
      RCLCPP_ERROR(rclcpp::get_logger("MotorManager"), "コントローラー '%s' の終了中にエラー: %s",
                   name.c_str(), e.what());
    }
  }
}

void MotorManager::emergencyStopAll() {
  for (auto& [name, controller] : base_controllers_) {
    try {
      controller->emergencyStop();
      RCLCPP_WARN(rclcpp::get_logger("MotorManager"),
                  "コントローラー '%s' で緊急停止を実行しました", name.c_str());
    } catch (const std::exception& e) {
      RCLCPP_ERROR(rclcpp::get_logger("MotorManager"),
                   "コントローラー '%s' の緊急停止中にエラー: %s", name.c_str(), e.what());
    }
  }

  // 個別モータも停止
  for (auto& [name, controller] : individual_controllers_) {
    try {
      controller->stopAllMotors();
      RCLCPP_WARN(rclcpp::get_logger("MotorManager"),
                  "個別モータコントローラー '%s' で全モータを停止しました", name.c_str());
    } catch (const std::exception& e) {
      RCLCPP_ERROR(rclcpp::get_logger("MotorManager"),
                   "個別モータコントローラー '%s' の停止中にエラー: %s", name.c_str(), e.what());
    }
  }

  // 差動駆動も停止
  for (auto& [name, controller] : drive_controllers_) {
    try {
      controller->stop();
      RCLCPP_WARN(rclcpp::get_logger("MotorManager"), "差動駆動コントローラー '%s' を停止しました",
                  name.c_str());
    } catch (const std::exception& e) {
      RCLCPP_ERROR(rclcpp::get_logger("MotorManager"),
                   "差動駆動コントローラー '%s' の停止中にエラー: %s", name.c_str(), e.what());
    }
  }

  // 射撃機構も停止
  for (auto& [name, controller] : shot_controllers_) {
    try {
      controller->stopFiring();
      RCLCPP_WARN(rclcpp::get_logger("MotorManager"), "射撃コントローラー '%s' を停止しました",
                  name.c_str());
    } catch (const std::exception& e) {
      RCLCPP_ERROR(rclcpp::get_logger("MotorManager"),
                   "射撃コントローラー '%s' の停止中にエラー: %s", name.c_str(), e.what());
    }
  }
}

bool MotorManager::isAllHealthy() const {
  for (const auto& [name, controller] : base_controllers_) {
    if (!controller->isHealthy()) {
      return false;
    }
  }
  return true;
}

std::shared_ptr<IIndividualMotor> MotorManager::getIndividualMotorController(
    const std::string& name) const {
  auto it = individual_controllers_.find(name);
  if (it != individual_controllers_.end()) {
    return it->second;
  }
  return nullptr;
}

std::shared_ptr<IDriveMotor> MotorManager::getDriveController(const std::string& name) const {
  auto it = drive_controllers_.find(name);
  if (it != drive_controllers_.end()) {
    return it->second;
  }
  return nullptr;
}

std::shared_ptr<IShotMotor> MotorManager::getShotController(const std::string& name) const {
  auto it = shot_controllers_.find(name);
  if (it != shot_controllers_.end()) {
    return it->second;
  }
  return nullptr;
}

std::vector<std::string> MotorManager::getControllerNames() const {
  std::vector<std::string> names;

  for (const auto& [name, controller] : base_controllers_) {
    names.push_back(name);
  }

  return names;
}

MotorManager::SystemStatus MotorManager::getSystemStatus() const {
  SystemStatus status;
  status.total_controllers = base_controllers_.size();
  status.healthy_controllers = 0;
  status.initialized_controllers = 0;

  for (const auto& [name, controller] : base_controllers_) {
    bool is_healthy = controller->isHealthy();
    bool is_initialized = controller->isInitialized();

    status.controller_health[name] = is_healthy;
    status.controller_initialized[name] = is_initialized;

    if (is_healthy) {
      status.healthy_controllers++;
    }
    if (is_initialized) {
      status.initialized_controllers++;
    }
  }

  return status;
}

}  // namespace motor_control_lib
