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
 * @brief DDTモータ制御モード
 *  - Velocity: 既存の速度ループ（M0602C ファーム内蔵）
 *  - Current : 電流ループ。本ライブラリ内のソフトウェアPI制御で目標RPM→電流指令に変換
 */
enum class ControlMode {
  Velocity,
  Current,
};

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

  // ---- Current モード拡張 ----------------------------------------------------
  /**
   * @brief 指定モードでモータを初期化
   *  - Velocity: 既存挙動と同等
   *  - Current : 電流ループ用に setControlMode(Current) を送信し、PI状態を初期化
   */
  bool initializeMotor(int motor_id, ControlMode mode);

  /**
   * @brief モータ制御モードを切替（Protocol 3）
   */
  bool setControlMode(int motor_id, ControlMode mode);

  /**
   * @brief Current モード時のPIゲイン・上限を設定（全モータ共通）
   * @param kp                [A/rpm] 比例ゲイン
   * @param ki                [A/(rpm·s)] 積分ゲイン
   * @param max_current_amp   [A] 電流指令の絶対値上限（安全クランプ）
   * @param integral_limit_amp [A] 積分項寄与の絶対値上限（アンチワインドアップ）
   */
  void setCurrentControlParams(double kp, double ki, double max_current_amp,
                               double integral_limit_amp);

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

  // Current モード用 PI 状態（モータ毎）
  struct PiState {
    double integral_amp;                            // 積分項（A 単位）
    int16_t last_measured_rpm;                      // 直近のフィードバックRPM（受信失敗時の保持値）
    std::chrono::steady_clock::time_point last_t;  // 前回更新時刻
    bool has_last_t;                                // 初回判定
  };

  // Configuration
  std::string serial_port_;
  int baud_rate_;
  int max_motor_rpm_;

  // Current モード PI パラメータ（全モータ共通）
  double current_kp_;
  double current_ki_;
  double max_current_amp_;
  double integral_limit_amp_;

  // Serial communication
  int serial_fd_;

  // Motor state tracking
  std::map<int, int> motor_velocities_;           // motor_id -> target velocity_rpm
  std::map<int, MotorFeedback> motor_feedbacks_;  // motor_id -> feedback
  std::map<int, ControlMode> motor_modes_;        // motor_id -> control mode
  std::map<int, PiState> pi_states_;              // motor_id -> PI state

  // Private methods
  bool initializeSerial();
  void closeSerial();
  bool setModeVelocity(int motor_id);  // 後方互換のため残置（内部で setControlMode(Velocity) を呼ぶ）
  bool sendMotorVelocity(int motor_id, int velocity_rpm);  // velocity モード送信
  bool sendMotorCurrentRaw(int motor_id, int16_t current_raw);  // current モード送信＋応答受信
  int16_t runCurrentLoopStep(int motor_id, int rpm_ref);        // PI 1ステップ
  bool requestMotorFeedback(int motor_id);
  void processFeedbackResponse(int motor_id, const std::vector<uint8_t>& response);
  bool readFeedbackFrame(int expected_motor_id, std::vector<uint8_t>& out_frame, int timeout_ms);
  bool parseFeedback(int expected_motor_id, const std::vector<uint8_t>& frame);

  // Utility methods (M15 datasheet compliant)
  uint8_t crc8Maxim(const std::vector<uint8_t>& data);
  bool sendCommand(const std::vector<uint8_t>& command, int retry_count = 3);
  ssize_t writeSerial(const void* data, size_t size);
  ssize_t readSerial(void* data, size_t size);
};

}  // namespace motor_control_lib

#endif  // MOTOR_CONTROL_LIB__DDT_MOTOR_LIB_HPP_
