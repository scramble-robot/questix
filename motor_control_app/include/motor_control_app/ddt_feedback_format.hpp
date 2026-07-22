// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef MOTOR_CONTROL_APP__DDT_FEEDBACK_FORMAT_HPP_
#define MOTOR_CONTROL_APP__DDT_FEEDBACK_FORMAT_HPP_

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <iomanip>
#include <sstream>
#include <string>

#include "builtin_interfaces/msg/time.hpp"
#include "questix_msgs/msg/motor_feedback.hpp"

namespace motor_control_app {

// ANSI escape sequences used by the ddt_feedback_monitor CLI.
constexpr const char* kAnsiCursorHome = "\033[H\033[J";  // home + clear-below
constexpr const char* kAnsiBoldRed = "\033[1;31m";
constexpr const char* kAnsiDim = "\033[2m";
constexpr const char* kAnsiReset = "\033[0m";

/// Human label for a MotorFeedback `mode` field value.
inline std::string modeToStr(uint8_t mode) {
  if (mode == questix_msgs::msg::MotorFeedback::MODE_CURRENT_LOOP) {
    return "CURRENT";
  }
  if (mode == questix_msgs::msg::MotorFeedback::MODE_VELOCITY_LOOP) {
    return "VELOCITY";
  }
  return "?(" + std::to_string(static_cast<int>(mode)) + ")";
}

/// Convert raw rotor position (0..32767) to degrees (0..360).
inline double positionRawToDeg(uint16_t position_raw) {
  return static_cast<double>(position_raw) * 360.0 / 32767.0;
}

/// builtin_interfaces/Time stamp as float seconds.
inline double stampSec(const builtin_interfaces::msg::Time& stamp) {
  return static_cast<double>(stamp.sec) + static_cast<double>(stamp.nanosec) * 1e-9;
}

/// Fixed-width column header matching formatRow().
inline std::string tableHeader() {
  std::ostringstream os;
  os << std::right << std::setw(4) << "ID" << ' ' << std::setw(8) << "Mode" << ' ' << std::setw(9)
     << "Cur[A]" << ' ' << std::setw(9) << "Cur(raw)" << ' ' << std::setw(9) << "Vel[rpm]" << ' '
     << std::setw(9) << "Tgt[rpm]" << ' ' << std::setw(9) << "Pos[deg]" << ' ' << std::setw(9)
     << "Pos(raw)" << ' ' << std::setw(6) << "Fault" << ' ' << std::setw(8) << "Age[s]";
  return os.str();
}

/**
 * @brief Format one MotorFeedback as a fixed-width table row.
 *
 * @param fb        per-motor feedback (questix_msgs/MotorFeedback).
 * @param now_sec   current wall time [s], used to compute feedback age.
 * @param stale_sec mark the row stale once its age exceeds this threshold.
 * @param color     wrap the row in ANSI styling (red on fault, dim on stale).
 *
 * current_amp is displayed as received (publisher already applies
 * ddt_protocol::currentRawToAmp = raw*8/32767). A stamp of 0 means "no
 * feedback yet" and renders age as "--". Pure function (no I/O, no rclcpp).
 */
inline std::string formatRow(const questix_msgs::msg::MotorFeedback& fb, double now_sec,
                             double stale_sec, bool color) {
  double stamp = stampSec(fb.header.stamp);
  std::string age_str;
  bool stale;
  if (stamp == 0.0) {
    age_str = "--";
    stale = true;
  } else {
    double age = std::max(0.0, now_sec - stamp);
    char buf[16];
    std::snprintf(buf, sizeof(buf), "%.2f", age);
    age_str = buf;
    stale = age > stale_sec;
    if (stale) {
      age_str += "!";
    }
  }

  char pos_hex[8];
  std::snprintf(pos_hex, sizeof(pos_hex), "0x%04X", fb.position_raw);
  char fault_hex[8];
  std::snprintf(fault_hex, sizeof(fault_hex), "0x%02X", fb.fault_code);

  std::ostringstream os;
  os << std::right << std::setw(4) << static_cast<int>(fb.motor_id) << ' ' << std::setw(8)
     << modeToStr(fb.mode) << ' ' << std::fixed << std::setprecision(3) << std::setw(9)
     << fb.current_amp << ' ' << std::setw(9) << fb.current_raw << ' ' << std::setw(9)
     << fb.velocity_rpm << ' ' << std::setw(9) << fb.target_rpm << ' ' << std::setprecision(1)
     << std::setw(9) << positionRawToDeg(fb.position_raw) << ' ' << std::setw(9) << pos_hex << ' '
     << std::setw(6) << fault_hex << ' ' << std::setw(8) << age_str;
  std::string row = os.str();

  if (!color) {
    return row;
  }
  if (fb.fault_code != 0) {
    return kAnsiBoldRed + row + kAnsiReset;
  }
  if (stale) {
    return kAnsiDim + row + kAnsiReset;
  }
  return row;
}

}  // namespace motor_control_app

#endif  // MOTOR_CONTROL_APP__DDT_FEEDBACK_FORMAT_HPP_
