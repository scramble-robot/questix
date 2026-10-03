// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__DRIVE_CONTROL_SAMPLE_MSG_HPP_
#define MOTOR_CONTROL_APP__DRIVE_CONTROL_SAMPLE_MSG_HPP_

#include <cmath>
#include <cstdint>
#include <limits>
#include <string>

#include "motor_control_lib/ddt_motor_lib.hpp"
#include "motor_control_lib/drive_mode_fsm.hpp"
#include "questix_msgs/msg/drive_control_sample.hpp"
#include "questix_msgs/msg/drive_control_wheel_sample.hpp"
#include "rclcpp/time.hpp"

namespace motor_control_app::drive_control_sample {

using DriveControlSample = questix_msgs::msg::DriveControlSample;
using DriveControlWheelSample = questix_msgs::msg::DriveControlWheelSample;

/**
 * @brief 1 輪ぶんの診断サンプルの材料（制御 tick が集める）。
 *
 * stats_before は tick の開始時、stats_after / feedback は tick の送受信がすべて終わった後に
 * DdtMotorLib から取得する。差を取ることで「この tick で新しいフレームを受信したか」
 * 「この tick に送受信があったか」が決まる。
 */
struct WheelInput {
  int ref_rpm{0};      // 補正前の車輪目標（整数化後）
  int command_rpm{0};  // ライブラリへ渡した速度指令（停止フレームは 0）
  motor_control_lib::DdtMotorLib::MotorTransactionStats stats_before{};
  motor_control_lib::DdtMotorLib::MotorTransactionStats stats_after{};
  motor_control_lib::DdtMotorLib::MotorFeedbackData feedback{};
};

/// 1 tick ぶんの診断サンプルの材料。
struct TickInput {
  uint32_t seq{0};
  rclcpp::Time tick_start{0, 0, RCL_ROS_TIME};  // header.stamp
  rclcpp::Time now{0, 0, RCL_ROS_TIME};  // feedback_stamp を求める基準（tick の終わり）
  double control_period_sec{0.0};
  double tick_duration_sec{0.0};
  bool current_mode{false};
  motor_control_lib::drive_mode_fsm::DriveMode drive_mode{
      motor_control_lib::drive_mode_fsm::DriveMode::kStop};
  uint8_t tick_action{DriveControlSample::TICK_IDLE};
  bool lqr_active{false};
  double shaped_linear{0.0};
  double shaped_angular{0.0};
  bool command_sent{false};
  bool stop_frame{false};
  WheelInput left;
  WheelInput right;
};

inline uint8_t toDriveModeField(motor_control_lib::drive_mode_fsm::DriveMode mode) {
  using motor_control_lib::drive_mode_fsm::DriveMode;
  switch (mode) {
    case DriveMode::kStop:
      return DriveControlSample::DRIVE_MODE_STOP;
    case DriveMode::kCreep:
      return DriveControlSample::DRIVE_MODE_CREEP;
    case DriveMode::kRun:
      return DriveControlSample::DRIVE_MODE_RUN;
  }
  return DriveControlSample::DRIVE_MODE_STOP;
}

/**
 * @brief 1 輪ぶんを questix_msgs/DriveControlWheelSample に変換する（純関数）。
 *
 *  - feedback_new: この tick で有効フレームの受信数が増えたか。
 *  - roundtrip_ms / response_timeout: この tick に送受信があったときだけ直近の値。無ければ
 *    NaN / false（前の tick の値を持ち越さない）。
 *  - feedback_stamp: 受信済みなら now - 受信経過秒、未受信なら 0（MotorFeedback と同じ契約）。
 *  - ワイヤ値（mode / velocity_rpm_raw / position_raw / current_raw / fault_code）は符号も含め
 *    そのまま（右輪は前進が負）。
 *  - command_current_raw は current モードのときだけ（velocity は 0）。
 */
inline DriveControlWheelSample toWheelSampleMsg(const WheelInput& in, bool current_mode,
                                                const rclcpp::Time& now) {
  DriveControlWheelSample msg;
  msg.ref_rpm = in.ref_rpm;
  msg.command_rpm = in.command_rpm;
  msg.command_current_raw = current_mode ? in.stats_after.last_current_raw_sent : 0;

  msg.feedback_new = in.stats_after.feedback_count > in.stats_before.feedback_count;
  // uint32 に収まらない累積値は下位 32 bit（msg 定義: 2^32 で巡回）。
  msg.feedback_count = static_cast<uint32_t>(in.stats_after.feedback_count & 0xFFFFFFFFu);
  if (in.feedback.has_feedback) {
    msg.feedback_stamp = now - rclcpp::Duration::from_seconds(in.feedback.feedback_age_sec);
  } else {
    msg.feedback_stamp = rclcpp::Time(0, 0, now.get_clock_type());
  }
  const bool exchanged = in.stats_after.transactions > in.stats_before.transactions;
  msg.response_timeout = exchanged && in.stats_after.last_response_timeout;
  msg.roundtrip_ms = (exchanged && !in.stats_after.last_response_timeout)
                         ? static_cast<float>(in.stats_after.last_roundtrip_ms)
                         : std::numeric_limits<float>::quiet_NaN();

  msg.mode = in.feedback.mode;
  msg.velocity_rpm_raw = in.feedback.velocity_rpm_raw;
  msg.position_raw = in.feedback.position_raw;
  msg.current_raw = in.feedback.current_raw;
  msg.fault_code = in.feedback.fault_code;
  return msg;
}

/**
 * @brief 1 tick ぶんを questix_msgs/DriveControlSample に変換する（純関数。ROS ノード・シリアルに
 * 依存しない。drive_component の制御 tick の最後に呼ぶ）。
 */
inline DriveControlSample toDriveControlSampleMsg(const TickInput& in) {
  DriveControlSample msg;
  msg.header.stamp = in.tick_start;
  msg.seq = in.seq;
  msg.control_period_sec = in.control_period_sec;
  msg.tick_duration_sec = in.tick_duration_sec;
  msg.control_mode = in.current_mode ? "current" : "velocity";
  msg.drive_mode = toDriveModeField(in.drive_mode);
  msg.tick_action = in.tick_action;
  msg.lqr_active = in.lqr_active;
  msg.shaped_linear = in.shaped_linear;
  msg.shaped_angular = in.shaped_angular;
  msg.command_sent = in.command_sent;
  msg.stop_frame = in.stop_frame;
  msg.left = toWheelSampleMsg(in.left, in.current_mode, in.now);
  msg.right = toWheelSampleMsg(in.right, in.current_mode, in.now);
  return msg;
}

}  // namespace motor_control_app::drive_control_sample

#endif  // MOTOR_CONTROL_APP__DRIVE_CONTROL_SAMPLE_MSG_HPP_
