// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_LIB__WHEEL_VELOCITY_LQR_HPP_
#define MOTOR_CONTROL_LIB__WHEEL_VELOCITY_LQR_HPP_

#include <algorithm>
#include <cmath>
#include <optional>

namespace motor_control_lib::wheel_velocity_lqr {

/**
 * @brief velocity モード RUN 域の外側 LQR + フィードフォワード（1 輪ぶん）。
 *        design/model_based_drive_control.md Phase E。
 *
 * 制御対象はファーム速度ループ（ブラックボックス）を一次遅れ + むだ時間で近似したもの:
 *   x_{k+1} = a x_k + b u_k + d,   x = 実測 RPM, u = 指令 RPM, a = exp(-dt/τ), b = 1 - a
 *
 * 制御則:
 *   u = u_ff - K (x̂ - x_ref)
 *   u_ff = x_ref + lead_gain * (x_ref_k - x_ref_{k-1}) / b - disturbance_gain * d̂ / b
 *
 *  - K は無限ホライズン離散 LQR（スカラー DARE）。q/r の比で FB の強さを決める。
 *  - lead 項: 遅れ τ を知った上で参照の変化分だけ先回りする（deadbeat FF の控えめ版）。
 *  - disturbance 項: オブザーバの外乱推定で定常偏差を補償する（積分器の代わり。
 *    ファーム側に積分器があるため二重積分を避ける）。
 *  - 補正量（u - x_ref）は ±max_correction_rpm にクランプする。内側ループ（ファーム）との
 *    干渉・符号誤りによる正帰還の被害を有界にするための安全装置。
 *
 * 既定（enabled=false または q=0, lead=0, disturbance=0）では u = x_ref となり、
 * 従来の「目標 RPM をそのまま送る」挙動と一致する。
 */

struct Params {
  double a{0.0};                   // モデル係数 0 <= a < 1
  double b{0.0};                   // 入力係数。0 以下なら 1 - a を使う
  double q{0.0};                   // 追従誤差の重み >= 0（0 で FB なし）
  double r{1.0};                   // 入力の重み > 0
  double lead_gain{0.0};           // 0..1
  double disturbance_gain{0.0};    // 0..1
  double max_correction_rpm{0.0};  // 補正量の上限 [RPM]（<= 0 で補正なし = FF のみ）
};

struct Gains {
  double k{0.0};  // 状態 FB ゲイン [RPM/RPM]
  double p{0.0};  // リカッチ解（診断用）
};

struct State {
  bool has_prev_ref{false};
  double prev_ref{0.0};
};

/// パラメータをサニタイズする。
inline Params sanitize(const Params& in) {
  Params p = in;
  if (!std::isfinite(p.a)) p.a = 0.0;
  p.a = std::clamp(p.a, 0.0, 0.999);
  if (!std::isfinite(p.b) || p.b <= 0.0) p.b = 1.0 - p.a;
  if (!std::isfinite(p.q) || p.q < 0.0) p.q = 0.0;
  if (!std::isfinite(p.r) || p.r <= 0.0) p.r = 1.0;
  if (!std::isfinite(p.lead_gain)) p.lead_gain = 0.0;
  p.lead_gain = std::clamp(p.lead_gain, 0.0, 1.0);
  if (!std::isfinite(p.disturbance_gain)) p.disturbance_gain = 0.0;
  p.disturbance_gain = std::clamp(p.disturbance_gain, 0.0, 1.0);
  if (!std::isfinite(p.max_correction_rpm) || p.max_correction_rpm < 0.0) {
    p.max_correction_rpm = 0.0;
  }
  return p;
}

/**
 * @brief スカラー離散リカッチ方程式を反復で解き、LQR ゲインを返す。
 *   P = q + a^2 P - (a b P)^2 / (r + b^2 P),   K = a b P / (r + b^2 P)
 * 収束しなければ std::nullopt（呼び出し側は FF のみにフォールバックする）。
 */
inline std::optional<Gains> computeGains(const Params& in, int max_iter = 10000,
                                         double tol = 1e-12) {
  const Params p = sanitize(in);
  if (p.q <= 0.0) {
    return Gains{0.0, 0.0};
  }
  double P = p.q;
  for (int i = 0; i < max_iter; ++i) {
    const double s = p.r + p.b * p.b * P;
    const double Pn = p.q + p.a * p.a * P - (p.a * p.b * P) * (p.a * p.b * P) / s;
    if (!std::isfinite(Pn)) {
      return std::nullopt;
    }
    if (std::abs(Pn - P) < tol * std::max(1.0, std::abs(P))) {
      P = Pn;
      const double k = p.a * p.b * P / (p.r + p.b * p.b * P);
      return Gains{k, P};
    }
    P = Pn;
  }
  return std::nullopt;
}

/// 状態をリセットする（モード遷移・停止・フィードバック途絶で呼ぶ）。
inline void reset(State& state) { state = State{}; }

/**
 * @brief 1 tick の指令 RPM を計算する。
 *
 * @param state   前回参照の保持（lead 項用）
 * @param params  sanitize 済みパラメータ
 * @param gains   computeGains の結果
 * @param ref     目標 RPM（参照整形後）
 * @param x_hat   推定実測 RPM（wheel_observer）
 * @param d_hat   推定外乱（wheel_observer、RPM 単位）
 * @return 指令 RPM（クランプ済み。さらに上位で max_motor_rpm にクランプされる）
 */
inline double step(State& state, const Params& params, const Gains& gains, double ref, double x_hat,
                   double d_hat) {
  const double dref = state.has_prev_ref ? (ref - state.prev_ref) : 0.0;
  state.prev_ref = ref;
  state.has_prev_ref = true;

  double correction = 0.0;
  correction += params.lead_gain * dref / params.b;
  correction -= params.disturbance_gain * d_hat / params.b;
  correction -= gains.k * (x_hat - ref);
  if (!std::isfinite(correction)) {
    correction = 0.0;
  }
  correction = std::clamp(correction, -params.max_correction_rpm, params.max_correction_rpm);
  return ref + correction;
}

}  // namespace motor_control_lib::wheel_velocity_lqr

#endif  // MOTOR_CONTROL_LIB__WHEEL_VELOCITY_LQR_HPP_
