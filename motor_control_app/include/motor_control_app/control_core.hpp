// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__CONTROL_CORE_HPP_
#define MOTOR_CONTROL_APP__CONTROL_CORE_HPP_

#include <algorithm>
#include <cmath>

#include "motor_control_app/drive_slew.hpp"
#include "motor_control_lib/differential_kinematics.hpp"
#include "motor_control_lib/drive_stop_gate.hpp"

namespace motor_control_app::control_core {

/**
 * @brief ホスト側の走行制御に必要なパラメータ一式。
 *
 * 既定値は持たない（すべて呼び出し側が設定する）。drive_component は ROS パラメータから
 * 構築するため、既定値をここに置くと「4 種類目のデフォルト」になってしまう
 * （宣言デフォルト / launcher の YAML / クラス内初期化子に続く重複）。
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
};

/**
 * @brief 1 制御ステップの出力。
 *
 * stop == true のときは停止指令（目標0 + ブレーキ）を送るべきで、left_rpm / right_rpm は
 * 参照しない（判定に使われた値がそのまま入っている）。
 */
struct Output {
  bool stop{true};      // 停止指令を送るべきか（不感帯・中立を含む）
  int left_rpm{0};      // 左車輪の指令 RPM
  int right_rpm{0};     // 右車輪の指令 RPM
  double linear{0.0};   // スルーレート適用後の車体前進速度指令 [m/s]
  double angular{0.0};  // スルーレート適用後の車体角速度指令 [rad/s]
};

/**
 * @brief ホスト側走行制御のコア。ROS にもシリアルにも依存しない。
 *
 * 1 ステップの流れ:
 *   目標 twist -> スルーレート制限（デマンド適応 + テーパー）-> 運動学変換（左右車輪 RPM）
 *   -> 最近接整数へ丸め -> 停止/走行ヒステリシス判定（低速不感帯）
 *
 * 既存の純粋関数（drive_slew / differential_kinematics / drive_stop_gate）を合成した層で、
 * ロジックの単一ソースはそれぞれの関数側にある。ここに集約する意図は、
 * ホスト側の制御状態（スルーレートの前回指令 + 停止モード）を 1 つのオブジェクトに
 * 閉じ込め、シリアル接続なしで閉ループシミュレーションテストを書けるようにすること。
 *
 * dt は固定周期の制御 tick（drive_component の control_rate）から渡す定数を想定している。
 * 上流の publish レートに依存しないことがチューニング再現性の前提。
 */
class ControlCore {
public:
  explicit ControlCore(const Config& config) : config_(config) {}

  /**
   * @brief 1 制御ステップを実行する。
   * @param target_linear 目標前進速度 [m/s]（joy などの生の目標。スルーレート未適用）
   * @param target_angular 目標角速度 [rad/s]
   * @param dt_sec 制御周期 [s]（固定値を想定）
   */
  Output step(double target_linear, double target_angular, double dt_sec) {
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
    out.left_rpm = static_cast<int>(std::lround(left_rpm));
    out.right_rpm = static_cast<int>(std::lround(right_rpm));
    out.linear = last_linear_;
    out.angular = last_angular_;

    // 停止/走行の判定は前後と旋回が合成された実際の車輪 RPM で行う（ヒステリシス付き。
    // 詳細は drive_stop_gate.hpp）。単一閾値だと境界付近で停止/走行がトグルし振動する。
    const int max_abs_rpm = std::max(std::abs(out.left_rpm), std::abs(out.right_rpm));
    stop_mode_ = motor_control_lib::drive_stop_gate::updateStopMode(stop_mode_, max_abs_rpm,
                                                                    config_.min_command_rpm);
    out.stop = stop_mode_;
    return out;
  }

  /**
   * @brief 制御状態をリセットする（武装解除・停止・モード遷移時に呼ぶ）。
   *
   * スルーレートの前回指令を 0 に戻すため、次の駆動は 0 からのランプになる。
   * 停止モードに入るので、次のステップは不感帯を抜けるまで停止指令のままになる。
   */
  void reset() {
    last_linear_ = 0.0;
    last_angular_ = 0.0;
    stop_mode_ = true;
  }

  /**
   * @brief 設定を差し替える（制御状態は保持する）。
   *
   * 実機でのチューニングを再起動なしに行うため、ROS パラメータ変更から呼ばれる。
   * スルーレートの前回指令と停止モードは維持するので、走行中に変更しても指令が
   * 飛ばない（次のステップから新しい加速度上限で継続する）。
   */
  void setConfig(const Config& config) { config_ = config; }

  const Config& config() const { return config_; }

  // 現在のスルーレート状態（ログ・テスト用）
  double lastLinear() const { return last_linear_; }
  double lastAngular() const { return last_angular_; }
  bool stopMode() const { return stop_mode_; }

private:
  Config config_;

  // スルーレート制限の状態（前回ステップで出した車体指令）
  double last_linear_{0.0};
  double last_angular_{0.0};

  // 停止/走行ヒステリシスの状態。初期状態は停止。
  bool stop_mode_{true};
};

}  // namespace motor_control_app::control_core

#endif  // MOTOR_CONTROL_APP__CONTROL_CORE_HPP_
