// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// 床の上の速度変動（約 1.5〜1.75 Hz）と、velocity モードの速度誤差の位相進み
// （ControlCore の velocity_damping）の閉ループシミュレーションテスト。
// 設計と根拠は design/drive_floor_oscillation.md。
//
// プラントは仮説のモデルで、実機の代替ではない:
//  - ファームの速度ループを PI（1 kHz）と仮定し、浮かせた車輪（慣性が小さい）でよく減衰する
//    ゲインにした。M0602C の内部は公開されておらず、構造もゲインも未確認。
//  - 床の上ではロボットの質量が車輪に直接（ギアなし）載るため慣性が約 25 倍になり、同じゲイン
//    では約 1.6 Hz・減衰比 0.14 の弱い減衰になる。
//  - 床の摩擦は静止摩擦がクーロン摩擦の 2.5 倍（Stribeck）。低速で摩擦が速さとともに下がる
//    （負の傾き）ので、弱い減衰と合わせて張り付き→滑り出しの周期振動になる。
// このモデルで、実機の観察（床でのみ約 1.5〜1.75 Hz、10 rpm で片振幅 6〜11 rpm、浮かせると
// 出ない、周波数は回転数でほぼ変わらない）を再現できることを最初のテストで固定する。
//
// 位相進みが固定するのは「線形の領域（加減速の後の揺れ戻し）で減衰を足す」ことと「浮かせた
// 状態を不安定にしない」ことだけ。低速の張り付き（毎周期止まる）には効かない前提で扱う:
// 2026-10 の実機試験では、ダンピング系の補正は高速域に効いたが低速には効かなかった。
// このモデルは 10 rpm の張り付きが位相進みで消える予測を出すが、実機と合わないため、
// その予測はテストにしない（低速のモデルは信用しない）。ゲインの適値は実機で決める。
#include <gtest/gtest.h>

#include <algorithm>
#include <cmath>
#include <vector>

#include "motor_control_app/control_core.hpp"

namespace core = motor_control_app::control_core;

namespace {

constexpr double kControlDt = 0.02;  // control_rate 50 Hz
constexpr double kRpmToRadPerSec = 2.0 * M_PI / 60.0;
constexpr double kWheelRadius = 0.1;  // launcher/config/drive_component.yaml

// 摩擦 + 仮説のファーム PI 速度ループの 1 車輪（モータフレーム）。
class FrictionWheelPlant {
public:
  struct Params {
    double inertia;       // [kg m^2]
    double coulomb_nm;    // クーロン摩擦 [Nm]
    double static_nm;     // 静止摩擦 [Nm]
    double stribeck_rpm;  // Stribeck 速度 [RPM]
    double viscous_nm_per_rad_s;
  };

  static Params floor() { return {0.0125, 0.06, 0.15, 8.0, 0.002}; }
  static Params lifted() { return {0.0005, 0.005, 0.008, 5.0, 1e-4}; }

  explicit FrictionWheelPlant(const Params& p) : p_(p) {}

  // 1 制御周期ぶん進める（内部 1 kHz）。commanded_rpm はファームへの目標。
  void advance(int commanded_rpm, double dt_sec) {
    const int n = static_cast<int>(std::lround(dt_sec / kFineDt));
    const double w_ref = commanded_rpm * kRpmToRadPerSec;
    for (int i = 0; i < n; ++i) {
      const double torque = firmwarePi(w_ref);
      integrate(torque);
    }
  }

  double rpm() const { return w_ / kRpmToRadPerSec; }
  // フィードバックの実測 RPM（整数、ゼロ方向への切り捨て）
  int measuredRpm() const { return static_cast<int>(std::trunc(rpm())); }

private:
  static constexpr double kFineDt = 0.001;
  static constexpr double kFwKp = 0.035;  // [Nm/(rad/s)] 浮かせた車輪で ζ≈0.7, ωn≈8 Hz
  static constexpr double kFwKi = 1.25;   // [Nm/rad]
  static constexpr double kFwTorqueMax = 0.44 * 4.0;

  double firmwarePi(double w_ref) {
    const double e = w_ref - w_;
    integral_ += e * kFineDt;
    const double lim = kFwTorqueMax / kFwKi;
    integral_ = std::clamp(integral_, -lim, lim);
    return std::clamp(kFwKp * e + kFwKi * integral_, -kFwTorqueMax, kFwTorqueMax);
  }

  void integrate(double torque) {
    if (std::abs(w_) < 1e-4) {
      // 張り付き: 静止摩擦を超えるまで動かない
      if (std::abs(torque) <= p_.static_nm) {
        w_ = 0.0;
        return;
      }
      w_ += (torque - std::copysign(p_.static_nm, torque)) / p_.inertia * kFineDt;
      return;
    }
    const double ws = p_.stribeck_rpm * kRpmToRadPerSec;
    const double friction =
        std::copysign(
            p_.coulomb_nm + (p_.static_nm - p_.coulomb_nm) * std::exp(-(w_ / ws) * (w_ / ws)), w_) +
        p_.viscous_nm_per_rad_s * w_;
    const double w_old = w_;
    w_ += (torque - friction) / p_.inertia * kFineDt;
    if (w_old * w_ < 0.0) {
      w_ = 0.0;  // ゼロを横切ったら張り付く
    }
  }

  Params p_;
  double w_{0.0};
  double integral_{0.0};
};

core::Config baseConfig() {
  core::Config config;
  config.max_linear_accel = 3.0;
  config.max_angular_accel = 3.0;
  config.slew_taper_band_linear = 0.2;
  config.slew_taper_band_angular = 0.2;
  config.wheel_radius = kWheelRadius;
  config.wheel_separation = 0.5;
  config.min_command_rpm = 5;
  return config;
}

core::Config dampedConfig(double gain_sec = 0.05) {
  core::Config config = baseConfig();
  config.velocity_damping.gain_sec = gain_sec;
  config.velocity_damping.filter_tau_sec = 0.03;
  config.velocity_damping.max_correction_rpm = 10.0;
  return config;
}

double linearForWheelRpm(double rpm) { return rpm * kRpmToRadPerSec * kWheelRadius; }

struct Trace {
  std::vector<double> left_rpm;  // 真の左輪 RPM（各 tick 後）
  std::vector<int> left_cmd;
  std::vector<int> left_ref;
};

// 直進。ホストが見る実測は 1 tick 前の応答（送った指令への応答フレームに載る速さ）。
// cmd_offset_rpm は「rpm で摩擦を補う」比較用に、指令へ足す一定のずれ（向きは目標に合わせる）。
Trace driveStraight(const core::Config& config, const FrictionWheelPlant::Params& plant_params,
                    const std::vector<double>& wheel_rpm_profile, double cmd_offset_rpm = 0.0) {
  core::ControlCore control(config);
  FrictionWheelPlant left(plant_params);
  FrictionWheelPlant right(plant_params);
  core::WheelFeedback fb;
  Trace trace;
  for (double target_rpm : wheel_rpm_profile) {
    const auto out = control.step(linearForWheelRpm(target_rpm), 0.0, kControlDt, fb);
    auto offset = [&](int cmd) {
      return cmd == 0 ? 0 : cmd + static_cast<int>(std::copysign(cmd_offset_rpm, cmd));
    };
    const int lcmd = out.stop ? 0 : offset(out.left_rpm);
    const int rcmd = out.stop ? 0 : offset(out.right_rpm);
    fb.valid = true;
    fb.left_rpm = left.measuredRpm();
    fb.right_rpm = right.measuredRpm();
    left.advance(lcmd, kControlDt);
    right.advance(rcmd, kControlDt);
    trace.left_rpm.push_back(left.rpm());
    trace.left_cmd.push_back(lcmd);
    trace.left_ref.push_back(out.left_ref_rpm);
  }
  return trace;
}

std::vector<double> holdProfile(double rpm, double seconds) {
  return std::vector<double>(static_cast<size_t>(std::lround(seconds / kControlDt)), rpm);
}

struct Ripple {
  double half_amplitude{0.0};
  double mean{0.0};
  double min{0.0};
  double frequency_hz{0.0};
};

// skip_sec 以降の定常部分の片振幅・平均・最小と、平均を上向きに横切る回数から周波数を求める。
Ripple measure(const std::vector<double>& x, double skip_sec) {
  const size_t start = static_cast<size_t>(std::lround(skip_sec / kControlDt));
  Ripple r;
  double sum = 0.0;
  double hi = -1e9;
  double lo = 1e9;
  for (size_t i = start; i < x.size(); ++i) {
    sum += x[i];
    hi = std::max(hi, x[i]);
    lo = std::min(lo, x[i]);
  }
  const double n = static_cast<double>(x.size() - start);
  r.mean = sum / n;
  r.half_amplitude = (hi - lo) / 2.0;
  r.min = lo;
  int crossings = 0;
  for (size_t i = start + 1; i < x.size(); ++i) {
    if (x[i - 1] < r.mean && x[i] >= r.mean) ++crossings;
  }
  r.frequency_hz = crossings / (n * kControlDt);
  return r;
}

}  // namespace

// --- プラントが実機の観察を再現すること（以降のテストの前提） ----------------------------------

TEST(LowSpeedOscillationPlant, FloorStickSlipsAtAboutOnePointFiveHertz) {
  const auto trace = driveStraight(baseConfig(), FrictionWheelPlant::floor(), holdProfile(10, 12));
  const auto r = measure(trace.left_rpm, 6.0);
  EXPECT_GT(r.half_amplitude, 6.0);  // 実機: 10 rpm で片振幅 6〜11 rpm
  EXPECT_LT(r.min, 1.0);             // 毎周期ほぼ止まる（張り付き）
  EXPECT_GT(r.frequency_hz, 1.2);    // 実機: 約 1.5〜1.75 Hz
  EXPECT_LT(r.frequency_hz, 2.0);
}

TEST(LowSpeedOscillationPlant, LiftedWheelIsSteady) {
  for (double rpm : {5.0, 10.0, 30.0}) {
    const auto trace =
        driveStraight(baseConfig(), FrictionWheelPlant::lifted(), holdProfile(rpm, 12));
    EXPECT_LT(measure(trace.left_rpm, 6.0).half_amplitude, 0.5) << "rpm=" << rpm;
  }
}

// rpm で摩擦を補う（指令に一定のずれを足す）と、ファームの積分がずれを速さに変えるだけで、
// トルクの補償にはならない: 7 rpm + 5 rpm は「12 rpm で走らせた」のと同じ振動になる。
// （7 rpm なのは、min_command_rpm 5 の停止判定を抜けるのに 7 rpm 以上が要るため）
TEST(LowSpeedOscillationPlant, RpmOffsetOnlyShiftsTheSpeed) {
  const auto plain12 = measure(
      driveStraight(baseConfig(), FrictionWheelPlant::floor(), holdProfile(12, 12)).left_rpm, 6.0);
  const auto offset = measure(
      driveStraight(baseConfig(), FrictionWheelPlant::floor(), holdProfile(7, 12), 5.0).left_rpm,
      6.0);
  ASSERT_GT(plain12.half_amplitude, 6.0);
  EXPECT_NEAR(offset.mean, 12.0, 1.0);  // 速さが 5 rpm 上がっただけ
  EXPECT_GT(offset.half_amplitude, 0.7 * plain12.half_amplitude);
}

// --- 速度誤差の位相進み ------------------------------------------------------------------------

// 加減速の後の揺れ戻し（線形の領域の弱い減衰）を抑える。定常の速さは変えない。
TEST(VelocityDampingClosedLoop, DampsTheRingingAfterARamp) {
  auto ringing = [](const core::Config& config) {
    const auto trace = driveStraight(config, FrictionWheelPlant::floor(), holdProfile(100, 4.0));
    // 目標到達（ランプ約 0.35 s）後の 0.5〜4.0 s の揺れと平均
    return measure(trace.left_rpm, 0.5);
  };
  const auto off = ringing(baseConfig());
  const auto on = ringing(dampedConfig());
  EXPECT_LT(on.half_amplitude, 0.7 * off.half_amplitude);
  EXPECT_NEAR(on.mean, 100.0, 1.0);
}

// 低速の張り付き（毎周期ほぼ止まる）は、このゲインでは消えない。実機でも低速には
// 効かなかった。rpm の指令だけでは、張り付きの元（ファームの積分と静止摩擦、または
// 低速でのファームの速度推定）に届かない。design/drive_floor_oscillation.md §4。
TEST(VelocityDampingClosedLoop, DoesNotCureVeryLowSpeedStickSlip) {
  const auto on = measure(
      driveStraight(dampedConfig(), FrictionWheelPlant::floor(), holdProfile(7, 12)).left_rpm, 6.0);
  EXPECT_GT(on.half_amplitude, 3.0);
  EXPECT_LT(on.min, 3.0);
}

TEST(VelocityDampingClosedLoop, KeepsLiftedWheelSteady) {
  for (double rpm : {5.0, 10.0, 30.0, 100.0}) {
    const auto trace =
        driveStraight(dampedConfig(), FrictionWheelPlant::lifted(), holdProfile(rpm, 12));
    EXPECT_LT(measure(trace.left_rpm, 6.0).half_amplitude, 1.0) << "rpm=" << rpm;
  }
}

// 誤差の微分なので、一定の追従遅れ（加速ランプ）には反応せず、立ち上がりを遅くしない。
TEST(VelocityDampingClosedLoop, DoesNotSlowTheRampAndReducesOvershoot) {
  auto riseAndOvershoot = [](const core::Config& config) {
    const auto trace = driveStraight(config, FrictionWheelPlant::floor(), holdProfile(100, 2.0));
    double t90 = -1.0;
    double peak = 0.0;
    for (size_t i = 0; i < trace.left_rpm.size(); ++i) {
      if (t90 < 0.0 && trace.left_rpm[i] >= 90.0) t90 = (i + 1) * kControlDt;
      peak = std::max(peak, trace.left_rpm[i]);
    }
    return std::make_pair(t90, peak - 100.0);
  };
  const auto [t90_off, over_off] = riseAndOvershoot(baseConfig());
  const auto [t90_on, over_on] = riseAndOvershoot(dampedConfig());
  ASSERT_GT(t90_off, 0.0);
  ASSERT_GT(t90_on, 0.0);
  EXPECT_LE(t90_on, t90_off + 0.04);
  EXPECT_LT(over_on, over_off);
}

// --- 既定・安全側の性質 ------------------------------------------------------------------------

TEST(VelocityDamping, DefaultConfigIsDisabled) {
  const core::Config config;
  EXPECT_FALSE(core::ControlCore(config).velocityDampingEnabled());
  // 既定では、ずれた実測を渡しても指令は目標そのまま
  core::ControlCore control(baseConfig());
  core::WheelFeedback fb;
  fb.valid = true;
  for (int k = 0; k < 100; ++k) {
    fb.left_rpm = (k % 2) ? 0 : 40;
    fb.right_rpm = -fb.left_rpm;
    const auto out = control.step(linearForWheelRpm(20), 0.0, kControlDt, fb);
    EXPECT_EQ(out.left_rpm, out.left_ref_rpm) << "k=" << k;
    EXPECT_EQ(out.right_rpm, out.right_ref_rpm) << "k=" << k;
    EXPECT_FALSE(out.damping_active);
  }
}

TEST(VelocityDamping, InvalidFeedbackFallsBackToReferenceAndRestarts) {
  core::ControlCore control(dampedConfig(0.5));
  core::WheelFeedback fb;
  fb.valid = true;
  core::Output out;
  for (int k = 0; k < 60; ++k) {
    fb.left_rpm = (k % 4 < 2) ? 0 : 40;
    fb.right_rpm = -fb.left_rpm;
    out = control.step(linearForWheelRpm(20), 0.0, kControlDt, fb);
  }
  ASSERT_TRUE(out.damping_active);
  core::WheelFeedback invalid;
  out = control.step(linearForWheelRpm(20), 0.0, kControlDt, invalid);
  EXPECT_FALSE(out.damping_active);
  EXPECT_EQ(out.left_rpm, out.left_ref_rpm);
  // 復帰した最初の tick は差分を作れないので補正 0（古い履歴を使わない）
  fb.left_rpm = 0;
  fb.right_rpm = 0;
  out = control.step(linearForWheelRpm(20), 0.0, kControlDt, fb);
  EXPECT_TRUE(out.damping_active);
  EXPECT_EQ(out.left_rpm, out.left_ref_rpm);
  EXPECT_EQ(out.right_rpm, out.right_ref_rpm);
}

TEST(VelocityDamping, ConfigChangeRestartsFromZeroCorrection) {
  core::ControlCore control(dampedConfig(0.5));
  core::WheelFeedback fb;
  fb.valid = true;
  for (int k = 0; k < 60; ++k) {
    fb.left_rpm = (k % 4 < 2) ? 0 : 40;
    fb.right_rpm = -fb.left_rpm;
    control.step(linearForWheelRpm(20), 0.0, kControlDt, fb);
  }
  control.setConfig(dampedConfig(0.3));
  const auto out = control.step(linearForWheelRpm(20), 0.0, kControlDt, fb);
  EXPECT_EQ(out.left_rpm, out.left_ref_rpm);
  EXPECT_EQ(out.right_rpm, out.right_ref_rpm);
  EXPECT_EQ(out.mode, core::DriveMode::kRun);  // 走行状態は維持
}

TEST(VelocityDamping, NeverReversesAndLeavesZeroTargetWheelStopped) {
  // 強いゲインと大きな上限で、実測を大きく振る。指令は目標と逆向きにならず、
  // 目標 0 の輪（信地旋回の止めた側）には補正を出さない。
  core::Config config = dampedConfig(2.0);
  config.velocity_damping.max_correction_rpm = 200.0;
  // 加速中も linear : angular の比を保ち、左輪の目標が常に 0 になるようにする
  config.max_angular_accel = config.max_linear_accel / (config.wheel_separation / 2.0);
  config.slew_taper_band_angular = config.slew_taper_band_linear / (config.wheel_separation / 2.0);
  core::ControlCore control(config);
  core::WheelFeedback fb;
  fb.valid = true;
  // 信地旋回: 右輪だけ回す（linear = angular * separation / 2 で左輪の目標が 0）
  const double angular = 1.0;
  const double linear = angular * config.wheel_separation / 2.0;
  bool clamped = false;
  for (int k = 0; k < 200; ++k) {
    fb.left_rpm = (k % 2) ? 300 : -300;
    fb.right_rpm = (k % 3) ? -500 : 500;
    const auto out = control.step(linear, angular, kControlDt, fb);
    if (out.stop) continue;
    ASSERT_EQ(out.left_ref_rpm, 0);
    ASSERT_LT(out.right_ref_rpm, 0);
    EXPECT_EQ(out.left_rpm, 0) << "k=" << k;
    EXPECT_LE(out.right_rpm, 0) << "k=" << k;
    clamped = clamped || out.right_rpm == 0;
  }
  EXPECT_TRUE(clamped);  // 符号ガードが実際に効く状況を作れていること
}
