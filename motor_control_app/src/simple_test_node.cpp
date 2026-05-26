// Copyright 2026 scramble-robot
//
#include <iostream>
#include <memory>

#include "motor_control_lib/ddt_motor_lib.hpp"
#include "motor_control_lib/motor_manager.hpp"

using namespace motor_control_lib;

// 簡単なモックコントローラー（シリアル通信なしでテスト用）
class MockMotorController : public BaseMotorController, public IIndividualMotor {
private:
  std::map<int, int> motor_rpms_;
  std::map<int, uint8_t> motor_temperatures_;
  std::map<int, uint8_t> motor_fault_codes_;
  int max_rpm_;

public:
  explicit MockMotorController(const std::string& name)
      : BaseMotorController(name), max_rpm_(1000) {}

  // BaseMotorController implementation
  bool initialize() override {
    initialized_ = true;
    std::cout << "Mock Controller [" << name_ << "] 初期化成功" << std::endl;
    return true;
  }

  void shutdown() override {
    initialized_ = false;
    std::cout << "Mock Controller [" << name_ << "] シャットダウン完了" << std::endl;
  }

  bool isHealthy() const override { return initialized_; }

  void emergencyStop() override {
    for (auto& pair : motor_rpms_) {
      pair.second = 0;
    }
    std::cout << "Mock Controller [" << name_ << "] 緊急停止実行" << std::endl;
  }

  // IIndividualMotor implementation
  bool initializeMotor(int motor_id) override {
    motor_rpms_[motor_id] = 0;
    motor_temperatures_[motor_id] = 25;  // 25度
    motor_fault_codes_[motor_id] = 0;    // エラーなし
    std::cout << "Mock Motor " << motor_id << " 初期化完了" << std::endl;
    return true;
  }

  bool setMotorVelocity(int motor_id, int velocity_rpm) override {
    motor_rpms_[motor_id] = velocity_rpm;
    std::cout << "Mock Motor " << motor_id << " RPM設定: " << velocity_rpm << std::endl;
    return true;
  }

  bool getMotorStatus(int motor_id, int& velocity_rpm, uint8_t& temperature,
                      uint8_t& fault_code) override {
    auto rpm_it = motor_rpms_.find(motor_id);
    auto temp_it = motor_temperatures_.find(motor_id);
    auto fault_it = motor_fault_codes_.find(motor_id);

    if (rpm_it != motor_rpms_.end() && temp_it != motor_temperatures_.end() &&
        fault_it != motor_fault_codes_.end()) {
      velocity_rpm = rpm_it->second;
      temperature = temp_it->second;
      fault_code = fault_it->second;
      return true;
    }
    return false;
  }

  bool stopMotor(int motor_id) override {
    motor_rpms_[motor_id] = 0;
    std::cout << "Mock Motor " << motor_id << " 停止" << std::endl;
    return true;
  }

  bool stopAllMotors() override {
    for (auto& pair : motor_rpms_) {
      pair.second = 0;
    }
    std::cout << "Mock Controller [" << name_ << "] 全モータ停止" << std::endl;
    return true;
  }

  bool setMaxRpm(int max_rpm) override {
    max_rpm_ = max_rpm;
    std::cout << "Mock Controller [" << name_ << "] 最大RPM設定: " << max_rpm << std::endl;
    return true;
  }

  int getMaxRpm() const override { return max_rpm_; }
};

int main() {
  std::cout << "=== Motor Control Library Test ===" << std::endl;

  // モータマネージャーのテスト
  MotorManager manager;

  // Mock モータコントローラーを作成して登録
  auto mock_controller = std::make_shared<MockMotorController>("test_mock");
  manager.registerController("mock", mock_controller);
  manager.registerIndividualMotorController("mock", mock_controller);

  std::cout << "\n--- Controller Initialization ---" << std::endl;

  // 全コントローラー初期化
  if (manager.initializeAll()) {
    std::cout << "全コントローラー初期化成功" << std::endl;
  }

  // 個別モータ制御取得
  auto individual_controller = manager.getIndividualMotorController("mock");
  if (!individual_controller) {
    std::cerr << "Mock individual controller not found!" << std::endl;
    return 1;
  }

  std::cout << "\n--- Individual Motor Control Test ---" << std::endl;

  // 個別モータ初期化
  individual_controller->initializeMotor(1);
  individual_controller->initializeMotor(2);

  // RPM設定テスト
  individual_controller->setMotorVelocity(1, 100);
  individual_controller->setMotorVelocity(2, -150);

  // ステータス確認
  int rpm1, rpm2;
  uint8_t temp1, temp2, fault1, fault2;

  if (individual_controller->getMotorStatus(1, rpm1, temp1, fault1)) {
    std::cout << "Motor 1 Status: RPM=" << rpm1 << ", Temp=" << static_cast<int>(temp1) << "°C"
              << ", Fault=" << static_cast<int>(fault1) << std::endl;
  }

  if (individual_controller->getMotorStatus(2, rpm2, temp2, fault2)) {
    std::cout << "Motor 2 Status: RPM=" << rpm2 << ", Temp=" << static_cast<int>(temp2) << "°C"
              << ", Fault=" << static_cast<int>(fault2) << std::endl;
  }

  std::cout << "\n--- System Status Check ---" << std::endl;

  // システム健全性チェック
  auto system_status = manager.getSystemStatus();
  std::cout << "総コントローラー数: " << system_status.total_controllers << std::endl;
  std::cout << "健全コントローラー数: " << system_status.healthy_controllers << std::endl;
  std::cout << "初期化済みコントローラー数: " << system_status.initialized_controllers << std::endl;

  // コントローラー一覧
  auto controller_names = manager.getControllerNames();
  std::cout << "登録されているコントローラー: ";
  for (const auto& name : controller_names) {
    std::cout << name << " ";
  }
  std::cout << std::endl;

  // 個別モータ機能テスト
  std::cout << "\n--- Additional Motor Functions Test ---" << std::endl;
  individual_controller->setMaxRpm(2000);
  std::cout << "現在の最大RPM: " << individual_controller->getMaxRpm() << std::endl;

  // モータ停止テスト
  individual_controller->stopMotor(1);
  individual_controller->stopAllMotors();

  // 緊急停止テスト
  individual_controller->setMotorVelocity(1, 500);
  individual_controller->setMotorVelocity(2, 300);
  manager.emergencyStopAll();

  // シャットダウン
  manager.shutdownAll();
  std::cout << "\n=== テスト完了 ===" << std::endl;

  return 0;
}
