// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_LIB__FEETECH_PROTOCOL_HPP_
#define MOTOR_CONTROL_LIB__FEETECH_PROTOCOL_HPP_

#include <cstddef>
#include <cstdint>

namespace motor_control_lib::feetech_protocol {

/**
 * @brief Modbus CRC16計算
 * @param data データ配列
 * @param length データ長
 * @return CRC16値
 *
 * CRC-16/MODBUS (init 0xFFFF, poly 0xA001)。
 */
uint16_t calculateCrc16(const uint8_t* data, size_t length);

/**
 * @brief Modbusコマンド作成
 * @param slave_id スレーブID
 * @param function_code ファンクションコード
 * @param address アドレス
 * @param value 値
 * @param command 出力バッファ（8バイト以上）
 * @return コマンド長（常に8）
 *
 * 8バイトを書き込む: [id][fc][addrH][addrL][valH][valL][crcL][crcH]。
 * バイトオーダは混在: アドレスと値はビッグエンディアン、CRCはリトル
 * エンディアン（Modbus-RTU）。
 */
size_t createModbusCommand(uint8_t slave_id, uint8_t function_code, uint16_t address,
                           uint16_t value, uint8_t* command);

/**
 * @brief チェックサム検証
 * @param data データ配列
 * @param length データ長
 * @return 検証成功時true
 *
 * length < 3 の場合は false。末尾2バイトをリトルエンディアンCRCとして
 * 検証する（Modbus-RTU）。
 */
bool verifyChecksum(const uint8_t* data, size_t length);

}  // namespace motor_control_lib::feetech_protocol

#endif  // MOTOR_CONTROL_LIB__FEETECH_PROTOCOL_HPP_
