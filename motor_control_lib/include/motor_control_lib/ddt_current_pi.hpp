// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_LIB__DDT_CURRENT_PI_HPP_
#define MOTOR_CONTROL_LIB__DDT_CURRENT_PI_HPP_

#include <array>
#include <cstdint>

namespace motor_control_lib::ddt_current_pi {

/**
 * @brief DDT モータ Current モードのソフトウェア PI 制御と暴走ガードを提供する純粋関数群。
 *
 * ここに含まれる関数はシリアル I/O・rclcpp・時刻取得に一切依存せず、
 * 目標 RPM と実測 RPM から電流指令 raw 値を計算するだけである（単体テスト可能）。
 * dt サニタイズ・ゼロ近傍デッドバンド判定・暴走ガードも同様に純粋関数として切り出す。
 *
 * 速度の符号: ここでの「実測」は PI が見る向き（invert_measured を適用した後）で、指令 RPM・
 * 電流指令と同じ向きを正とする。
 */

/// -8 A..8 A が -32767..32767 に対応（M0602C 仕様書。モータ電流の範囲ではない）。
constexpr double kAmpPerRaw = 8.0 / 32767.0;

/// max_current_amp に設定できる上限 [A]。M0602C 仕様書の保護（相電流 4.6 A が 5 s 続くと停止、
/// 保護が 15 s 以内に計 5 回で電源を入れ直すまで無効）より下に置く。定格は 1.2 A。
constexpr double kMaxCurrentLimitAmp = 4.0;

/// 摩擦補償の静止摩擦分を、|目標| がこの RPM に達するまで目標に比例させて立ち上げる
/// （目標 0 を挟んだ符号反転で ±static が段差にならないように）。
constexpr double kFrictionFfFullRpm = 10.0;

/**
 * @brief Current モード PI パラメータ（全モータ共通）。
 */
struct Params {
  double kp;                  // [A/rpm] 比例ゲイン
  double ki;                  // [A/(rpm·s)] 積分ゲイン
  double max_current_amp;     // [A] 電流指令の絶対値上限（安全クランプ）
  double integral_limit_amp;  // [A] 積分項の絶対値上限（アンチワインドアップ）
  bool invert_measured;       // measured RPM 符号反転（正帰還押さえ用）
  double ff_static_amp{0.0};  // [A] 摩擦補償: 静止（クーロン）摩擦分。目標の向きに足す
  double ff_viscous_amp_per_rpm{0.0};  // [A/rpm] 摩擦補償: 粘性摩擦分（目標 RPM に比例）
};

/**
 * @brief PI 積分器の状態（モータ毎に保持）。
 *
 * integral_amp は積分項そのもの（Ki を掛けた後の電流 [A]）。Ki を実行時に変えても
 * 積分項の寄与が飛ばない（バンプレス）。
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
 * @brief 摩擦補償（フィードフォワード）[A]。目標 RPM だけから決まり、実測は使わない
 *  （フィードバックを持たないので、補償そのものが正帰還・発振の原因にはならない）。
 *
 *  ff = ff_static_amp * clamp(rpm_ref / kFrictionFfFullRpm, -1, 1)
 *       + ff_viscous_amp_per_rpm * rpm_ref
 *  目標 0 では 0。
 */
double frictionFeedforwardAmp(int rpm_ref, const Params& params);

/**
 * @brief PI 1 ステップを実行し、電流指令 raw 値を返す純粋関数。
 *
 * 処理順:
 *   measured を必要なら符号反転 → error = ref - measured
 *   → 積分項の候補 = integral + Ki*error*dt を ±integral_limit_amp にクランプ
 *     （Ki<=1e-9 のときは積分項を 0 にリセット）
 *   → u = 摩擦補償 + Kp*error + 積分項の候補 を ±max_current_amp にクランプ
 *   → 出力が上限に張り付き、かつ誤差がさらに張り付く向きのときは積分しない
 *     （条件付き積分。飽和中の積分の溜め込みを防ぐ）
 *   → -8A..8A が -32767..32767 に対応（仕様書）ので A→raw 換算し ±32767 でクランプ。
 *
 * @param state           PI 積分器の状態（更新される）。
 * @param params          PI パラメータ。
 * @param rpm_ref         目標 RPM。
 * @param measured_rpm    実測 RPM（符号反転前、モーターの向き）。角度から求めた速さ（小数）も、
 *                        報告回転数（整数）もそのまま渡せる（int は暗黙に double になる）。
 * @param dt              サニタイズ済み dt [s]。
 * @param i_cmd_amp_out   非 null なら、クランプ後の電流指令 [A] を書き込む（ログ・ガード用）。
 * @param saturated_out   非 null なら、出力が ±max_current_amp でクランプされたかを書き込む。
 * @return 電流指令 raw 値（±32767）。
 */
int16_t stepToRaw(State& state, const Params& params, int rpm_ref, double measured_rpm, double dt,
                  double* i_cmd_amp_out = nullptr, bool* saturated_out = nullptr);

/// 電流 [A] → raw（±32767 にクランプ）。
int16_t ampToRaw(double amp);

/// raw → 電流 [A]。
double rawToAmp(int16_t raw);

// ---- 暴走ガード ------------------------------------------------------------------------
//
// 車輪を浮かせた（接地していない）状態は負荷慣性が床の上の 1/20 程度しかなく、床で使える
// ゲインでは発振し、符号（invert_measured）を誤ると正帰還で回転が上がり続ける。どちらも
// ホストの電流指令が原因なので、次のどれかを満たしたら電流を 0 にしてラッチする（解除は
// 再初期化か current モードのパラメータ変更）。判定はすべて PI が見る向きの実測で行う。
//
//  - kAccelAgainstCurrent: 直前の周期に流した電流が回転を止める向きなのに、回転が速くなり
//    続けた（正味 kAgainstGrowthRpm 以上）。物理的には外力でしか起きず、符号の誤り（正帰還）の
//    典型的な現れ方。
//  - kOverspeed: |実測| が |目標| + overspeed_margin_rpm を超えたまま overspeed_time_sec 続き、
//    その間に減速していない。摩擦補償の過補償・外力・符号の誤りで起きる。
//  - kOscillation: 上限に張り付いた電流指令の向きが kOscillationWindowSec の間に
//    kOscillationSwitches 回入れ替わった（上限から上限への発振）。負荷に対してゲインが高すぎる
//    （浮かせた車輪に床用のゲイン、走行中に持ち上げた等）。

enum class GuardTrip : uint8_t {
  kNone = 0,
  kAccelAgainstCurrent,
  kOverspeed,
  kOscillation,
  // モータの応答のモード値（DATA[1]）が電流ループでない。電流指令の raw 値が速度目標として
  // 解釈されるので、電流を出してはいけない（updateGuard ではなく DdtMotorLib が判定する）。
  kModeMismatch,
};

/// ログ・表示用の短い名前（"none" / "against" / "overspeed" / "oscillation" / "mode"）。
const char* guardTripName(GuardTrip trip);

constexpr double kAgainstMinCurrentAmp = 0.05;  // [A] これ未満の電流は判定に使わない
constexpr int kAgainstMinSpeedRpm = 5;  // [RPM] これ未満の回転は向きが定まらない
constexpr double kAgainstGrowthRpm = 30.0;  // [RPM] 逆向きの電流の下で正味これだけ速くなったら
constexpr double kOverspeedSlowdownTolRpm = 3.0;  // [RPM] 量子化ノイズを減速と見なさない幅
constexpr double kSaturationFraction = 0.95;  // 上限のこの割合以上を「張り付き」とする
constexpr double kOscillationWindowSec = 0.5;  // [s]
constexpr int kOscillationSwitches = 4;  // 張り付きの向きの記録がこの数そろったら発振

struct GuardParams {
  double overspeed_margin_rpm{50.0};  // [RPM] 目標をこれ以上超えたら超過とみなす
  double overspeed_time_sec{0.3};     // [s] 超過がこれだけ続いたら作動
};

struct GuardState {
  bool overspeed_active{false};
  double overspeed_since_sec{0.0};
  double overspeed_start_abs_rpm{0.0};
  double against_growth_rpm{0.0};
  // 上限に張り付いた電流指令の向きの記録（向きが変わったときだけ追加。古い順）。
  std::array<double, kOscillationSwitches> saturation_times{};
  std::array<int8_t, kOscillationSwitches> saturation_signs{};
  int saturation_count{0};
};

/**
 * @brief ガード 1 回分の入力（新しいフィードバックを受け取った周期だけ評価する）。
 */
struct GuardSample {
  double now_sec;            // 単調時計 [s]
  int rpm_ref;               // この周期の目標 RPM
  double measured_prev_rpm;  // 前回の実測（PI の向き）。電流を送る前に PI が使った値
  double measured_new_rpm;  // 今回の応答の実測（PI の向き）
  double applied_amp;  // 2 つの実測の間に流れていた電流（前の周期に送った指令）[A]
  double commanded_amp;    // この周期に送る電流指令 [A]
  double max_current_amp;  // 電流指令の上限 [A]
};

/**
 * @brief ガードを 1 回評価する。作動したら理由を返す（状態のリセットは呼び出し側）。
 */
GuardTrip updateGuard(GuardState& state, const GuardParams& params, const GuardSample& sample);

}  // namespace motor_control_lib::ddt_current_pi

#endif  // MOTOR_CONTROL_LIB__DDT_CURRENT_PI_HPP_
