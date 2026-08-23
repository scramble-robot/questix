// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_LIB__WHEEL_OBSERVER_HPP_
#define MOTOR_CONTROL_LIB__WHEEL_OBSERVER_HPP_

#include <algorithm>
#include <array>
#include <cmath>

namespace motor_control_lib::wheel_observer {

/**
 * @brief 車輪 1 輪の角速度と外乱の推定器（design/model_based_drive_control.md Phase C）。
 *
 * モデル（1 次 + むだ時間）:
 *   x_{k+1} = a x_k + b u_{k-d} + d_k
 * velocity モードでは x = 実測 RPM、u = 指令 RPM、a = exp(-dt/τ)、b = 1 - a（定常ゲイン 1）。
 * current モードでは u = 電流 [A]、b = 同定値。どちらも同じ型で使える。
 *
 * 実測 RPM は整数量子化 + ノイズが大きいため、モデル予測と実測を混ぜた推定値 x̂ と、
 * モデル誤差・負荷をまとめた外乱 d̂ を返す（定常カルマン / 外乱オブザーバの形）。
 *
 *   e        = y_k - x̂_k^-                 （イノベーション）
 *   x̂_k      = x̂_k^- + l_x e
 *   d̂_k      = d̂_{k-1} + l_d e
 *   x̂_{k+1}^- = a x̂_k + b u_{k-d} + d̂_k      （次ステップの事前推定）
 *
 * ROS・シリアル・時刻に依存しない純粋関数群。リセットは必ず呼び出し側がモード遷移・
 * 停止・フィードバック途絶で行うこと（AGENTS.md 制御状態リセットの規律）。
 */

/// 対応できる最大むだ時間 [tick]
inline constexpr int kMaxDelayTicks = 4;

struct Params {
  double a{0.0};  // 状態遷移係数 0 <= a < 1
  double b{1.0};  // 入力係数
  double l_x{0.5};  // 状態のイノベーションゲイン 0..1（1 で実測をそのまま信じる）
  double l_d{0.0};     // 外乱のイノベーションゲイン >= 0（0 で外乱推定なし）
  int delay_ticks{0};  // 入力のむだ時間 [tick] 0..kMaxDelayTicks
};

struct State {
  bool initialized{false};
  double x_hat{0.0};    // 事後推定（補正後）
  double x_prior{0.0};  // 次ステップの事前推定
  double d_hat{0.0};    // 外乱推定
  double last_innovation{0.0};
  // 直近の入力履歴。u_hist[0] が最新（u_k）、u_hist[d] が u_{k-d}
  std::array<double, kMaxDelayTicks + 1> u_hist{};
};

/// パラメータをサニタイズする（範囲外は安全側に丸める）。
inline Params sanitize(const Params& in) {
  Params p = in;
  if (!std::isfinite(p.a)) p.a = 0.0;
  p.a = std::clamp(p.a, 0.0, 0.999);
  if (!std::isfinite(p.b) || p.b == 0.0) p.b = 1.0 - p.a;
  if (!std::isfinite(p.l_x)) p.l_x = 1.0;
  p.l_x = std::clamp(p.l_x, 0.0, 1.0);
  if (!std::isfinite(p.l_d) || p.l_d < 0.0) p.l_d = 0.0;
  p.delay_ticks = std::clamp(p.delay_ticks, 0, kMaxDelayTicks);
  return p;
}

/// 実測で初期化する（フィードバック復帰・モード遷移時）。外乱推定と入力履歴は 0 に戻す。
inline void reset(State& state, double measured) {
  state = State{};
  state.initialized = true;
  state.x_hat = measured;
  state.x_prior = measured;
}

/**
 * @brief 1 tick 進める。
 *
 * @param state     推定器の状態（更新される）
 * @param params    パラメータ（sanitize 済みを渡すこと）
 * @param measured  今 tick の実測値 y_k
 * @param input     今 tick に適用する入力 u_k（次の事前推定に使う）
 * @return 補正後の推定値 x̂_k
 */
inline double step(State& state, const Params& params, double measured, double input) {
  if (!state.initialized) {
    reset(state, measured);
  }
  const double e = measured - state.x_prior;
  state.last_innovation = e;
  state.x_hat = state.x_prior + params.l_x * e;
  state.d_hat += params.l_d * e;

  // 入力履歴を 1 つずらして最新を先頭に
  for (int i = kMaxDelayTicks; i > 0; --i) {
    state.u_hist[i] = state.u_hist[i - 1];
  }
  state.u_hist[0] = input;
  const double u_delayed = state.u_hist[params.delay_ticks];

  state.x_prior = params.a * state.x_hat + params.b * u_delayed + state.d_hat;
  return state.x_hat;
}

}  // namespace motor_control_lib::wheel_observer

#endif  // MOTOR_CONTROL_LIB__WHEEL_OBSERVER_HPP_
