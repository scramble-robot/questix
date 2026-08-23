// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_LIB__DRIVE_MODE_FSM_HPP_
#define MOTOR_CONTROL_LIB__DRIVE_MODE_FSM_HPP_

#include <algorithm>

#include "motor_control_lib/drive_stop_gate.hpp"

namespace motor_control_lib::drive_mode_fsm {

/**
 * @brief velocity モードの走行状態（design/model_based_drive_control.md Phase B）。
 *
 * M0602C のファーム速度ループは、停止（ブレーキ）・低 RPM・走行で振る舞いが別物になる。
 * 1 つの線形モデル/制御則で押し通さず、状態を明示して状態ごとに制御則を割り当てる。
 *
 *   kStop  : 停止指令（目標 0 + ブレーキ）。drive_stop_gate の「停止モード」と同じ。
 *   kCreep : 不感帯の外だが線形近似が当てはまらない低 RPM 域。既存の参照整形のみ（FB なし）。
 *   kRun   : 一次遅れ + むだ時間で近似できる走行域。モデルベース制御（LQR+FF）を許可する。
 *
 * 既定（run_enter_rpm = run_exit_rpm = 0）では kCreep が空集合になり、停止/走行の 2 状態
 * （= 従来の drive_stop_gate の挙動）と完全に一致する。
 */
enum class DriveMode { kStop, kCreep, kRun };

/**
 * @brief 状態機械の閾値。すべて車輪 RPM の絶対値（左右の大きい方）に対する値。
 *
 *  - min_command_rpm: 停止/走行の不感帯（drive_stop_gate と共有）。
 *  - run_enter_rpm  : kCreep/kStop から kRun に入る閾値（>= これで RUN）。
 *  - run_exit_rpm   : kRun から kCreep に落ちる閾値（< これで CREEP）。
 *    入り/抜けで別閾値にしてヒステリシスを作る（run_enter_rpm >= run_exit_rpm を推奨。
 *    逆に設定された場合は run_exit_rpm = run_enter_rpm に丸めて使う）。
 *  - 両方 0 以下のとき RUN 判定は無効 = 停止でなければ常に kRun（従来挙動）。
 */
struct Config {
  int min_command_rpm{0};
  int run_enter_rpm{0};
  int run_exit_rpm{0};
};

/// RUN 判定が有効か（kCreep が存在し得るか）。
inline bool runThresholdEnabled(const Config& config) {
  return config.run_enter_rpm > 0 || config.run_exit_rpm > 0;
}

/**
 * @brief 1 ステップの状態更新（純粋関数）。
 *
 * @param prev        現在の状態
 * @param max_abs_rpm 左右輪の指令 RPM 絶対値の大きい方
 * @param config      閾値
 * @return 更新後の状態
 */
inline DriveMode update(DriveMode prev, int max_abs_rpm, const Config& config) {
  // 停止/走行は既存の drive_stop_gate（ヒステリシス付き）に完全に委譲する。
  const bool was_stop = (prev == DriveMode::kStop);
  const bool stop = drive_stop_gate::updateStopMode(was_stop, max_abs_rpm, config.min_command_rpm);
  if (stop) {
    return DriveMode::kStop;
  }
  if (!runThresholdEnabled(config)) {
    return DriveMode::kRun;
  }
  // 片方だけ指定されたときはもう片方にも同じ値を使う。exit > enter は enter に丸める。
  const int enter = config.run_enter_rpm > 0 ? config.run_enter_rpm : config.run_exit_rpm;
  const int exit = std::min(config.run_exit_rpm > 0 ? config.run_exit_rpm : enter, enter);
  if (prev == DriveMode::kRun) {
    return max_abs_rpm >= exit ? DriveMode::kRun : DriveMode::kCreep;
  }
  // kStop / kCreep から: 入り閾値以上で RUN、それ未満は CREEP
  return max_abs_rpm >= enter ? DriveMode::kRun : DriveMode::kCreep;
}

inline const char* toString(DriveMode mode) {
  switch (mode) {
    case DriveMode::kStop:
      return "stop";
    case DriveMode::kCreep:
      return "creep";
    case DriveMode::kRun:
      return "run";
  }
  return "unknown";
}

}  // namespace motor_control_lib::drive_mode_fsm

#endif  // MOTOR_CONTROL_LIB__DRIVE_MODE_FSM_HPP_
