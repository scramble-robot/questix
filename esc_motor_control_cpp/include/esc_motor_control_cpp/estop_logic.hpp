// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#pragma once

namespace esc_motor_control_cpp {

// /emergency_stop 受信時のエッジ判定（ROS 非依存・テスト用に純ロジック化）。
struct EstopTransition {
  bool send_stop{false};    // 立ち上がりエッジ: set_motor_speed(0.0) を即時実行
  bool log_release{false};  // 立ち下がりエッジ: 解除の INFO ログを出す
};

// active フラグの前回値と今回値からアクションを決める。
// 立ち上がり（!was && now）  -> send_stop（即時停止）
// 立ち下がり（was && !now）  -> log_release（解除ログのみ。モータは押下エッジまで停止のまま）
// 変化なし                    -> 何もしない
inline EstopTransition decideEstopTransition(bool was_active, bool now_active) {
  EstopTransition result;
  if (now_active && !was_active) {
    result.send_stop = true;
  } else if (!now_active && was_active) {
    result.log_release = true;
  }
  return result;
}

}  // namespace esc_motor_control_cpp
