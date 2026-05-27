// Copyright 2026 scramble-robot
//
#ifndef MOTOR_CONTROL_APP__SERVO_CONTROL_HPP_
#define MOTOR_CONTROL_APP__SERVO_CONTROL_HPP_

#include <cstdint>
#include <map>
#include <memory>
#include <string>

namespace motor_control_app {

/**
 * @brief サーボコントローラー基底クラス
 */
class ServoControllerBase {
public:
  ServoControllerBase() = default;
  virtual ~ServoControllerBase() = default;

  /**
   * @brief サーボに接続
   * @return 成功時true
   */
  virtual bool connect() = 0;

  /**
   * @brief 接続を切断
   */
  virtual void disconnect() = 0;

  /**
   * @brief 指定位置にサーボを移動
   * @param servo_id サーボID
   * @param position 目標位置 (0-4095)
   * @param enable_torque トルク有効化
   * @param timeout タイムアウト時間
   * @return 成功時true
   */
  virtual bool setPosition(uint8_t servo_id, uint16_t position, bool enable_torque = true,
                           double timeout = 5.0) = 0;

  /**
   * @brief 現在位置を読み取り
   * @param servo_id サーボID
   * @return 現在位置（失敗時-1）
   */
  virtual int32_t getCurrentPosition(uint8_t servo_id) = 0;

  /**
   * @brief レジスタ値を読み取り
   * @param servo_id サーボID
   * @param address レジスタアドレス
   * @return レジスタ値（失敗時-1）
   */
  virtual int32_t readRegister(uint8_t servo_id, uint16_t address) = 0;

  /**
   * @brief レジスタに値を書き込み
   * @param servo_id サーボID
   * @param address レジスタアドレス
   * @param value 書き込み値
   * @return 成功時true
   */
  virtual bool writeRegister(uint8_t servo_id, uint16_t address, uint16_t value) = 0;

  /**
   * @brief 接続状態を確認
   * @return 接続済みの場合true
   */
  virtual bool isConnected() const = 0;
};

/**
 * @brief FEETECH磁気エンコーダ版サーボ用コントローラー
 */
class FeetechServoController : public ServoControllerBase {
public:
  /**
   * @brief コンストラクタ
   * @param port シリアルポート
   * @param baudrate ボーレート
   */
  FeetechServoController(const std::string& port = "/dev/ttyUSB0", int baudrate = 115200);

  virtual ~FeetechServoController();

  bool connect() override;
  void disconnect() override;
  bool setPosition(uint8_t servo_id, uint16_t position, bool enable_torque = true,
                   double timeout = 5.0) override;
  int32_t getCurrentPosition(uint8_t servo_id) override;
  int32_t readRegister(uint8_t servo_id, uint16_t address) override;
  bool writeRegister(uint8_t servo_id, uint16_t address, uint16_t value) override;
  bool isConnected() const override;

private:
  struct RegisterInfo {
    std::string name;
    uint16_t value;
    std::string type;
    std::string description;
  };

  // シリアル通信関連
  std::string port_;
  int baudrate_;
  int serial_fd_;
  bool connected_;

  // 既知のレジスタマップ
  std::map<uint16_t, RegisterInfo> known_registers_;

  /**
   * @brief Modbus CRC16計算
   * @param data データ配列
   * @param length データ長
   * @return CRC16値
   */
  uint16_t calculateCRC16(const uint8_t* data, size_t length);

  /**
   * @brief Modbusコマンド作成
   * @param slave_id スレーブID
   * @param function_code ファンクションコード
   * @param address アドレス
   * @param value 値
   * @param command 出力バッファ
   * @return コマンド長
   */
  size_t createModbusCommand(uint8_t slave_id, uint8_t function_code, uint16_t address,
                             uint16_t value, uint8_t* command);

  /**
   * @brief チェックサム検証
   * @param data データ配列
   * @param length データ長
   * @return 検証成功時true
   */
  bool verifyChecksum(const uint8_t* data, size_t length);

  /**
   * @brief コマンド送信
   * @param cmd_bytes コマンドバイト配列
   * @param cmd_length コマンド長
   * @param response 応答バッファ
   * @param max_response_length 最大応答長
   * @param expect_response 応答期待フラグ
   * @return 応答長（失敗時-1）
   */
  int sendCommand(const uint8_t* cmd_bytes, size_t cmd_length, uint8_t* response,
                  size_t max_response_length, bool expect_response = true);

  /**
   * @brief レジスタマップを初期化
   */
  void initializeRegisterMap();
};

/**
 * @brief 射撃制御クラス
 */
class ShotController {
public:
  /**
   * @brief コンストラクタ
   * @param servo_controller サーボコントローラー
   */
  explicit ShotController(std::shared_ptr<ServoControllerBase> servo_controller);

  /**
   * @brief 射撃位置設定
   * @param pan_servo_id パンサーボID
   * @param tilt_servo_id チルトサーボID
   * @param pan_position パン位置
   * @param tilt_position チルト位置
   * @param timeout タイムアウト時間
   * @return 成功時true
   */
  bool aimAt(uint8_t pan_servo_id, uint8_t tilt_servo_id, uint16_t pan_position,
             uint16_t tilt_position, double timeout = 5.0);

  /**
   * @brief 射撃実行
   * @param trigger_servo_id トリガーサーボID
   * @param fire_position 射撃位置
   * @param return_position 復帰位置
   * @param fire_duration 射撃持続時間（秒）
   * @return 成功時true
   */
  bool fire(uint8_t trigger_servo_id, uint16_t fire_position, uint16_t return_position,
            double fire_duration = 0.5);

  /**
   * @brief ホーム位置に戻る
   * @param pan_servo_id パンサーボID
   * @param tilt_servo_id チルトサーボID
   * @param trigger_servo_id トリガーサーボID
   * @param pan_home パンホーム位置
   * @param tilt_home チルトホーム位置
   * @param trigger_home トリガーホーム位置
   * @return 成功時true
   */
  bool returnHome(uint8_t pan_servo_id, uint8_t tilt_servo_id, uint8_t trigger_servo_id,
                  uint16_t pan_home = 2048, uint16_t tilt_home = 2048,
                  uint16_t trigger_home = 2048);

  /**
   * @brief 現在の狙い位置を取得
   * @param pan_servo_id パンサーボID
   * @param tilt_servo_id チルトサーボID
   * @param pan_position パン位置出力
   * @param tilt_position チルト位置出力
   * @return 成功時true
   */
  bool getCurrentAim(uint8_t pan_servo_id, uint8_t tilt_servo_id, int32_t& pan_position,
                     int32_t& tilt_position);

private:
  std::shared_ptr<ServoControllerBase> servo_controller_;
};

}  // namespace motor_control_app

#endif  // MOTOR_CONTROL_APP__SERVO_CONTROL_HPP_
