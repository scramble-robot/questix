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
/**
 * @brief 実測 1 回分: 受信時刻（単調時計）と、その実測（ローパス前）から出した車体の twist。
 */
struct TwistSample {
  double t_sec{0.0};    // [s] 両輪のフィードバック受信時刻の平均
  double linear{0.0};   // [m/s]
  double angular{0.0};  // [rad/s]
};

/**
 * @brief 連続する 2 つの実測の間を台形で積分する（2 点の平均の twist で円弧積分）。
 *
 * dt は 2 つの受信時刻の差なので、積分の時刻が実測の時刻とそろう（別タイマーで「手元の最新の
 * 実測 × 経過時間」を積分すると、タイマーの位相差のぶん遅れ、旋回中の向きの遅れが位置のずれに
 * なる）。区間が無効（<= 0 または max_gap_sec 超。途絶・未通電）なら積分せず pose を返す。
 * @param integrated 非 null なら、積分したかを書き込む
 */
inline Pose2D integrateBetween(const Pose2D& pose, const TwistSample& prev, const TwistSample& next,
                               double max_gap_sec, bool* integrated = nullptr) {
  const double dt = next.t_sec - prev.t_sec;
  const bool ok = isValidDt(dt, max_gap_sec);
  if (integrated != nullptr) {
    *integrated = ok;
  }
  if (!ok) {
    return pose;
  }
  return integrate(pose, 0.5 * (prev.linear + next.linear), 0.5 * (prev.angular + next.angular),
                   dt);
}

/// 配信時刻へのポーズの延長の上限 [s]（実測の間隔が空いた停止中に、古い速度で延ばしすぎない）。
inline constexpr double kMaxExtrapolationSec = 0.1;

/**
 * @brief 最後の実測の時刻で積分したポーズを、配信時刻 now_sec まで最後の twist で延ばす。
 *
 * 延ばした分は積分の状態に持ち越さない（次の実測で台形積分し直す）。スタンプ（配信時刻）と
 * ポーズの時刻がそろい、TF の時刻も単調に進む。延ばす時間は 0..kMaxExtrapolationSec に丸める。
 */
inline Pose2D extrapolate(const Pose2D& pose, const TwistSample& last, double now_sec) {
  const double dt = now_sec - last.t_sec;
  if (!(dt > 0.0)) {
    return pose;
  }
  return integrate(pose, last.linear, last.angular,
                   dt < kMaxExtrapolationSec ? dt : kMaxExtrapolationSec);
}

inline YawQuaternion yawToQuaternion(double theta) {
  YawQuaternion q;
  q.z = std::sin(theta * 0.5);
  q.w = std::cos(theta * 0.5);
  return q;
}

}  // namespace motor_control_app::odometry

#endif  // MOTOR_CONTROL_APP__ODOMETRY_INTEGRATOR_HPP_
