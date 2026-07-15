// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_LIB__DDT_CURRENT_PI_HPP_
#define MOTOR_CONTROL_LIB__DDT_CURRENT_PI_HPP_

#include <cstdint>

namespace motor_control_lib::ddt_current_pi {

/**
 * @brief DDT モータ Current モードのソフトウェア PI 制御を提供する純粋関数群。
 *
 * ここに含まれる関数はシリアル I/O・rclcpp・時刻取得に一切依存せず、
 * 目標 RPM と実測 RPM から電流指令 raw 値を計算するだけである（単体テスト可能）。
 * dt サニタイズ・ゼロ近傍デッドバンド判定も同様に純粋関数として切り出す。
 */

/**
 * @brief Current モード PI パラメータ（全モータ共通）。
 */
struct Params {
  double kp;               // [A/rpm] 比例ゲイン
  double ki;               // [A/(rpm·s)] 積分ゲイン
  double max_current_amp;  // [A] 電流指令の絶対値上限（安全クランプ）
  double integral_limit_amp;  // [A] 積分項寄与の絶対値上限（アンチワインドアップ）
  bool invert_measured;  // measured RPM 符号反転（正帰還押さえ用）
};

/**
 * @brief PI 積分器の状態（モータ毎に保持）。
 */
struct State {
  double integral_amp{0.0};
};

/**
 * @brief dt をサニタイズする。異常値（0 以下、または 0.2 を超える）は 0.01 に丸める。
 *  0.2 ちょうどは正常値として保持する。
 */
double sanitizeDt(double dt_seconds);

/**
 * @brief ゼロ近傍デッドバンド判定。目標 RPM が 0 かつ実測 RPM の絶対値が
 *  deadband_rpm 以下のとき true。実測 RPM は符号反転前の生値を渡すこと。
 */
bool inZeroDeadband(int rpm_ref, int measured_rpm, int deadband_rpm);

/**
 * @brief PI 1 ステップを実行し、電流指令 raw 値を返す純粋関数。
 *
 * 処理順は元実装 (DdtMotorLib::runCurrentLoopStep) と同一:
 *   measured を必要なら符号反転 → error = ref - measured → 積分項更新
 *   → アンチワインドアップ（積分項寄与 = Ki * integral を ±integral_limit_amp
 *     にクランプ。Ki<=1e-9 のときは積分項を 0 にリセット）
 *   → i_cmd = Kp*error + Ki*integral を ±max_current_amp にクランプ
 *   → -8A..8A が -32767..32767 に対応（仕様書）ので A→raw 換算し ±32767 でクランプ。
 *
 * @param state           PI 積分器の状態（更新される）。
 * @param params          PI パラメータ。
 * @param rpm_ref         目標 RPM。
 * @param measured_rpm    実測 RPM（符号反転前の生値）。
 * @param dt              サニタイズ済み dt [s]。
 * @param i_cmd_amp_out   非 null なら、クランプ後の電流指令 [A] を書き込む（ログ用）。
 * @return 電流指令 raw 値（±32767）。
 */
int16_t stepToRaw(State& state, const Params& params, int rpm_ref, int measured_rpm, double dt,
                  double* i_cmd_amp_out = nullptr);

}  // namespace motor_control_lib::ddt_current_pi

#endif  // MOTOR_CONTROL_LIB__DDT_CURRENT_PI_HPP_
