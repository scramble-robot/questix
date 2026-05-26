// Copyright 2026 scramble-robot
//
#ifndef MOTOR_CONTROL_LIB__DDT_MOTOR_LIB_HPP_
#define MOTOR_CONTROL_LIB__DDT_MOTOR_LIB_HPP_

#include <fcntl.h>
#include <termios.h>
#include <unistd.h>

#include <chrono>
#include <cmath>
#include <map>
#include <vector>

#include "motor_control_lib/base_motor_controller.hpp"

namespace motor_control_lib {

/**
 * @brief DDTモータ制御ライブラリ
 * 個別モータ制御を提供
 */
class DdtMotorLib : public BaseMotorController, public IIndividualMotor {
public:
  explicit DdtMotorLib(const std::string& serial_port = "/dev/ttyACM0", int baud_rate = 115200);
  virtual ~DdtMotorLib();

  // BaseMotorController implementation
  bool initialize() override;
  void shutdown() override;
  bool isHealthy() const override;
  void emergencyStop() override;

  // IIndividualMotor implementation
  bool initializeMotor(int motor_id) override;
  bool setMotorVelocity(int motor_id, int velocity_rpm) override;
  bool getMotorStatus(int motor_id, int& velocity_rpm, uint8_t& temperature,
                      uint8_t& fault_code) override;
  bool stopMotor(int motor_id) override;
  bool stopAllMotors() override;
  bool setMaxRpm(int max_rpm) override;
  int getMaxRpm() const override;

  // DDT motor control methods (deprecated - use IIndividualMotor interface)

  // Multi-motor status
  struct MotorStatus {
    int motor_id;
    int velocity_rpm;
    uint8_t temperature;
    uint8_t fault_code;
    bool is_healthy;
  };
  std::vector<MotorStatus> getAllMotorStatus() const;

private:
  // Motor feedback structure
  struct MotorFeedback {
    uint8_t mode;
    uint16_t current;
    int16_t speed;
    uint8_t angle;
    uint8_t temperature;
    uint8_t fault_code;
  };

  // Configuration
  std::string serial_port_;
  int baud_rate_;
  int max_motor_rpm_;

  // Serial communication
  int serial_fd_;

  // Motor state tracking
  std::map<int, int> motor_velocities_;           // motor_id -> velocity_rpm
  std::map<int, MotorFeedback> motor_feedbacks_;  // motor_id -> feedback

  // Private methods
  bool initializeSerial();
  void closeSerial();
  bool setModeVelocity(int motor_id);
  bool sendMotorVelocity(int motor_id, int velocity_rpm);
  bool requestMotorFeedback(int motor_id);
  void processFeedbackResponse(int motor_id, const std::vector<uint8_t>& response);

  // Utility methods (M15 datasheet compliant)
  uint8_t crc8Maxim(const std::vector<uint8_t>& data);
  bool sendCommand(const std::vector<uint8_t>& command, int retry_count = 3);
  ssize_t writeSerial(const void* data, size_t size);
  ssize_t readSerial(void* data, size_t size);
};

}  // namespace motor_control_lib

#endif  // MOTOR_CONTROL_LIB__DDT_MOTOR_LIB_HPP_
