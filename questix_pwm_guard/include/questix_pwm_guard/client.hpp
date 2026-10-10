// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#pragma once
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <sstream>
#include <string>
namespace questix_pwm_guard {
// Versioned ASCII decimal fields; no host byte-order dependence. One SOCK_SEQPACKET frame/request.
struct Reply {
  bool ok{false};
  std::string state{"FAULT_UNKNOWN"};
  int applied{-1};
  int error{-EIO};
  uint64_t session{0};
};
class Client {
public:
  Client() = default;
  ~Client() { close(); }
  Client(const Client&) = delete;
  Client& operator=(const Client&) = delete;
  bool connect(const std::string& path) {
    close();
    if (path.empty() || path.size() >= sizeof(sockaddr_un::sun_path)) return false;
    fd_ = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd_ < 0) return false;
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::memcpy(addr.sun_path, path.c_str(), path.size() + 1);
    if (::connect(fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
      close();
      return false;
    }
    return true;
  }
  Reply call(const std::string& op, uint64_t session = 0, uint64_t seq = 0, int pulse = 0) {
    Reply r;
    if (fd_ < 0) return r;
    std::string frame = "1 " + op + " " + std::to_string(session) + " " + std::to_string(seq) +
                        " " + std::to_string(pulse);
    auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(100);
    if (!wait(POLLOUT, end) ||
        send(fd_, frame.data(), frame.size(), MSG_NOSIGNAL) != ssize_t(frame.size()) ||
        !wait(POLLIN, end)) {
      close();
      r.error = -ETIMEDOUT;
      return r;
    }
    char b[256];
    ssize_t n = recv(fd_, b, sizeof(b), MSG_TRUNC);
    if (n <= 0 || n >= ssize_t(sizeof(b))) {
      close();
      return r;
    }
    std::istringstream in(std::string(b, n));
    int version = 0, ok = 0;
    std::string extra;
    if (!(in >> version >> ok >> r.state >> r.applied >> r.session >> r.error) || version != 1 ||
        (ok != 0 && ok != 1) || (in >> extra)) {
      close();
      return Reply{};
    }
    r.ok = ok == 1;
    return r;
  }
  void close() {
    if (fd_ >= 0) ::close(fd_);
    fd_ = -1;
  }

private:
  bool wait(int16_t events, std::chrono::steady_clock::time_point end) {
    for (;;) {
      auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                    end - std::chrono::steady_clock::now())
                    .count();
      if (ms <= 0) return false;
      pollfd p{fd_, events, 0};
      int rc = poll(&p, 1, static_cast<int>(ms));
      if (rc < 0 && errno == EINTR) continue;
      return rc > 0 && (p.revents & events) && !(p.revents & (POLLERR | POLLHUP | POLLNVAL));
    }
  }
  int fd_{-1};
};
}  // namespace questix_pwm_guard
