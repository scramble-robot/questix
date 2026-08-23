// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__CONTROL_CORE_HPP_
#define MOTOR_CONTROL_APP__CONTROL_CORE_HPP_

#include <algorithm>
#include <cmath>
#include <optional>

#include "motor_control_app/drive_slew.hpp"
#include "motor_control_lib/differential_kinematics.hpp"
#include "motor_control_lib/drive_mode_fsm.hpp"
#include "motor_control_lib/wheel_observer.hpp"
#include "motor_control_lib/wheel_velocity_lqr.hpp"

namespace motor_control_app::control_core {

using DriveMode = motor_control_lib::drive_mode_fsm::DriveMode;

/**
 * @brief velocity モード RUN 域の外側 LQR+FF（design/model_based_drive_control.md Phase E）の設定。
 *
 * 制御対象はファーム速度ループを一次遅れ τ + むだ時間 d [tick] で近似したもの。
 * 既定（enabled=false）では従来どおり「参照整形後の目標 RPM をそのまま送る」。
 * enabled=true でも q=0, lead_gain=0, disturbance_gain=0 なら出力は従来と一致する。
 * 同定（Phase A）で一次遅れが当てはまった RUN 域でのみ使うこと。
 */
struct VelocityRunLqrConfig {
  bool enabled{false};
  double model_tau_sec{0.1};  // 一次遅れ時定数 [s]（同定値）
  int model_delay_ticks{1};   // むだ時間 [tick]（同定値。RS-485 1 問 1 答で最低 1）
  double q{0.0};              // 追従誤差の重み（0 で FB なし）
  double r{1.0};              // 入力の重み
  double lead_gain{0.0};      // 参照変化の先回り 0..1
  double disturbance_gain{0.0};  // 外乱推定による定常偏差補償 0..1
  double observer_l_x{0.3};      // オブザーバ: 状態イノベーションゲイン 0..1
  double observer_l_d{0.0};  // オブザーバ: 外乱イノベーションゲイン（0 で外乱推定なし）
  double max_correction_rpm{20.0};  // 補正量の上限 [RPM]（安全装置）
  bool invert_measured{false};  // 実測 RPM の符号を反転して使う（正帰還になる配線のときのみ）
};

/**
 * @brief ホスト側の走行制御に必要なパラメータ一式。
 *
 * 既定値は持たない（すべて呼び出し側が設定する）。drive_component は ROS パラメータから
 * 構築するため、既定値をここに置くと「4 種類目のデフォルト」になってしまう
 * （宣言デフォルト / launcher の YAML / クラス内初期化子に続く重複）。
 * VelocityRunLqrConfig のメンバ初期化子は「機能無効」を表す値であり、チューニング値の
 * 既定ではない。
 */
struct Config {
  // スルーレート制限（加速度クランプ）
  double max_linear_accel{0.0};   // [m/s^2] 0 以下で制限無効
  double max_angular_accel{0.0};  // [rad/s^2] 0 以下で制限無効
  // デマンド適応加速度の下限と基準残差。0 以下で適応無効（max 一定クランプ）
  double min_linear_accel{0.0};          // [m/s^2]
  double min_angular_accel{0.0};         // [rad/s^2]
  double accel_demand_ref_linear{0.0};   // [m/s]
  double accel_demand_ref_angular{0.0};  // [rad/s]
  // 目標接近時のレート絞り幅（実効ジャーク制限）。0 で無効
  double slew_taper_band_linear{0.0};   // [m/s]
  double slew_taper_band_angular{0.0};  // [rad/s]

  // 車体諸元
  double wheel_radius{0.0};      // [m]
  double wheel_separation{0.0};  // [m]

  // 指令を許す最低車輪 RPM（低速不感帯）。0 で不感帯なし
  int min_command_rpm{0};

  // velocity モードの走行状態機械（Phase B）。RUN 閾値が 0 なら CREEP は空集合 = 従来挙動
  int run_enter_rpm{0};  // [RPM] kCreep/kStop -> kRun に入る閾値
  int run_exit_rpm{0};   // [RPM] kRun -> kCreep に落ちる閾値

  // velocity モード RUN 域の外側 LQR+FF（Phase E）
  VelocityRunLqrConfig velocity_run;
};

/**
 * @brief 車輪フィードバック（実測 RPM）。モータ個別フレーム（指令 RPM と同じ符号規約）。
 *
 * valid=false なら FB は使わず FF のみ（従来挙動）になり、オブザーバはリセットされる。
 */
struct WheelFeedback {
  bool valid{false};
  int left_rpm{0};
  int right_rpm{0};
};

/**
 * @brief 1 制御ステップの出力。
 *
 * stop == true のときは停止指令（目標0 + ブレーキ）を送るべきで、left_rpm / right_rpm は
 * 参照しない（判定に使われた値がそのまま入っている）。
 */
struct Output {
  bool stop{true};                   // 停止指令を送るべきか。mode == kStop と同値
  DriveMode mode{DriveMode::kStop};  // 走行状態（Phase B）
  int left_rpm{0};      // 左車輪の指令 RPM（RUN で LQR 有効なら補正後）
  int right_rpm{0};     // 右車輪の指令 RPM
  int left_ref_rpm{0};  // 補正前の左車輪目標 RPM（参照整形 + 運動学の結果）
  int right_ref_rpm{0};
  double linear{0.0};      // スルーレート適用後の車体前進速度指令 [m/s]
  double angular{0.0};     // スルーレート適用後の車体角速度指令 [rad/s]
  bool lqr_active{false};  // この tick で RUN LQR 補正が実際に適用されたか
};

/**
 * @brief ホスト側走行制御のコア。ROS にもシリアルにも依存しない。
 *
 * 1 ステップの流れ:
 *   目標 twist -> スルーレート制限（デマンド適応 + テーパー）-> 運動学変換（左右車輪 RPM）
 *   -> 最近接整数へ丸め -> 走行状態機械（停止/低速/走行。ヒステリシス付き）
 *   -> [RUN かつ LQR 有効かつ FB あり] オブザーバ + LQR+FF で車輪 RPM を補正
 *
 * 既存の純粋関数（drive_slew / differential_kinematics / drive_mode_fsm / wheel_observer /
 * wheel_velocity_lqr）を合成した層で、ロジックの単一ソースはそれぞれの関数側にある。
 * ここに集約する意図は、ホスト側の制御状態（スルーレートの前回指令 + 走行状態 +
 * オブザーバ/LQR 状態）を 1 つのオブジェクトに閉じ込め、シリアル接続なしで閉ループ
 * シミュレーションテストを書けるようにすること。
 *
 * dt は固定周期の制御 tick（drive_component の control_rate）から渡す定数を想定している。
 * 上流の publish レートに依存しないことがチューニング再現性の前提。
 */
class ControlCore {
public:
  explicit ControlCore(const Config& config) : config_(config) {}

  /**
   * @brief 1 制御ステップを実行する（フィードバックなし = 従来 API。FF のみ）。
   */
  Output step(double target_linear, double target_angular, double dt_sec) {
    return step(target_linear, target_angular, dt_sec, WheelFeedback{});
  }

  /**
   * @brief 1 制御ステップを実行する。
   * @param target_linear 目標前進速度 [m/s]（joy などの生の目標。スルーレート未適用）
   * @param target_angular 目標角速度 [rad/s]
   * @param dt_sec 制御周期 [s]（固定値を想定）
   * @param feedback 実測車輪 RPM（モータフレーム）。valid=false で FF のみ
   */
  Output step(double target_linear, double target_angular, double dt_sec,
              const WheelFeedback& feedback) {
    // 加速度クランプ。上限はデマンド（残差 = |目標 - 前回指令|）に応じて
    // min..max へ適応し、目標接近時はテーパーでさらに絞る。詳細は drive_slew.hpp。
    last_linear_ = drive_slew::clampRateAdaptive(
        target_linear, last_linear_, config_.min_linear_accel, config_.max_linear_accel,
        config_.accel_demand_ref_linear, dt_sec, config_.slew_taper_band_linear);
    last_angular_ = drive_slew::clampRateAdaptive(
        target_angular, last_angular_, config_.min_angular_accel, config_.max_angular_accel,
        config_.accel_demand_ref_angular, dt_sec, config_.slew_taper_band_angular);

    const auto [left_rpm, right_rpm] = motor_control_lib::differential_kinematics::twistToWheelRpm(
        last_linear_, last_angular_, config_.wheel_radius, config_.wheel_separation);

    // ゼロ方向への切り捨ては左右で量子化が非対称になるため最近接整数へ丸める
    Output out;
    out.left_ref_rpm = static_cast<int>(std::lround(left_rpm));
    out.right_ref_rpm = static_cast<int>(std::lround(right_rpm));
    out.left_rpm = out.left_ref_rpm;
    out.right_rpm = out.right_ref_rpm;
    out.linear = last_linear_;
    out.angular = last_angular_;

    // 走行状態の判定は前後と旋回が合成された実際の車輪 RPM で行う（ヒステリシス付き。
    // 詳細は drive_mode_fsm.hpp / drive_stop_gate.hpp）。
    const int max_abs_rpm = std::max(std::abs(out.left_ref_rpm), std::abs(out.right_ref_rpm));
    const DriveMode prev_mode = mode_;
    mode_ = motor_control_lib::drive_mode_fsm::update(mode_, max_abs_rpm, fsmConfig());
    if (mode_ != prev_mode) {
      // 状態遷移では線形制御の内部状態を捨てる（別の系に移るため）。
      resetWheelControllers();
    }
    out.mode = mode_;
    out.stop = (mode_ == DriveMode::kStop);

    // RUN 域の外側 LQR+FF。FB が無効なら FF のみ（従来挙動）に戻し、状態もリセットする。
    if (mode_ == DriveMode::kRun && config_.velocity_run.enabled) {
      if (feedback.valid) {
        ensureLqrGains(dt_sec);
        const double sign = config_.velocity_run.invert_measured ? -1.0 : 1.0;
        out.left_rpm = runWheel(left_, out.left_ref_rpm, sign * feedback.left_rpm);
        out.right_rpm = runWheel(right_, out.right_ref_rpm, sign * feedback.right_rpm);
        out.lqr_active = lqr_gains_.has_value();
      } else {
        resetWheelControllers();
      }
    }
    return out;
  }

  /**
   * @brief 制御状態をリセットする（武装解除・停止・モード遷移時に呼ぶ）。
   *
   * スルーレートの前回指令を 0 に戻すため、次の駆動は 0 からのランプになる。
   * 停止モードに入るので、次のステップは不感帯を抜けるまで停止指令のままになる。
   * オブザーバ / LQR の内部状態も捨てる。
   */
  void reset() {
    last_linear_ = 0.0;
    last_angular_ = 0.0;
    mode_ = DriveMode::kStop;
    resetWheelControllers();
  }

  /**
   * @brief 設定を差し替える（制御状態は保持する）。
   *
   * 実機でのチューニングを再起動なしに行うため、ROS パラメータ変更から呼ばれる。
   * スルーレートの前回指令と走行状態は維持するので、走行中に変更しても指令が
   * 飛ばない（次のステップから新しい設定で継続する）。LQR ゲインは次の tick で再計算する。
   */
  void setConfig(const Config& config) {
    config_ = config;
    lqr_gains_.reset();
    lqr_gains_dt_ = 0.0;
  }

  const Config& config() const { return config_; }

  // 現在のスルーレート状態（ログ・テスト用）
  double lastLinear() const { return last_linear_; }
  double lastAngular() const { return last_angular_; }
  bool stopMode() const { return mode_ == DriveMode::kStop; }
  DriveMode mode() const { return mode_; }

  /// 直近に計算した LQR ゲイン（ログ・テスト用）。未計算/収束失敗なら nullopt
  std::optional<motor_control_lib::wheel_velocity_lqr::Gains> lqrGains() const {
    return lqr_gains_;
  }
  /// オブザーバの推定値（ログ・テスト用）。未初期化なら nullopt
  std::optional<double> leftOmegaHat() const {
    return left_.observer.initialized ? std::optional<double>(left_.observer.x_hat) : std::nullopt;
  }
  std::optional<double> rightOmegaHat() const {
    return right_.observer.initialized ? std::optional<double>(right_.observer.x_hat)
                                       : std::nullopt;
  }
  double leftDisturbanceHat() const { return left_.observer.d_hat; }
  double rightDisturbanceHat() const { return right_.observer.d_hat; }

private:
  struct WheelState {
    motor_control_lib::wheel_observer::State observer;
    motor_control_lib::wheel_velocity_lqr::State lqr;
  };

  motor_control_lib::drive_mode_fsm::Config fsmConfig() const {
    motor_control_lib::drive_mode_fsm::Config c;
    c.min_command_rpm = config_.min_command_rpm;
    c.run_enter_rpm = config_.run_enter_rpm;
    c.run_exit_rpm = config_.run_exit_rpm;
    return c;
  }

  // dt から a = exp(-dt/τ) を作り、LQR / オブザーバのパラメータとゲインを用意する。
  // dt は固定のはずだが、変わった場合は再計算する。
  void ensureLqrGains(double dt_sec) {
    if (lqr_gains_.has_value() && lqr_gains_dt_ == dt_sec) {
      return;
    }
    const auto& vr = config_.velocity_run;
    const double tau =
        (std::isfinite(vr.model_tau_sec) && vr.model_tau_sec > 0.0) ? vr.model_tau_sec : 1e-6;
    const double a = (dt_sec > 0.0) ? std::exp(-dt_sec / tau) : 0.0;

    motor_control_lib::wheel_velocity_lqr::Params lp;
    lp.a = a;
    lp.b = 0.0;  // 1 - a
    lp.q = vr.q;
    lp.r = vr.r;
    lp.lead_gain = vr.lead_gain;
    lp.disturbance_gain = vr.disturbance_gain;
    lp.max_correction_rpm = vr.max_correction_rpm;
    lqr_params_ = motor_control_lib::wheel_velocity_lqr::sanitize(lp);

    motor_control_lib::wheel_observer::Params op;
    op.a = lqr_params_.a;
    op.b = lqr_params_.b;
    op.l_x = vr.observer_l_x;
    op.l_d = vr.observer_l_d;
    op.delay_ticks = vr.model_delay_ticks;
    observer_params_ = motor_control_lib::wheel_observer::sanitize(op);

    lqr_gains_ = motor_control_lib::wheel_velocity_lqr::computeGains(lqr_params_);
    lqr_gains_dt_ = dt_sec;
  }

  // 1 輪ぶんのオブザーバ + LQR+FF。ゲインが無い（収束失敗）なら FF のみ = 参照そのまま。
  int runWheel(WheelState& w, int ref_rpm, double measured_rpm) {
    if (!lqr_gains_.has_value()) {
      return ref_rpm;
    }
    auto& os = w.observer;
    if (!os.initialized) {
      motor_control_lib::wheel_observer::reset(os, measured_rpm);
    }
    // オブザーバの step() は「補正 -> 予測」の順で、予測にはこれから送る指令が要る。
    // 指令は補正後の推定値に依存するため、補正後の値（事後推定）を先に計算して LQR に渡し、
    // 丸めた実際の指令で step() を進める（step() 内の補正は同じ式なので二重補正にならない）。
    const double innovation = measured_rpm - os.x_prior;
    const double x_hat = os.x_prior + observer_params_.l_x * innovation;
    const double d_hat = os.d_hat + observer_params_.l_d * innovation;

    const double u = motor_control_lib::wheel_velocity_lqr::step(
        w.lqr, lqr_params_, *lqr_gains_, static_cast<double>(ref_rpm), x_hat, d_hat);
    const int cmd = static_cast<int>(std::lround(u));

    motor_control_lib::wheel_observer::step(os, observer_params_, measured_rpm,
                                            static_cast<double>(cmd));
    return cmd;
  }

  void resetWheelControllers() {
    left_ = WheelState{};
    right_ = WheelState{};
  }

  Config config_;

  // スルーレート制限の状態（前回ステップで出した車体指令）
  double last_linear_{0.0};
  double last_angular_{0.0};

  // 走行状態機械。初期状態は停止。
  DriveMode mode_{DriveMode::kStop};

  // RUN 域 LQR+FF の状態とキャッシュ
  WheelState left_;
  WheelState right_;
  motor_control_lib::wheel_velocity_lqr::Params lqr_params_{};
  motor_control_lib::wheel_observer::Params observer_params_{};
  std::optional<motor_control_lib::wheel_velocity_lqr::Gains> lqr_gains_;
  double lqr_gains_dt_{0.0};
};

}  // namespace motor_control_app::control_core

#endif  // MOTOR_CONTROL_APP__CONTROL_CORE_HPP_
