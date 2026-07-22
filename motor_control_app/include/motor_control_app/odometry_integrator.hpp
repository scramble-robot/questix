// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__ODOMETRY_INTEGRATOR_HPP_
#define MOTOR_CONTROL_APP__ODOMETRY_INTEGRATOR_HPP_

#include <cmath>

namespace motor_control_app::odometry {

// 積分の妥当性ガード（積分器ヘッダ内の名前付き定数。表面積を最小化するため
// パラメータ化していない。必要になったら DriveComponent 側でパラメータ化する）。
// dt がこの秒数を超えたら積分をスキップして時刻を再アンカーする
// （deactivate 中のギャップや長い停止を積分しない）。
inline constexpr double kMaxOdomDtSec = 1.0;
// 左右フィードバックがこの秒数以上更新されなければ stale とみなす
// （非常停止・未通電を含む）。stale RPM によるポーズドリフトを防ぐ。
inline constexpr double kMaxFeedbackAgeSec = 0.5;

// 2D 平面ポーズ（odom フレーム）。
struct Pose2D {
  double x{0.0};
  double y{0.0};
  double theta{0.0};
};

// yaw のみのクォータニオン（z, w 成分。x=y=0）。
struct YawQuaternion {
  double z{0.0};
  double w{1.0};
};

// 角度を [-pi, pi] に正規化する（±pi は同一 heading なので境界 -pi は -pi のまま返り得る）。
inline double normalizeAngle(double angle) {
  // atan2(sin, cos) が最も丸め誤差に頑健。
  return std::atan2(std::sin(angle), std::cos(angle));
}

// dt が積分に使える値か（正かつ kMaxOdomDtSec 以下）。
inline bool isValidDt(double dt_sec, double max_dt_sec) {
  return dt_sec > 0.0 && dt_sec <= max_dt_sec;
}

// フィードバックが新鮮か（一度でも受信済みかつ経過秒が max_age_sec 以下）。
inline bool isFeedbackFresh(bool has_feedback, double age_sec, double max_age_sec) {
  return has_feedback && age_sec <= max_age_sec;
}

/**
 * @brief unicycle モデルの厳密弧積分（1 サンプル内で twist 一定を仮定）。
 *
 * |angular| がほぼ 0 のときは直進式にフォールバックする。それ以外は
 * 円弧の閉形式解を使う（RK2 と同コストで厳密）。theta は (-pi, pi] に正規化。
 * @param pose 現在ポーズ
 * @param linear 前進速度 [m/s]
 * @param angular 角速度 [rad/s]
 * @param dt_sec 積分区間 [s]
 * @return 積分後ポーズ
 */
inline Pose2D integrate(const Pose2D& pose, double linear, double angular, double dt_sec) {
  Pose2D next = pose;
  const double dtheta = angular * dt_sec;
  if (std::fabs(angular) < 1e-9) {
    // 直進（w ≈ 0）: 現在の heading 方向へ v*dt 前進。
    const double dist = linear * dt_sec;
    next.x = pose.x + dist * std::cos(pose.theta);
    next.y = pose.y + dist * std::sin(pose.theta);
    next.theta = normalizeAngle(pose.theta + dtheta);
    return next;
  }
  // 円弧の閉形式解: r = v / w、中心まわりに dtheta 回転。
  const double radius = linear / angular;
  const double theta_new = pose.theta + dtheta;
  next.x = pose.x + radius * (std::sin(theta_new) - std::sin(pose.theta));
  next.y = pose.y - radius * (std::cos(theta_new) - std::cos(pose.theta));
  next.theta = normalizeAngle(theta_new);
  return next;
}

// yaw 角からクォータニオン（z, w）を計算する。
inline YawQuaternion yawToQuaternion(double theta) {
  YawQuaternion q;
  q.z = std::sin(theta * 0.5);
  q.w = std::cos(theta * 0.5);
  return q;
}

}  // namespace motor_control_app::odometry

#endif  // MOTOR_CONTROL_APP__ODOMETRY_INTEGRATOR_HPP_
