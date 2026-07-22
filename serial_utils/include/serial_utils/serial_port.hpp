// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#ifndef SERIAL_UTILS__SERIAL_PORT_HPP_
#define SERIAL_UTILS__SERIAL_PORT_HPP_

#include <fcntl.h>
#include <termios.h>
#include <unistd.h>

#include <cstdint>
#include <string>

#include "rclcpp/logger.hpp"

namespace serial_utils {

/// Configuration for opening and initializing a serial port.
///
/// Fields capture the per-site differences observed across the QUESTiX motor
/// and input drivers. Site-specific post-open steps (tcflush, RS485 ioctl) are
/// intentionally NOT part of this helper and remain at the call site.
struct SerialConfig {
  /// Flags passed to open(). Callers OR in their extra flags on top of the
  /// common O_RDWR | O_NOCTTY (e.g. O_SYNC, O_NDELAY, O_NONBLOCK).
  int open_flags = O_RDWR | O_NOCTTY;
  /// Baud rate. Supported: 9600, 19200, 38400, 57600, 115200, 230400, 460800,
  /// 921600. Unsupported values log a warning and fall back to 115200.
  int baud = 115200;
  /// termios VMIN: minimum number of bytes for a read to return.
  cc_t vmin = 0;
  /// termios VTIME: read timeout in deciseconds.
  cc_t vtime = 0;
};

/// Open a serial port and apply an 8N1 raw termios configuration.
///
/// Performs: open(port, cfg.open_flags) -> tcgetattr -> baud switch
/// (cfsetispeed/cfsetospeed) -> 8N1 raw (CS8, no parity, 1 stop bit,
/// no CRTSCTS, CLOCAL | CREAD, raw iflag/lflag/oflag) with VMIN/VTIME from
/// cfg -> tcsetattr(TCSANOW).
///
/// Site-specific steps such as tcflush and RS485 ioctl are left to the caller.
///
/// \param port   Device path, e.g. "/dev/ttyAMA0".
/// \param cfg    Open flags, baud rate and VMIN/VTIME.
/// \param logger Logger used for warning/error output.
/// \return A valid file descriptor (>= 0) on success, or -1 on failure. On any
///         failure after open, the descriptor is closed before returning -1.
int openSerial(const std::string& port, const SerialConfig& cfg,
               const rclcpp::Logger& logger = rclcpp::get_logger("serial_port"));

}  // namespace serial_utils

#endif  // SERIAL_UTILS__SERIAL_PORT_HPP_
