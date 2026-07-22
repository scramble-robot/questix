// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__MOTOR_STATUS_MSG_HPP_
#define MOTOR_CONTROL_APP__MOTOR_STATUS_MSG_HPP_

#include "motor_control_lib/ddt_motor_lib.hpp"
#include "motor_control_lib/ddt_protocol.hpp"
#include "questix_msgs/msg/motor_feedback.hpp"
#include "rclcpp/time.hpp"

namespace motor_control_app {

/**
 * @brief DdtMotorLib::MotorFeedbackData を questix_msgs/MotorFeedback に変換する。
 *
 *  - header.stamp: フィードバック受信済みなら now から経過秒を引いた実受信時刻、
 *    未受信なら 0（= 未受信を表す契約、msg 定義参照）。
 *  - current_amp: 生値から ddt_protocol::currentRawToAmp で換算する。
 *
 *  シリアル I/O や rclcpp ノードに依存しない純関数（単体テスト可能）。
 */
inline questix_msgs::msg::MotorFeedback toMotorFeedbackMsg(
    const motor_control_lib::DdtMotorLib::MotorFeedbackData& fb, const rclcpp::Time& now) {
  questix_msgs::msg::MotorFeedback msg;
  if (fb.has_feedback) {
    msg.header.stamp = now - rclcpp::Duration::from_seconds(fb.feedback_age_sec);
  } else {
    msg.header.stamp = rclcpp::Time(0, 0, now.get_clock_type());
  }
  msg.motor_id = fb.motor_id;
  msg.mode = fb.mode;
  msg.current_raw = fb.current_raw;
  msg.current_amp = motor_control_lib::ddt_protocol::currentRawToAmp(fb.current_raw);
  msg.velocity_rpm = fb.velocity_rpm;
  msg.target_rpm = fb.target_rpm;
  msg.position_raw = fb.position_raw;
  msg.temperature = fb.temperature;
  msg.fault_code = fb.fault_code;
  return msg;
}

}  // namespace motor_control_app

#endif  // MOTOR_CONTROL_APP__MOTOR_STATUS_MSG_HPP_
