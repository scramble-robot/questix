// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__DRIVE_SLEW_HPP_
#define MOTOR_CONTROL_APP__DRIVE_SLEW_HPP_

#include <algorithm>
#include <cmath>

namespace motor_control_app::drive_slew {

// クランプに使う dt の有効範囲 [s]。
// 下限: 同時刻・時計逆行での不定挙動を防ぐ。
// 上限: 指令が途絶えた後の最初の 1 ステップが無制限ジャンプにならないようにする
// （以前は dt >= 1.0 でクランプ自体がスキップされ、ステップ指令が素通りしていた）。
inline constexpr double kMinDtSec = 1e-3;
inline constexpr double kMaxDtSec = 0.1;

// スルーレート制限に使う dt を有効範囲に正規化する。
// has_last=false（activate 直後・ウォッチドッグ/非常停止/フォールト後のリセット直後）は
// 経過時間が定義できないため上限値で 0 からのランプ開始を許す。
inline double normalizeDt(bool has_last, double raw_dt_sec) {
  if (!has_last) {
    return kMaxDtSec;
  }
  return std::clamp(raw_dt_sec, kMinDtSec, kMaxDtSec);
}

// テーパー帯内で target に十分近づいたと見なす相対しきい値。
// 比例絞りは幾何級数的に近づくだけで厳密には target に一致しないため、帯幅に対して
// この割合まで縮んだら target にスナップして有限ステップで収束させる。
// 0.1% は車輪 RPM 換算で 0.01 RPM 未満（lround の量子化以下）であり指令値に影響しない。
inline constexpr double kTaperSnapRatio = 1e-3;

// 1 軸のスルーレート制限（テーパー付き）。前回値 last から 1 ステップに max_accel * dt まで
// しか変化させない。max_accel <= 0 で制限無効（target をそのまま返す）。
//
// taper_band > 0 のとき、残差 |target - last| が taper_band 未満の領域でステップ上限を
// 残差に比例して絞る。これは目標到達時に加速度がステップで 0 に落ちる（ジャーク無限）のを
// 避けるためのもの。一次のレート制限だけだとスティック満倒で指令が飽和した瞬間に
// 加速度が急に消え、追従遅れ分が溜まった M0602C ファーム速度ループがオーバーシュートして
// 引き戻す（＝一旦減速してから再加速する）挙動を励起する。
//
// 絞りは幾何級数的な収束になり、残差の時定数は taper_band / max_accel [s] になる
// （例: taper_band 0.15 m/s, max_accel 1.0 m/s^2 -> 約 0.15 s で漸近）。
// taper_band は 1 ステップの上限 max_accel * dt より十分大きくないと効かない
// （残差がその範囲に入る前に target へ到達してしまう）。
inline double clampRateTapered(double target, double last, double max_accel, double dt_sec,
                               double taper_band) {
  if (max_accel <= 0.0) {
    return target;
  }
  const double delta = target - last;
  const double residual = std::abs(delta);

  double max_delta = max_accel * dt_sec;
  if (taper_band > 0.0 && residual < taper_band) {
    if (residual <= taper_band * kTaperSnapRatio) {
      return target;
    }
    max_delta *= residual / taper_band;
  }

  if (delta > max_delta) {
    return last + max_delta;
  }
  if (delta < -max_delta) {
    return last - max_delta;
  }
  return target;
}

// テーパー無しのスルーレート制限（従来挙動）。
inline double clampRate(double target, double last, double max_accel, double dt_sec) {
  return clampRateTapered(target, last, max_accel, dt_sec, /*taper_band=*/0.0);
}

// 注: デマンド適応加速度（demandScaledAccel / clampRateAdaptive）は実機評価の結果、
// 削除した。残差ベースの適応は「入力の丁寧さ」と「追従の遅れ」を区別できず、微小入力の
// 応答を鈍くしていた（狙いと逆。design/drive_control_refactor.md 参照）。

// ホスト側スルーレート制限 max_linear_accel [m/s^2] を、ファーム側 accel_time と同じ単位
// （ms/rpm = 1 rpm の目標変化にかかる時間）へ換算する。
// 車輪 RPM 換算の加速度は max_linear_accel * 60 / (2*pi*wheel_radius) [rpm/s] なので、
// ms/rpm = 1000 / それ。
//
// 二重に加速プロファイルを持っている（ホストのレート制限とファームの accel_time）ため、
// 値が大きい＝傾きが緩い側が実効的な加速プロファイルを支配する。ファーム側の平滑化を
// 効かせたいなら accel_time [ms/rpm] はこの換算値より十分小さくしておく必要がある。
//
// 制限無効（max_linear_accel <= 0）や不正な車輪半径では換算できないため 0 を返す。
inline double hostRampMsPerRpm(double max_linear_accel, double wheel_radius) {
  if (max_linear_accel <= 0.0 || wheel_radius <= 0.0) {
    return 0.0;
  }
  constexpr double kTwoPi = 6.283185307179586;
  const double rpm_per_sec = max_linear_accel * 60.0 / (kTwoPi * wheel_radius);
  if (rpm_per_sec <= 0.0) {
    return 0.0;
  }
  return 1000.0 / rpm_per_sec;
}

}  // namespace motor_control_app::drive_slew

#endif  // MOTOR_CONTROL_APP__DRIVE_SLEW_HPP_
