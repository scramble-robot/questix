// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__DRIVE_SLEW_HPP_
#define MOTOR_CONTROL_APP__DRIVE_SLEW_HPP_

#include <algorithm>

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

// 1 軸のスルーレート制限。前回値 last から 1 ステップに max_accel * dt までしか
// 変化させない。max_accel <= 0 で制限無効（target をそのまま返す）。
inline double clampRate(double target, double last, double max_accel, double dt_sec) {
  if (max_accel <= 0.0) {
    return target;
  }
  const double max_delta = max_accel * dt_sec;
  const double delta = target - last;
  if (delta > max_delta) {
    return last + max_delta;
  }
  if (delta < -max_delta) {
    return last - max_delta;
  }
  return target;
}

}  // namespace motor_control_app::drive_slew

#endif  // MOTOR_CONTROL_APP__DRIVE_SLEW_HPP_
