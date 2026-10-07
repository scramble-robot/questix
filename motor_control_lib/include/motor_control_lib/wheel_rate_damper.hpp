// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_LIB__WHEEL_RATE_DAMPER_HPP_
#define MOTOR_CONTROL_LIB__WHEEL_RATE_DAMPER_HPP_

#include <algorithm>
#include <cmath>

namespace motor_control_lib::wheel_rate_damper {

/**
 * @brief velocity モードの車輪 1 輪に、ホスト側からダンピングを足す補正（純粋関数）。
 *
 * 背景（実機計測 2026-10-07、scripts/identify/ripple_analysis.py）: 車輪を浮かせると
 * 20〜150 rpm のどこでも実測の揺れは量子化の 1 rpm 以内だが、床の上では回転数によらず
 * 約 1.4 Hz（その場旋回）で p2p 17〜49 rpm 揺れ続ける。ファーム速度ループ単体は安定で、
 * 機体の慣性が載ると減衰の弱いモードになる（慣性の不整合）。ファームのゲインは変えられない
 * ため、ホストが追従誤差の変化率に逆らう補正を速度指令に足してダンピングを補う。
 *
 * 補正（tick ごと、e = 実測 − 目標 [rpm]）:
 *   x_k = (e_k + e_{k-1}) / 2        2 サンプル平均（ナイキスト 25 Hz の成分を消す）
 *   f_k = f_{k-1} + α (x_k − f_{k-1})  一次ローパス、α = dt / (filter_tau + dt)
 *   c_k = −gain · (f_k − f_{k-1}) / dt を ±max_correction_rpm に制限
 * 目標が一定なら c は実測の揺れの速さに逆らう力（ダンピング）になり、定常値には影響しない
 * （f が一定になれば c = 0）。ランプ中も追従遅れが一定なら c はほぼ 0。
 *
 * 実機（2026-10-07、その場旋回、scripts/identify/ripple_by_twist.py / current_stats.py）:
 *   床の上では gain 0.08 / 0.12 で ~1.4 Hz の揺れの振幅が 95 rpm で 1/5 前後、60 rpm で
 *   0.5〜0.8 倍。ところが車輪を浮かせる（ファームのループが速い）と補正自体が振動を作る:
 *   gain 0.08 で ~5.3 Hz・p2p 10 rpm、0.12 で p2p 約 80 rpm（異音）。浮かせて補正なしは 1 rpm。
 *
 * 床のときだけ効かせる（負荷ゲート）: 同じ記録で、各輪のモータ電流 |I| の平均は床の上で
 * 0.48〜2.1 A、浮かせると 0.13〜0.25 A（補正で 80 rpm 振動していても 0.5 A 未満。車輪だけの
 * 慣性では電流がほとんど要らない）。|I| を load_tau で平滑化した値が load_off_amp 以下で補正 0、
 * load_on_amp 以上で全量、その間は線形に補正を掛ける。浮かせると 1 s 以内に補正が抜け、床の
 * 上でも揺れていない（電流が小さい）間は弱まり、揺れて電流が増えると強まる。
 * load_on_amp <= 0 でゲート無効（常に全量。従来の挙動）。
 *
 * ROS・シリアル・時刻に依存しない。リセットは呼び出し側がモード遷移・停止・フィードバック
 * 途絶・目標 0 で行うこと（AGENTS.md 制御状態リセットの規律）。
 */

struct Params {
  double gain_sec{0.0};             // [s] 0 以下で無効（補正 0）
  double filter_tau_sec{0.08};      // [s] 微分の前の一次ローパスの時定数
  double max_correction_rpm{30.0};  // [rpm] 補正量の上限（安全装置）
  double load_on_amp{0.6};  // [A] 平滑化した |I| がこれ以上で補正を全量。<= 0 でゲート無効
  double load_off_amp{0.3};  // [A] これ以下で補正 0（load_on_amp より小さいこと）
  double load_tau_sec{0.3};  // [s] |I| の平滑化の時定数
};

struct State {
  bool initialized{false};
  double last_error{0.0};     // 前回の e（2 サンプル平均用）
  double filtered{0.0};       // f_k
  double last_filtered{0.0};  // f_{k-1}
  double load_amp{0.0};       // 平滑化した |I| [A]
  double load_scale{0.0};     // 直近の負荷ゲート 0..1（ログ・テスト用）
};

/// 有効な設定か（gain > 0 かつ有限）。
inline bool enabled(const Params& p) { return std::isfinite(p.gain_sec) && p.gain_sec > 0.0; }

/// パラメータをサニタイズする（範囲外は安全側 = 弱い補正・無効へ丸める）。
inline Params sanitize(const Params& in) {
  Params p = in;
  if (!std::isfinite(p.gain_sec) || p.gain_sec < 0.0) p.gain_sec = 0.0;
  if (!std::isfinite(p.filter_tau_sec) || p.filter_tau_sec < 0.0) p.filter_tau_sec = 0.08;
  if (!std::isfinite(p.max_correction_rpm) || p.max_correction_rpm < 0.0) {
    p.max_correction_rpm = 0.0;
  }
  if (!std::isfinite(p.load_on_amp)) p.load_on_amp = 0.6;
  if (!std::isfinite(p.load_off_amp) || p.load_off_amp < 0.0) p.load_off_amp = 0.0;
  if (p.load_on_amp > 0.0 && p.load_off_amp > p.load_on_amp) p.load_off_amp = p.load_on_amp;
  if (!std::isfinite(p.load_tau_sec) || p.load_tau_sec < 0.0) p.load_tau_sec = 0.3;
  return p;
}

/// 負荷ゲートが有効か（load_on_amp > 0）。
inline bool loadGateEnabled(const Params& p) { return p.load_on_amp > 0.0; }

/// 平滑化した |I| から補正の掛け具合 0..1 を返す（load_off_amp 以下 0、load_on_amp 以上 1）。
inline double loadScale(const Params& p, double load_amp) {
  if (!loadGateEnabled(p)) {
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
 * 初回（reset 直後）は内部状態を今回の誤差と電流で初期化して 0 を返す（指令が跳ねない）。
 *
 * @param state       補正器の状態（更新される）
 * @param params      パラメータ（sanitize 済みを渡すこと）
 * @param ref_rpm     今 tick の目標 RPM（補正前）
 * @param measured    最新の実測 RPM（指令と同じ符号規約）
 * @param current_amp 最新の実測トルク電流 [A]（符号は問わない。負荷ゲートに使う）
 * @param dt_sec      制御周期 [s]（> 0）
 */
inline double step(State& state, const Params& params, double ref_rpm, double measured,
                   double current_amp, double dt_sec) {
  const double error = measured - ref_rpm;
  const double abs_current = std::isfinite(current_amp) ? std::abs(current_amp) : 0.0;
  if (!state.initialized || !(dt_sec > 0.0)) {
    state.initialized = true;
    state.last_error = error;
    state.filtered = error;
    state.last_filtered = error;
    state.load_amp = abs_current;
    state.load_scale = loadScale(params, abs_current);
    return 0.0;
  }
  state.load_amp += dt_sec / (params.load_tau_sec + dt_sec) * (abs_current - state.load_amp);
  state.load_scale = loadScale(params, state.load_amp);
  const double averaged = 0.5 * (error + state.last_error);
  state.last_error = error;
  const double alpha = dt_sec / (params.filter_tau_sec + dt_sec);
  state.last_filtered = state.filtered;
  state.filtered += alpha * (averaged - state.filtered);
  if (!enabled(params)) {
    return 0.0;
  }
  const double rate = (state.filtered - state.last_filtered) / dt_sec;
  return std::clamp(-params.gain_sec * state.load_scale * rate, -params.max_correction_rpm,
                    params.max_correction_rpm);
}

}  // namespace motor_control_lib::wheel_rate_damper

#endif  // MOTOR_CONTROL_LIB__WHEEL_RATE_DAMPER_HPP_
