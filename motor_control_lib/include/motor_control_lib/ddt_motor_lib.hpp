// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_LIB__DDT_MOTOR_LIB_HPP_
#define MOTOR_CONTROL_LIB__DDT_MOTOR_LIB_HPP_

#include <fcntl.h>
#include <termios.h>
#include <unistd.h>

#include <chrono>
#include <cmath>
#include <map>
#include <mutex>
#include <rclcpp/clock.hpp>
#include <vector>

#include "motor_control_lib/base_motor_controller.hpp"
#include "motor_control_lib/ddt_current_pi.hpp"

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

  /**
   * @brief Current モードのゼロ近傍デッドバンド設定
   *  - 目標 RPM が 0 かつ実測 RPM の絶対値が deadband_rpm 以下のとき、PI を停止し
   *    電流指令を 0、積分項をリセットする（静止時の微振動防止）。
   */
  void setCurrentZeroDeadbandRpm(int deadband_rpm);

  /**
   * @brief 送信する目標RPMへのヒステリシス（不感帯）を設定（velocity/current 両モード共通）。
   *  - 前回コミットした目標RPMからの変化量が hysteresis_rpm 未満なら、新しい値ではなく
   *    前回送信値を使い続ける。ジョイスティック等の入力ノイズによる微小な目標揺らぎが
   *    そのままファームへ伝わり、実回転数の微振動になるのを防ぐ。
   *  - 明示的な 0（停止）指令には適用しない（常に即座に反映する）。
   */
  void setCommandRpmHysteresis(int hysteresis_rpm);

  /**
   * @brief Current モード PI 内で measured RPM を符号反転するか設定。
   *  指令とフィードバックの物理符号が逆だと正帰還となり発振するため、その補正用。
   */
  void setCurrentInvertMeasured(bool invert);

  /**
   * @brief Current モードの目標RPMスルーレート制限（加速度制限）
   *  - 1秒あたりに許容する目標RPMの変化量を指定する。
   *  - 0 以下の値で制限を無効化。
   */
  void setCurrentMaxAccelRpmPerSec(double rpm_per_sec);

  /**
   * @brief 停止時に電気ブレーキ（Protocol 1 の DATA[7]=0xFF）を使うか設定。
   *  - true のとき、stopMotor / emergencyStop の velocity 経路で目標0とともに
   *    ブレーキ指令を送り、しっかり停止・保持する。
   *  - ブレーキは速度ループモードでのみ有効（仕様）。current モードは対象外。
   */
  void setBrakeOnStop(bool enable);

  /**
   * @brief 指令送信後の追加待機時間 [ms] を設定（velocity / current 送信経路共通）。
   *  - 既定 0（待機なし）。応答待ち（最大10ms）が自然なコマンド間隔になるため通常は不要。
   *  - DDT M0602C の最小コマンド間隔が実機検証で必要と判明した場合のみ >0 を設定する。
   *  - 注意: 待機は state_mutex_ 保持中に行われるため、>0 にするとその分呼び出し元を
   *    ブロックする（50Hz 指令なら 20ms 未満に収めること）。
   */
  void setCommandWaitMs(int wait_ms);

  /**
   * @brief 停止状態が継続している間の、ブレーキ指令の再送間隔 [ms] を設定（velocity モードのみ）。
   *  - stopMotor() は呼ばれるたびに毎回ブレーキ（Protocol 1 の DATA[7]=0xFF）を送信していたが、
   *    高頻度（~20Hz）で送り続けると、残留回転がある間は毎回新規の制動として作用し、収束せず
   *    持続的な振動（リミットサイクル）を起こすことがある（cf. 停止直後の足回り振動の rosbag 解析）。
   *  - 既に停止（目標RPM=0）と分かっている状態が続く間は、この間隔未満の再呼び出しは実際の
   *    シリアル送信をスキップする。0 で無効（従来通り毎回送信）。
   *  - 停止直後の最初の1回、および emergencyStop() には適用されない（常に即座に送信する）。
   */
  void setStopResendIntervalMs(int interval_ms);

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

  /**
   * @brief 1 モータ分の詳細フィードバック（型付きステータストピック publish 用）。
   *  getMotorStatus よりリッチな内容（mode / 電流生値 / 位置 / 目標 RPM / 鮮度）を返す。
   */
  struct MotorFeedbackData {
    uint8_t motor_id{0};
    uint8_t mode{0};
    int16_t current_raw{0};    // トルク電流生値（符号付き）
    int16_t velocity_rpm{0};   // 実測 RPM
    int16_t target_rpm{0};     // 最終指令値（クランプ後）
    uint16_t position_raw{0};  // ロータ位置
    uint8_t temperature{0};    // 常に 0（Protocol 2 (0x74) 未実装）
    uint8_t fault_code{0};
    bool has_feedback{false};      // 一度でも有効フィードバックを受信したか
    double feedback_age_sec{0.0};  // has_feedback のときのみ有効な受信経過秒
  };

  /**
   * @brief 指定モータの詳細フィードバックを取得する。
   * @return 登録済みモータなら true（out を更新）。未登録/未初期化なら false。
   */
  bool getMotorFeedbackData(int motor_id, MotorFeedbackData& out) const;

  /**
   * @brief 鮮度ゲート付きフィードバックポーリング。
   *  保持フィードバックが max_age_sec より新しければ何もしない。古ければ、
   *  ファームが既に実行中の「最後に送ったフレーム」をそのまま再送し、既存の
   *  10ms タイムアウト内で新しいフィードバック応答を引き出す。新規プロトコル
   *  コマンドは発行せず、固定スリープもしない（呼び出しは 1 回の
   *  sendFrameWithFeedback で上限付き）。
   *
   *  保持フレームをそのまま再送するため、ブレーキバイト等のコマンド状態を厳密に
   *  保持する。走行中はフィードバックが新鮮なので実質 no-op。アイドル時のみ
   *  1 モータあたり最悪 ~10ms のシリアル待ちが加わる点に注意（呼び出し元が
   *  単一スレッドエグゼキュータでステータスタイマーから呼ぶ前提）。
   * @return 呼び出し後にフィードバックが新鮮なら true。
   */
  bool refreshMotorFeedback(int motor_id, double max_age_sec = 0.05);

private:
  // Motor feedback structure
  struct MotorFeedback {
    uint8_t mode{0};
    int16_t current{0};      // トルク電流生値（符号付き）: DATA[2..3]
    int16_t speed{0};        // 実測 RPM（符号付き）: DATA[4..5]
    uint16_t position{0};    // ロータ位置: DATA[6..7]
    uint8_t temperature{0};  // 常に 0（Protocol 2 (0x74) 未実装）
    uint8_t fault_code{0};
    bool has_feedback{false};  // 一度でも有効フィードバックを parse したか
    std::chrono::steady_clock::time_point last_feedback_time{};  // 最終受信時刻
  };

  // Current モード用 PI 状態（モータ毎）
  struct PiState {
    ddt_current_pi::State pi;
    int16_t last_measured_rpm{0};
    std::chrono::steady_clock::time_point last_t{};
    bool has_last_t{false};
    double ref_rpm_filtered{0.0};
    std::chrono::steady_clock::time_point last_ref_t{};
    bool has_last_ref_t{false};
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
  int current_zero_deadband_rpm_;         // 静止デッドバンド [RPM]
  int command_rpm_hysteresis_;  // 送信目標RPMへのヒステリシス [RPM]（0以外の指令のみ対象）
  bool current_invert_measured_;          // measured RPM 符号反転（正帰還押さえ用）
  double current_max_accel_rpm_per_sec_;  // 目標RPMスルーレート上限 [RPM/s]。0以下で無効
  bool brake_on_stop_;  // 停止時に電気ブレーキを使う（velocity モードのみ）
  int command_wait_ms_;  // 指令送信後の追加待機 [ms]。0で無効（実機の間隔要件用の保険）
  int stop_resend_interval_ms_;  // 停止継続中のブレーキ再送間隔 [ms]。0で無効（毎回送信）

  // Serial communication
  int serial_fd_;
  rclcpp::Clock throttle_clock_{RCL_STEADY_TIME};

  // 公開APIから触る状態マップとシリアル送受信の保護。
  // 公開メソッド同士が内部で呼び合うため recursive_mutex を使う。
  mutable std::recursive_mutex state_mutex_;

  // Motor state tracking
  std::map<int, int> motor_velocities_;           // motor_id -> target velocity_rpm
  std::map<int, MotorFeedback> motor_feedbacks_;  // motor_id -> feedback
  std::map<int, ControlMode> motor_modes_;        // motor_id -> control mode
  std::map<int, PiState> pi_states_;              // motor_id -> PI state
  // motor_id -> 最後に送った駆動フレーム（refreshMotorFeedback の再送用）
  std::map<int, std::vector<uint8_t>> last_sent_frames_;
  // motor_id -> stopMotor() が実際にシリアル送信した直近時刻（再送間隔スロットリング用）
  std::map<int, std::chrono::steady_clock::time_point> last_stop_send_time_;

  // Private methods
  bool initializeSerial();
  void closeSerial();
  bool setModeVelocity(
      int motor_id);  // 後方互換のため残置（内部で setControlMode(Velocity) を呼ぶ）
  bool sendMotorVelocity(int motor_id, int velocity_rpm,
                         bool brake = false);                   // velocity モード送信
  bool sendMotorCurrentRaw(int motor_id, int16_t current_raw);  // current モード送信＋応答受信
  // 高頻度指令の共通送受信: 固定スリープなしで送信し、応答フィードバックを短い
  // タイムアウトで1回だけ待つ（タイムアウトしても送信成功として扱う）。
  bool sendFrameWithFeedback(int motor_id, const std::vector<uint8_t>& frame);
  int16_t runCurrentLoopStep(int motor_id, int rpm_ref);  // PI 1ステップ
  void resetCurrentPiStateForStop(int motor_id);
  bool readFeedbackFrame(int expected_motor_id, std::vector<uint8_t>& out_frame, int timeout_ms);
  bool parseFeedback(int expected_motor_id, const std::vector<uint8_t>& frame);

  // Utility methods
  bool drainSerialOutput();
  bool sendCommand(const std::vector<uint8_t>& command, int retry_count = 3);
  ssize_t writeSerial(const void* data, size_t size);
  ssize_t readSerial(void* data, size_t size);
};

}  // namespace motor_control_lib

#endif  // MOTOR_CONTROL_LIB__DDT_MOTOR_LIB_HPP_
