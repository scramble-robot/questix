// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// ホスト側走行制御（ControlCore）の閉ループシミュレーションテスト。
//
// 目的: 従来「実機で試す以外に検証手段がなかった」領域（スルーレート・デマンド適応・
// テーパー・低速不感帯・停止ヒステリシスの組み合わせ挙動）を CI で回帰チェックする。
// ControlCore は ROS にもシリアルにも依存しないため、ファーム速度ループの簡易プラント
// モデルと組み合わせてステップ応答・整定時間・停止挙動をそのまま再現できる。
//
// 期待値は実測（このテストと同じコードを走らせた結果）に基づく characterization test。
// パラメータやスルーレート実装を変えると失敗するので、意図した変更かどうかを確認して
// 期待値を更新すること。design/drive_control_refactor.md §3 の検算と対応している。
//
// 注意: プラントモデルは実機の代替ではない。ファーム速度ループの定性的な性質
// （追従遅れ・低RPM域の減衰不足・量子化）だけを模したもので、ゲインや振動周波数の
// 絶対値を実機と一致させる意図はない。実機検証（Raspberry Pi 5 + 実車）が
// authoritative であることは変わらない。
#include <gtest/gtest.h>

#include <algorithm>
#include <cmath>
#include <vector>

#include "motor_control_app/control_core.hpp"

namespace core = motor_control_app::control_core;

namespace {

// launcher/config/drive_component.yaml（統合起動の Single Source of Truth）の値を写した
// 設定。YAML との一致を強制する仕組みではないため、YAML を変えたらここも見直す。
//
// デマンド適応（min_*_accel）は実機評価で無効化した。残差ベースの適応は「入力の丁寧さ」と
// 「追従の遅れ」を区別できず、微小入力の応答を鈍くしていたため（狙いと逆の効果）。
// 機構ごとの寄与は DemandAdaptationDominatesTheSettlingTail が明示的に測っている。
core::Config yamlConfig() {
  core::Config config;
  config.max_linear_accel = 3.0;
  config.max_angular_accel = 3.0;
  config.min_linear_accel = 0.0;
  config.min_angular_accel = 0.0;
  config.accel_demand_ref_linear = 0.3;
  config.accel_demand_ref_angular = 0.5;
  config.slew_taper_band_linear = 0.2;
  config.slew_taper_band_angular = 0.2;
  config.wheel_radius = 0.1;
  config.wheel_separation = 0.5;
  config.min_command_rpm = 5;
  return config;
}

constexpr double kControlDt = 0.02;  // control_rate 50 Hz
// joy_controller の angular_input_ratio 6.0 / longitudinal_input_ratio 2.0 =
// フルスティックの目標値
constexpr double kFullStickAngular = 6.0;  // [rad/s]
constexpr double kFullStickLinear = 2.0;   // [m/s]

// 車輪 RPM の量子化 1 RPM に相当する車体速度（wheel_radius 0.1, separation 0.5）。
// これ以下の残差は指令 RPM に現れないため「整定」とみなす。
constexpr double kAngularQuantum = 0.042;  // [rad/s]
constexpr double kLinearQuantum = 0.0105;  // [m/s]

// M0602C ファーム速度ループの簡易プラントモデル（1 車輪ぶん）。
//  - 一次遅れ: 指令 RPM への追従遅れ
//  - 低RPM域の減衰不足: |rpm| が kUnstableBelowRpm 未満のとき、実機ログで観測された振動
//    （目標 95 RPM 一定で実測 59〜118 RPM を約 1.8 Hz で往復）を模した正弦を重畳する
//  - 量子化: フィードバックの実測 RPM は整数
class FirmwarePlant {
public:
  int step(int commanded_rpm, double dt_sec) {
    const double target = static_cast<double>(commanded_rpm);
    rpm_ += (dt_sec / (kTauSec + dt_sec)) * (target - rpm_);

    double observed = rpm_;
    if (std::abs(rpm_) > 0.5 && std::abs(rpm_) < kUnstableBelowRpm) {
      observed += kOscillationAmplitudeRpm * std::sin(2.0 * M_PI * kOscillationHz * time_sec_);
    }
    time_sec_ += dt_sec;
    return static_cast<int>(std::lround(observed));
  }

  double internalRpm() const { return rpm_; }

  static constexpr double kUnstableBelowRpm = 120.0;

private:
  static constexpr double kTauSec = 0.08;
  static constexpr double kOscillationAmplitudeRpm = 25.0;
  static constexpr double kOscillationHz = 1.8;

  double rpm_{0.0};
  double time_sec_{0.0};
};

// 目標を一定に保って固定周期で tick し、指令が目標に整定するまでの時間 [s] を返す。
double settlingTime(core::ControlCore& control, double target_linear, double target_angular,
                    double dt_sec, double max_sim_sec = 10.0) {
  const bool turning = std::abs(target_angular) > 0.0;
  const double target = turning ? target_angular : target_linear;
  const double quantum = turning ? kAngularQuantum : kLinearQuantum;

  double elapsed = 0.0;
  while (elapsed < max_sim_sec) {
    const auto out = control.step(target_linear, target_angular, dt_sec);
    elapsed += dt_sec;
    if (std::abs(target - (turning ? out.angular : out.linear)) <= quantum) {
      return elapsed;
    }
  }
  return max_sim_sec;
}

}  // namespace

// --- Phase 1 の不変条件: 制御周期が上流の publish レートから独立していること -------------

// ControlCore は dt を引数で受け取り、目標の「到着タイミング」を一切見ない。そのため
// 目標更新レートを変えても固定周期 tick の指令列は同一になる。従来（イベント駆動）は
// dt = メッセージ到着間隔だったため、DualShock 20 Hz と UART 50 Hz で実効加速度
// プロファイルが変わっていた（design §2 P1）。
TEST(ControlCoreRateIndependence, CommandSequenceIsIdenticalAcrossTargetUpdateRates) {
  const auto config = yamlConfig();
  constexpr int kTicks = 150;  // 3 秒 @ 50 Hz

  // 目標更新が毎 tick（50 Hz 相当）
  core::ControlCore every_tick(config);
  std::vector<double> reference;
  for (int i = 0; i < kTicks; ++i) {
    reference.push_back(every_tick.step(0.0, kFullStickAngular, kControlDt).angular);
  }

  // 目標更新が 2 tick ごと（25 Hz 相当）と 5 tick ごと（10 Hz 相当）。目標値そのものは
  // 同じなので、「最新目標を保持して固定周期で制御する」構造なら指令列は完全に一致する。
  for (const int stride : {2, 5}) {
    core::ControlCore strided(config);
    double held_target = 0.0;
    for (int i = 0; i < kTicks; ++i) {
      if (i % stride == 0) {
        held_target = kFullStickAngular;
      }
      const double command = strided.step(0.0, held_target, kControlDt).angular;
      EXPECT_DOUBLE_EQ(command, reference[i]) << "stride " << stride << ", tick " << i;
    }
  }
}

// 制御周期そのものを変えても、同じ実時間での到達点は一致する（dt が定数として
// 正しく効いていることの確認）。
TEST(ControlCoreRateIndependence, SameElapsedTimeReachesSameCommand) {
  const auto config = yamlConfig();

  core::ControlCore at50hz(config);
  for (int i = 0; i < 50; ++i) {  // 1.0 秒
    at50hz.step(0.0, kFullStickAngular, 0.02);
  }

  core::ControlCore at100hz(config);
  for (int i = 0; i < 100; ++i) {  // 1.0 秒
    at100hz.step(0.0, kFullStickAngular, 0.01);
  }

  // 一定ランプ区間なので離散化誤差（1 ステップ分）以内で一致する
  EXPECT_NEAR(at50hz.lastAngular(), at100hz.lastAngular(), 0.1);
}

// --- 整定時間の characterization（design §3.1 の検算に対応） ----------------------------

// フルスティック旋回（0 -> 6.0 rad/s）の整定は 2.04 秒。
// 大半（1.82 秒）は max_angular_accel 3.0 のレート上限そのもので、テーパーの尾が
// 残り 0.2 秒。旋回の追従を速くしたいなら max_angular_accel を上げるしかない
// （デマンド適応を無効化しても 2.04 秒より速くはならない）。
TEST(ControlCoreSettling, FullStickTurnSettlesInAboutTwoSeconds) {
  core::ControlCore control(yamlConfig());
  const double settling = settlingTime(control, 0.0, kFullStickAngular, kControlDt);
  EXPECT_NEAR(settling, 2.04, 0.12);
}

// max_angular_accel を上げれば旋回の追従は比例して速くなる（実機での主レバー）。
// ただし低RPMファーム速度ループの励起とのトレードオフがあるため、実機で段階的に
// 上げて振動が出ない上限を探す前提の数値（design §3.2）。
TEST(ControlCoreSettling, RaisingMaxAngularAccelSpeedsUpTurning) {
  auto faster = yamlConfig();
  faster.max_angular_accel = 6.0;
  core::ControlCore control(faster);
  EXPECT_NEAR(settlingTime(control, 0.0, kFullStickAngular, kControlDt), 1.02, 0.10);
}

// 尾の主因はデマンド適応（min_angular_accel）で、テーパー単独の寄与は小さい。
// この分解が崩れたら、どちらのレバーで整定を調整すべきかの前提が変わる。
TEST(ControlCoreSettling, DemandAdaptationDominatesTheSettlingTail) {
  // 出荷設定（適応 OFF・テーパー ON）
  core::ControlCore shipped(yamlConfig());
  const double settling_shipped = settlingTime(shipped, 0.0, kFullStickAngular, kControlDt);

  // 適応を再有効化（PR #141 当時の設定）
  auto adaptation_on = yamlConfig();
  adaptation_on.min_angular_accel = 0.15;
  core::ControlCore with_adaptation(adaptation_on);
  const double settling_with_adaptation =
      settlingTime(with_adaptation, 0.0, kFullStickAngular, kControlDt);

  // テーパーも切った純粋なレート上限のみ = 6.0 / 3.0 = 2.00 秒
  auto both_off = yamlConfig();
  both_off.slew_taper_band_angular = 0.0;
  core::ControlCore pure_rate_limit(both_off);
  const double settling_pure = settlingTime(pure_rate_limit, 0.0, kFullStickAngular, kControlDt);

  EXPECT_NEAR(settling_pure, 2.00, 0.06);
  EXPECT_NEAR(settling_shipped, 2.04, 0.12);
  // 適応を有効に戻すと 2.44 秒まで伸びる = 尾の主因はデマンド適応
  EXPECT_NEAR(settling_with_adaptation, 2.44, 0.12);
  EXPECT_GT(settling_with_adaptation, settling_shipped);
}

// デマンド適応は微小入力の応答を鈍くしていた（狙いと逆）。これが無効化の根拠。
// 実機で「追従性が低い」と報告された症状のうち、微小操作の鈍さはこれで説明できる。
TEST(ControlCoreSettling, DemandAdaptationMadeSmallInputsSluggish) {
  constexpr double kSmallTurn = 0.3;  // [rad/s] スティックをわずかに倒した相当

  core::ControlCore shipped(yamlConfig());
  const double settling_shipped = settlingTime(shipped, 0.0, kSmallTurn, kControlDt);

  auto adaptation_on = yamlConfig();
  adaptation_on.min_angular_accel = 0.15;
  core::ControlCore with_adaptation(adaptation_on);
  const double settling_with_adaptation =
      settlingTime(with_adaptation, 0.0, kSmallTurn, kControlDt);

  EXPECT_NEAR(settling_shipped, 0.14, 0.04);
  EXPECT_NEAR(settling_with_adaptation, 0.52, 0.08);
  // 微小入力では適応有効時のほうが 3 倍以上遅い
  EXPECT_GT(settling_with_adaptation, settling_shipped * 2.0);
}

// 前進フルスティック（0 -> 2.0 m/s）は 0.78 秒（レート上限だけなら 0.67 秒）。
// デマンド適応を有効に戻すと 1.22 秒まで伸びる。
TEST(ControlCoreSettling, ForwardStepSettlesInAboutZeroPointEightSeconds) {
  core::ControlCore control(yamlConfig());
  EXPECT_NEAR(settlingTime(control, kFullStickLinear, 0.0, kControlDt), 0.78, 0.10);

  auto adaptation_on = yamlConfig();
  adaptation_on.min_linear_accel = 0.5;
  core::ControlCore with_adaptation(adaptation_on);
  EXPECT_NEAR(settlingTime(with_adaptation, kFullStickLinear, 0.0, kControlDt), 1.22, 0.12);
}

// テーパーは目標へ漸近的に近づくだけでオーバーシュートしない（単調）。
TEST(ControlCoreSettling, ForwardStepIsMonotonicWithoutOvershoot) {
  core::ControlCore control(yamlConfig());
  double previous = 0.0;
  for (int i = 0; i < 250; ++i) {  // 5 秒
    const auto out = control.step(kFullStickLinear, 0.0, kControlDt);
    EXPECT_GE(out.linear, previous - 1e-12) << "tick " << i << " で指令が減った";
    EXPECT_LE(out.linear, kFullStickLinear + 1e-9) << "tick " << i << " で目標を超えた";
    previous = out.linear;
  }
  EXPECT_NEAR(control.lastLinear(), kFullStickLinear, 1e-9);
}

// --- 低速不感帯と停止ヒステリシス -------------------------------------------------------

// min_command_rpm 未満に収まる微小な旋回指令は停止に丸められる
// （低RPMのファーム速度ループ不安定域を指令しないため）。
TEST(ControlCoreDeadband, TinyTurnCommandStaysStopped) {
  core::ControlCore control(yamlConfig());
  // 車輪 RPM = angular * (separation/2) / (2π*radius) * 60 = angular * 23.87
  // 0.1 rad/s -> 約 2 RPM で min_command_rpm 5 未満
  for (int i = 0; i < 200; ++i) {
    const auto out = control.step(0.0, 0.1, kControlDt);
    EXPECT_TRUE(out.stop) << "tick " << i << " で走行モードに入った";
    EXPECT_LT(std::abs(out.left_rpm), 5);
  }
}

// 不感帯を十分に超える指令ではすぐに走行モードへ入る（応答を殺していない）。
TEST(ControlCoreDeadband, FullStickTurnLeavesStopQuickly) {
  core::ControlCore control(yamlConfig());
  int leave_tick = -1;
  for (int i = 0; i < 200; ++i) {
    if (!control.step(0.0, kFullStickAngular, kControlDt).stop) {
      leave_tick = i;
      break;
    }
  }
  ASSERT_GE(leave_tick, 0) << "フルスティックでも走行モードに入らない";
  EXPECT_LE(leave_tick, 6) << "走行開始が遅すぎる（不感帯かスルーレートが変わった）";
}

// 停止 -> 走行の抜けには kExitMarginRpm ぶんの上乗せが要る（ヒステリシス）。
// min_command_rpm 5 の境界ちょうど（5 RPM）では停止のままで、毎 tick トグルしない。
// 単一閾値だと境界で {目標0+ブレーキ} と {目標N+無ブレーキ} が指令レートで交互に出て
// それ自体が振動源になる（drive_stop_gate.hpp 参照）。
TEST(ControlCoreStopGate, HoldingAtThresholdDoesNotToggle) {
  core::ControlCore control(yamlConfig());
  constexpr double kAtThreshold = 0.209;  // 5 RPM 相当

  // 整定させる
  for (int i = 0; i < 300; ++i) {
    control.step(0.0, kAtThreshold, kControlDt);
  }
  // 抜け閾値（5 + 2 = 7 RPM）に届かないので停止のまま
  ASSERT_TRUE(control.stopMode());

  for (int i = 0; i < 100; ++i) {
    EXPECT_TRUE(control.step(0.0, kAtThreshold, kControlDt).stop)
        << "tick " << i << " で停止/走行がトグルした";
  }
}

// --- 閉ループ（プラントモデル込み）------------------------------------------------------

// フルスピードから目標 0 にすると 0.8 秒で停止モードに入り、以後ずっと停止のまま
// （停止と走行の間でリミットサイクルに陥らない）。
TEST(ControlCoreClosedLoop, DecelerationReachesAndHoldsStop) {
  core::ControlCore control(yamlConfig());
  FirmwarePlant left_plant;
  FirmwarePlant right_plant;

  // フルスティック前進で加速する
  for (int i = 0; i < 200; ++i) {
    const auto out = control.step(kFullStickLinear, 0.0, kControlDt);
    left_plant.step(out.stop ? 0 : out.left_rpm, kControlDt);
    right_plant.step(out.stop ? 0 : out.right_rpm, kControlDt);
  }
  ASSERT_FALSE(control.stopMode()) << "加速後に走行モードになっていない";

  // 目標 0（スティック中立）で減速させる
  int first_stop_tick = -1;
  for (int i = 0; i < 400; ++i) {
    const auto out = control.step(0.0, 0.0, kControlDt);
    left_plant.step(out.stop ? 0 : out.left_rpm, kControlDt);
    right_plant.step(out.stop ? 0 : out.right_rpm, kControlDt);
    if (out.stop && first_stop_tick < 0) {
      first_stop_tick = i;
    }
    if (first_stop_tick >= 0) {
      EXPECT_TRUE(out.stop) << "tick " << i << " で停止から走行へ戻った（リミットサイクル）";
    }
  }

  ASSERT_GE(first_stop_tick, 0) << "減速しても停止モードに入らなかった";
  EXPECT_NEAR(first_stop_tick * kControlDt, 0.68, 0.10);
  EXPECT_NEAR(left_plant.internalRpm(), 0.0, 1.0) << "停止指令後もプラントが回っている";
}

// リセット後は 0 からのランプで再開する（武装解除 -> 再武装のたびにステップ指令が
// 素通りしないこと。design §2 P1 の「クランプ自体をスキップしていた」回帰の防止）。
TEST(ControlCoreClosedLoop, ResetRestartsRampFromZero) {
  core::ControlCore control(yamlConfig());
  for (int i = 0; i < 200; ++i) {
    control.step(kFullStickLinear, 0.0, kControlDt);
  }
  ASSERT_GT(control.lastLinear(), 1.0);

  control.reset();
  EXPECT_DOUBLE_EQ(control.lastLinear(), 0.0);
  EXPECT_DOUBLE_EQ(control.lastAngular(), 0.0);
  EXPECT_TRUE(control.stopMode());

  // 再開直後の 1 ステップは max_linear_accel * dt = 0.06 m/s を超えない
  const auto out = control.step(kFullStickLinear, 0.0, kControlDt);
  EXPECT_LE(out.linear, 3.0 * kControlDt + 1e-9);
}

// design §3.2 / §3.3 の核心: 動作点がファーム速度ループの不安定域にある限り、
// ホスト側の指令をどれだけ平滑化しても実測の振動は消えない。
// ホスト指令が完全に一定（p-p 0 RPM）でも、プラントの実測は約 50 RPM p-p で振動する。
TEST(ControlCoreClosedLoop, ConstantHostCommandStillOscillatesInsideUnstableRegion) {
  core::ControlCore control(yamlConfig());
  // 目標 4.0 rad/s -> 車輪 95 RPM = 実機ログの不安定動作点
  constexpr double kUnstableTarget = 4.0;
  for (int i = 0; i < 400; ++i) {
    control.step(0.0, kUnstableTarget, kControlDt);
  }
  const auto settled = control.step(0.0, kUnstableTarget, kControlDt);
  ASSERT_FALSE(settled.stop);
  ASSERT_EQ(std::abs(settled.left_rpm), 95);
  ASSERT_LT(std::abs(settled.left_rpm), FirmwarePlant::kUnstableBelowRpm);

  FirmwarePlant plant;
  for (int i = 0; i < 200; ++i) {  // プラントを整定させる
    plant.step(std::abs(settled.left_rpm), kControlDt);
  }

  int cmd_min = 100000, cmd_max = -100000;
  int measured_min = 100000, measured_max = -100000;
  for (int i = 0; i < 50; ++i) {  // 1 秒観測
    const auto out = control.step(0.0, kUnstableTarget, kControlDt);
    const int command = std::abs(out.left_rpm);
    cmd_min = std::min(cmd_min, command);
    cmd_max = std::max(cmd_max, command);
    const int measured = plant.step(command, kControlDt);
    measured_min = std::min(measured_min, measured);
    measured_max = std::max(measured_max, measured);
  }

  // ホスト指令は完全に一定
  EXPECT_EQ(cmd_max - cmd_min, 0) << "ホスト指令が振動している（前提が崩れた）";
  // それでも実測は大きく振動する = ホスト側のチューニングでは解決できない
  EXPECT_GT(measured_max - measured_min, 40) << "プラントモデルが不安定域を模していない";
}

// フルスティック旋回の動作点（143 RPM）は不安定域の外に出る。旋回レンジ 0〜143 RPM の
// 84% が不安定域（<120 RPM）に入るため、旋回の低〜中速が丸ごと問題領域になる。
// 動作点が変わったらこのテストで気づけるようにしておく（design §3.2）。
TEST(ControlCoreOperatingPoint, TurnRangeMostlyOverlapsUnstableRegion) {
  core::ControlCore control(yamlConfig());
  for (int i = 0; i < 400; ++i) {
    control.step(0.0, kFullStickAngular, kControlDt);
  }
  const auto out = control.step(0.0, kFullStickAngular, kControlDt);

  const int full_stick_rpm = std::abs(out.left_rpm);
  EXPECT_NEAR(full_stick_rpm, 143, 3);

  // 不安定域が旋回レンジの何割を占めるか
  const double unstable_fraction = FirmwarePlant::kUnstableBelowRpm / full_stick_rpm;
  EXPECT_GT(unstable_fraction, 0.7) << "旋回レンジと不安定域の重なりが想定より小さい";
}

int main(int argc, char** argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
