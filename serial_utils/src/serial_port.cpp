// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "serial_utils/serial_port.hpp"

#include "rclcpp/logging.hpp"

namespace serial_utils {

int openSerial(const std::string& port, const SerialConfig& cfg, const rclcpp::Logger& logger) {
  int fd = open(port.c_str(), cfg.open_flags);
  if (fd < 0) {
    RCLCPP_ERROR(logger, "シリアルポートが開けませんでした: %s", port.c_str());
    return -1;
  }

  struct termios tty;
  if (tcgetattr(fd, &tty) != 0) {
    RCLCPP_ERROR(logger, "tcgetattr エラー: %s", port.c_str());
    close(fd);
    return -1;
  }

  // ボーレート設定
  speed_t speed = B115200;
  switch (cfg.baud) {
    case 9600:
      speed = B9600;
      break;
    case 19200:
      speed = B19200;
      break;
    case 38400:
      speed = B38400;
      break;
    case 57600:
      speed = B57600;
      break;
    case 115200:
      speed = B115200;
      break;
    case 230400:
      speed = B230400;
      break;
    case 460800:
      speed = B460800;
      break;
    case 921600:
      speed = B921600;
      break;
    default:
      RCLCPP_WARN(logger, "未対応のボーレート %d、115200を使用", cfg.baud);
      speed = B115200;
      break;
  }
  cfsetispeed(&tty, speed);
  cfsetospeed(&tty, speed);

  // 8N1 raw 設定（3実装の共通部分）
  tty.c_cflag = (tty.c_cflag & ~CSIZE) | CS8;  // データビット8
  tty.c_cflag &= ~(PARENB | PARODD);           // パリティなし
  tty.c_cflag &= ~CSTOPB;                      // ストップビット1
  tty.c_cflag &= ~CRTSCTS;                     // ハードウェアフロー制御無効
  tty.c_cflag |= (CLOCAL | CREAD);             // ローカルライン、受信有効

  tty.c_iflag &= ~(IXON | IXOFF | IXANY);  // ソフトウェアフロー制御無効
  tty.c_iflag &= ~(IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL);

  tty.c_lflag &= ~(ICANON | ECHO | ECHOE | ECHONL | ISIG | IEXTEN);  // Raw入力

  tty.c_oflag &= ~OPOST;  // Raw出力

  tty.c_cc[VMIN] = cfg.vmin;
  tty.c_cc[VTIME] = cfg.vtime;

  if (tcsetattr(fd, TCSANOW, &tty) != 0) {
    RCLCPP_ERROR(logger, "tcsetattr エラー: %s", port.c_str());
    close(fd);
    return -1;
  }

  return fd;
}

}  // namespace serial_utils
