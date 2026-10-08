// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_LIB__WHEEL_VELOCITY_DAMPING_HPP_
#define MOTOR_CONTROL_LIB__WHEEL_VELOCITY_DAMPING_HPP_

#include <algorithm>
#include <cmath>

namespace motor_control_lib::wheel_velocity_damping {

/**
 * @brief velocity モードの速度誤差の位相進み（ダンピング付加）。純粋関数。
 *
 * 設計と根拠は design/drive_floor_oscillation.md。
 *
 * 効くのは線形の領域（加減速の後の揺れ戻し・中〜高速の揺れ）。低速の張り付き（車輪が毎周期
 * ほぼ止まる）には効かない（2026-10 の実機試験）。張り付きの元はファームの速度ループの内側に
 * あり、目標 RPM だけでは届かない。
 *
 * ホストが変えられるのはファーム速度ループへの目標 RPM だけで、ファームのゲインは変えられない。
 * ファームが見る誤差 (u - ω) に (1 + D·s) を掛けると、ファームの PI（Kp + Ki/s）から見た
 * 実効ゲインは (Kp + Ki·D) + Kp·D·s + Ki/s になり、積分（定常の摩擦補償）を変えずに
 * 比例ゲイン = ダンピングだけを足せる。
 *
 *   e_k   = ref_k - measured_k            （速度誤差 [RPM]）
 *   ė_k   = (e_k - e_{k-1}) / dt          （差分）
 *   f     = 2 段の一次ローパス（時定数 filter_tau_sec）を ė に掛けた値
 *   補正  = clamp(gain_sec · f, ±max_correction_rpm)   → 指令 = ref + 補正
 *
 * 誤差の微分を使うので、一定の追従遅れ（加速中のランプ）には反応しない。反応するのは
 * 誤差の変化（振動・張り付き→滑り出し）だけ。
 *
 * 量子化（整数 RPM）の差分ノイズと、浮かせた状態（負荷が軽くファームのループが速い）での
 * 高い周波数の発振を避けるため、ローパスは 2 段にしている。
 *
 * gain_sec = 0 で無効（補正は常に 0）。リセットは呼び出し側がモード遷移・停止・
 * フィードバック途絶・設定変更で行うこと（AGENTS.md 制御状態リセットの規律）。
 */

struct Params {
  double gain_sec{0.0};             // D [s]。0 で無効
  double filter_tau_sec{0.03};      // 差分のローパス時定数 [s]（2 段）
  double max_correction_rpm{10.0};  // 補正量の上限 [RPM]
};

struct State {
  bool initialized{false};
  double prev_error{0.0};  // 前回の誤差 [RPM]
  double stage1{0.0};      // ローパス 1 段目 [RPM/s]
  double stage2{0.0};      // ローパス 2 段目 [RPM/s]
};

/// パラメータをサニタイズする（非有限・負値は無効側 / 既定へ丸める）。
inline Params sanitize(const Params& in) {
  Params p = in;
  if (!std::isfinite(p.gain_sec) || p.gain_sec < 0.0) p.gain_sec = 0.0;
  if (!std::isfinite(p.filter_tau_sec) || p.filter_tau_sec < 0.0) p.filter_tau_sec = 0.0;
  if (!std::isfinite(p.max_correction_rpm) || p.max_correction_rpm < 0.0) {
    p.max_correction_rpm = 0.0;
  }
  return p;
}

/// 補正を出し得る設定か（gain と上限がどちらも正）。
inline bool enabled(const Params& params) {
  return params.gain_sec > 0.0 && params.max_correction_rpm > 0.0;
}

/// 状態を捨てる。次の step() は差分を作れないので補正 0 から始まる。
inline void reset(State& state) { state = State{}; }

/**
 * @brief 1 tick 進め、目標 RPM に足す補正量 [RPM] を返す。
 *
 * @param state    状態（更新される）
 * @param params   パラメータ（sanitize 済みを渡すこと）
 * @param ref_rpm  この tick の目標 RPM
 * @param measured_rpm  実測 RPM（目標と同じ符号規約）
 * @param dt_sec   制御周期 [s]（固定値を想定）
 * @return 補正量 [RPM]（±max_correction_rpm）。無効・初回・dt 不正なら 0
 */
inline double step(State& state, const Params& params, double ref_rpm, double measured_rpm,
                   double dt_sec) {
  const double error = ref_rpm - measured_rpm;
  if (!enabled(params) || !(dt_sec > 0.0) || !std::isfinite(error)) {
    reset(state);
    return 0.0;
  }
  if (!state.initialized) {
    state.initialized = true;
    state.prev_error = error;
    return 0.0;
  }
  const double derivative = (error - state.prev_error) / dt_sec;
  state.prev_error = error;
  const double alpha = dt_sec / (params.filter_tau_sec + dt_sec);
  state.stage1 += alpha * (derivative - state.stage1);
  state.stage2 += alpha * (state.stage1 - state.stage2);
  return std::clamp(params.gain_sec * state.stage2, -params.max_correction_rpm,
                    params.max_correction_rpm);
}

}  // namespace motor_control_lib::wheel_velocity_damping

#endif  // MOTOR_CONTROL_LIB__WHEEL_VELOCITY_DAMPING_HPP_
