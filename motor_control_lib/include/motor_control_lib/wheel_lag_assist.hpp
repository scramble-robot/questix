// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_LIB__WHEEL_LAG_ASSIST_HPP_
#define MOTOR_CONTROL_LIB__WHEEL_LAG_ASSIST_HPP_

#include <algorithm>
#include <cmath>

namespace motor_control_lib::wheel_lag_assist {

/**
 * @brief velocity モードの車輪 1 輪で、実測が「本来の応答」より遅れた分だけ速度指令を上乗せし、
 *        行き過ぎた分だけ差し引く補正（純粋関数。実機での試験用、既定は無効）。
 *
 * 背景（実機計測 2026-10-07/08、その場旋回、scripts/identify/current_stats.py）: 床の上の
 * 15〜40 rpm で約 1.75 Hz・p2p 25〜50 rpm の揺れが続く。|I| は 15 rpm でも 1.4 A と大きく、
 * 摩擦（タイヤ・キャスターの擦れ）で車輪が引っかかり、ファーム速度ループが電流を積み増して
 * 滑り出し、行き過ぎて逆トルクで止める、の繰り返し（ハンチング）と見ている。ファームの
 * 積み増しの速さは変えられないため、引っかかって遅れた間はホストが指令を上乗せしてファームの
 * 誤差を大きくし（積み増しを速める）、滑り出して目標を越えた間は差し引く。
 *
 * 補正（tick ごと。dir = 目標の符号、ref ≠ 0 のときだけ呼ぶこと）:
 *   m_k = m_{k-1} + α (ref − m_{k-1})   本来の応答（一次遅れ、α = dt / (model_tau + dt)）
 *   lag = (m_k − 実測) · dir             進行方向に見た遅れ（負なら行き過ぎ）
 *   lag >  deadband: +gain           · (lag − deadband)   上乗せ（上限 max_rpm）
 *   lag < −deadband: −overshoot_gain · (−lag − deadband)  差し引き（上限 max_rpm）
 *   補正 = dir · 上の値 · 負荷ゲート
 * 通常の追従遅れはモデル m で除き、量子化（1 rpm）や路面の細かい乱れは deadband で無視する。
 * 遅れが縮めば上乗せも比例して消える（滑り出した後に残らない）。
 *
 * 注意: ファーム速度ループは積分が主体のため、上乗せはファームの積分を通じて主に「ばね」
 * として効く（揺れの周波数が上がる）。摩擦 + PI + 慣性の簡易シミュレーションでは揺れは
 * 減らなかった（同じモデルは共振ダンピングで低速も収まると予測し、実機と合わない = モデルが
 * 不十分）。効くかどうかは実機で確かめること。
 *
 * 負荷ゲートは wheel_rate_damper と同じ考え（|I| を load_tau で平滑化、load_off 以下で 0、
 * load_on 以上で全量）。浮かせた車輪には掛けない。
 *
 * ROS・シリアル・時刻に依存しない。リセットは呼び出し側がモード遷移・停止・フィードバック
 * 途絶・目標 0・目標の符号反転で行うこと（AGENTS.md 制御状態リセットの規律）。
 */

struct Params {
  double gain{0.0};  // 遅れ 1 rpm あたりの上乗せ [rpm/rpm]。0 で上乗せなし
  double overshoot_gain{0.0};  // 行き過ぎ 1 rpm あたりの差し引き [rpm/rpm]。0 で差し引きなし
  double deadband_rpm{3.0};    // [rpm] これ以内の遅れ・行き過ぎは無視
  double model_tau_sec{0.06};  // [s] 本来の応答（一次遅れ）の時定数
  double max_rpm{15.0};  // [rpm] 上乗せ・差し引きそれぞれの上限（安全装置）
  double load_on_amp{0.6};  // [A] 平滑化した |I| がこれ以上で全量。<= 0 でゲート無効
  double load_off_amp{0.3};  // [A] これ以下で 0
  double load_tau_sec{0.3};  // [s] |I| の平滑化の時定数
};

struct State {
  bool initialized{false};
  double model_rpm{0.0};   // m_k
  double load_amp{0.0};    // 平滑化した |I| [A]
  double load_scale{0.0};  // 直近の負荷ゲート 0..1（ログ・テスト用）
};

/// 有効な設定か（上乗せか差し引きのゲインが正）。
inline bool enabled(const Params& p) {
  return (std::isfinite(p.gain) && p.gain > 0.0) ||
         (std::isfinite(p.overshoot_gain) && p.overshoot_gain > 0.0);
}

/// パラメータをサニタイズする（範囲外は安全側 = 弱い補正・無効へ丸める）。
inline Params sanitize(const Params& in) {
  Params p = in;
  if (!std::isfinite(p.gain) || p.gain < 0.0) p.gain = 0.0;
  if (!std::isfinite(p.overshoot_gain) || p.overshoot_gain < 0.0) p.overshoot_gain = 0.0;
  if (!std::isfinite(p.deadband_rpm) || p.deadband_rpm < 0.0) p.deadband_rpm = 3.0;
  if (!std::isfinite(p.model_tau_sec) || p.model_tau_sec < 0.0) p.model_tau_sec = 0.06;
  if (!std::isfinite(p.max_rpm) || p.max_rpm < 0.0) p.max_rpm = 0.0;
  if (!std::isfinite(p.load_on_amp)) p.load_on_amp = 0.6;
  if (!std::isfinite(p.load_off_amp) || p.load_off_amp < 0.0) p.load_off_amp = 0.0;
  if (p.load_on_amp > 0.0 && p.load_off_amp > p.load_on_amp) p.load_off_amp = p.load_on_amp;
  if (!std::isfinite(p.load_tau_sec) || p.load_tau_sec < 0.0) p.load_tau_sec = 0.3;
  return p;
}

/// 平滑化した |I| から掛け具合 0..1 を返す（load_off_amp 以下 0、load_on_amp 以上 1）。
inline double loadScale(const Params& p, double load_amp) {
  if (!(p.load_on_amp > 0.0)) {
    return 1.0;
  }
  if (p.load_on_amp <= p.load_off_amp) {
    return load_amp >= p.load_on_amp ? 1.0 : 0.0;
  }
  return std::clamp((load_amp - p.load_off_amp) / (p.load_on_amp - p.load_off_amp), 0.0, 1.0);
}

inline void reset(State& state) { state = State{}; }

/**
 * @brief 1 tick 進め、速度指令に足す補正 [rpm] を返す。
 *
 * 初回（reset 直後）は本来の応答を今回の実測で初期化して 0 を返す（指令が跳ねない）。
 *
 * @param state       補正器の状態（更新される）
 * @param params      パラメータ（sanitize 済みを渡すこと）
 * @param ref_rpm     今 tick の目標 RPM（補正前。0 でないこと）
 * @param measured    最新の実測 RPM（指令と同じ符号規約）
 * @param current_amp 最新の実測トルク電流 [A]（符号は問わない。負荷ゲートに使う）
 * @param dt_sec      制御周期 [s]（> 0）
 */
inline double step(State& state, const Params& params, double ref_rpm, double measured,
                   double current_amp, double dt_sec) {
  const double abs_current = std::isfinite(current_amp) ? std::abs(current_amp) : 0.0;
  if (!state.initialized || !(dt_sec > 0.0)) {
    state.initialized = true;
    state.model_rpm = measured;
    state.load_amp = abs_current;
    state.load_scale = loadScale(params, abs_current);
    return 0.0;
  }
  state.load_amp += dt_sec / (params.load_tau_sec + dt_sec) * (abs_current - state.load_amp);
  state.load_scale = loadScale(params, state.load_amp);
  state.model_rpm += dt_sec / (params.model_tau_sec + dt_sec) * (ref_rpm - state.model_rpm);
  if (!enabled(params) || ref_rpm == 0.0) {
    return 0.0;
  }
  const double dir = ref_rpm > 0.0 ? 1.0 : -1.0;
  const double lag = (state.model_rpm - measured) * dir;
  double assist = 0.0;
  if (lag > params.deadband_rpm) {
    assist = std::min(params.gain * (lag - params.deadband_rpm), params.max_rpm);
  } else if (lag < -params.deadband_rpm) {
    assist = -std::min(params.overshoot_gain * (-lag - params.deadband_rpm), params.max_rpm);
  }
  return dir * assist * state.load_scale;
}

}  // namespace motor_control_lib::wheel_lag_assist

#endif  // MOTOR_CONTROL_LIB__WHEEL_LAG_ASSIST_HPP_
