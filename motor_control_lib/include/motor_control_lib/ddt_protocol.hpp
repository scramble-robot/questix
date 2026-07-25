// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_LIB__DDT_PROTOCOL_HPP_
#define MOTOR_CONTROL_LIB__DDT_PROTOCOL_HPP_

#include <cstdint>
#include <vector>

namespace motor_control_lib::ddt_protocol {

/**
 * @brief DDT モータ (M0602C) の通信フレーム pack/parse を提供する純粋関数群。
 *
 * ここに含まれる関数はシリアル I/O や rclcpp に一切依存せず、
 * バイト列の組み立て・分解と CRC 計算のみを行う（単体テスト可能）。
 *
 * マルチバイトフィールドは全て big-endian (high, low) で並ぶ。
 * 各 pack 関数は 9 バイトのペイロード + 末尾 CRC8 = 全 10 バイトの完全なフレームを返す。
 */

/**
 * @brief CRC8/MAXIM (poly 0x8C reflected, init 0x00) を計算する。
 */
uint8_t crc8Maxim(const std::vector<uint8_t>& data);

/**
 * @brief モード切替フレーム (Protocol 3) を組み立てる。
 *
 * 仕様書: {ID, 0xA0, 0,0,0,0,0,0, 0, mode_value} （DATA[9] が mode_value で CRC 無し）
 * 既存実装互換: DATA[8] に mode_value を入れ DATA[9] を CRC8(data[0..8]) とする独自レイアウト。
 *   既存 velocity 切替 (mode_value=0) はこの形で実機動作実績がある。
 *   電流モードで意図通り切替できない場合は仕様書通りの形 (DATA[9]=mode_value, CRC無し) に
 *   フォールバックすること。
 *
 * @param motor_id   モータ ID (DATA[0])
 * @param mode_value モード値 (DATA[8] に格納する。0x01=電流ループ, 0x02=速度ループ)
 * @return 全 10 バイトのフレーム
 */
std::vector<uint8_t> packModeFrame(uint8_t motor_id, uint8_t mode_value);

/**
 * @brief 速度指令フレーム (Protocol 1, 0x64) を組み立てる。
 *
 * 仕様 (M0602C プロトコル1): DATA[2]=指令上位8bit, DATA[3]=指令下位8bit。
 * マルチバイトは big-endian (high, low)。packCurrentFrame と同じ並び。
 * DATA[6]=加速時間, DATA[7]=ブレーキ（0xFF でブレーキ、速度ループモードのみ有効）。
 *
 * @param motor_id     モータ ID
 * @param velocity_rpm 目標 RPM（int16 として big-endian で格納）
 * @param accel_time   加速時間 (DATA[6])
 * @param brake        true で DATA[7]=0xFF（電気ブレーキ）
 * @return 全 10 バイトのフレーム
 */
std::vector<uint8_t> packVelocityFrame(uint8_t motor_id, int16_t velocity_rpm, uint8_t accel_time,
                                       bool brake);

/**
 * @brief 電流指令フレーム (Protocol 1, 0x64) を組み立てる。
 *
 * 仕様: DATA[2]=指令上位, DATA[3]=指令下位（電流モードでは -32767..32767 が -8A..8A）。
 * 電流モードでは acceleration / brake バイトは無効。
 * マルチバイトは big-endian (high, low)。
 *
 * @param motor_id    モータ ID
 * @param current_raw 電流指令の生値（int16 として big-endian で格納）
 * @return 全 10 バイトのフレーム
 */
std::vector<uint8_t> packCurrentFrame(uint8_t motor_id, int16_t current_raw);

/**
 * @brief Protocol 1 (0x64) の指令値 0 フレーム（停止指令）かを判定する。
 *
 * DATA[1]==0x64 かつ DATA[2..3]（指令値）が 0 のとき true。ブレーキバイトの有無は問わない
 * （brake_on_stop 無効時の停止フレームも対象）。refreshMotorFeedback が停止フレームの
 * 再送を stopMotor と同じ再送間隔スロットルに従わせるための判定に使う。
 *
 * @param frame 送信フレーム（全 10 バイトを期待。異なる長さは false）
 */
bool isZeroVelocityFrame(const std::vector<uint8_t>& frame);

/**
 * @brief Protocol 1 応答フレームのデコード結果。
 */
struct Feedback {
  uint8_t mode;
  int16_t current;    // トルク電流の生値（符号付き）: -32767..32767 <-> -8..+8 A
  int16_t speed;      // 実測 RPM（符号付き）
  uint16_t position;  // ロータ位置: 0..32767 <-> 0..360 deg
  uint8_t fault_code;
};

/**
 * @brief トルク電流の生値 [-32767..32767] を電流 [A] に変換する。
 *  仕様: 生値 32767 が +8A、-32767 が -8A に対応する。
 */
constexpr float currentRawToAmp(int16_t raw) { return static_cast<float>(raw) * 8.0f / 32767.0f; }

/**
 * @brief parseFeedbackFrame の結果コード。
 */
enum class ParseResult {
  kOk,
  kBadLength,
  kIdMismatch,
  kCrcMismatch,
};

/**
 * @brief Protocol 1 応答フレーム (DDT M0602C 仕様) をデコードする。
 *
 *  DATA[1]=mode, DATA[2..3]=torque current, DATA[4..5]=speed (signed),
 *  DATA[6..7]=position, DATA[8]=fault code。
 * マルチバイトは big-endian (high, low)。
 *
 * 検証順: 長さ==10 → 先頭 ID 一致 → CRC8(先頭9バイト)==frame[9]。
 *
 * @param expected_motor_id 期待するモータ ID (frame[0] と照合)
 * @param frame             受信フレーム（10 バイトを期待）
 * @param out               デコード結果（kOk のときのみ更新される）
 * @return ParseResult
 */
ParseResult parseFeedbackFrame(uint8_t expected_motor_id, const std::vector<uint8_t>& frame,
                               Feedback& out);

}  // namespace motor_control_lib::ddt_protocol

#endif  // MOTOR_CONTROL_LIB__DDT_PROTOCOL_HPP_
