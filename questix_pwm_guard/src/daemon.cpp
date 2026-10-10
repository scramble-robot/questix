// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/file.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <vector>

#include "questix_pwm_guard/core.hpp"
#include "questix_pwm_guard/protocol.hpp"
#include "questix_pwm_guard/sysfs.hpp"
namespace {
namespace q = questix_pwm_guard;
volatile sig_atomic_t exiting = 0;
void stop_handler(int) { exiting = 1; }
int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}
void notify(const std::string& message) {
  const char* path = std::getenv("NOTIFY_SOCKET");
  if (!path || !*path) return;
  sockaddr_un a{};
  a.sun_family = AF_UNIX;
  size_t n = std::strlen(path);
  if (n >= sizeof(a.sun_path)) return;
  std::memcpy(a.sun_path, path, n);
  if (path[0] == '@') a.sun_path[0] = 0;
  int fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
  if (fd < 0) return;
  sendto(fd, message.data(), message.size(), MSG_NOSIGNAL, reinterpret_cast<sockaddr*>(&a),
         socklen_t(offsetof(sockaddr_un, sun_path) + n + (path[0] == '@' ? 0 : 1)));
  close(fd);
}
uint64_t generation() {
  uint64_t n = 0;
  ssize_t rc;
  do {
    rc = getrandom(&n, sizeof(n), 0);
  } while (rc < 0 && errno == EINTR);
  if (rc != ssize_t(sizeof(n)) || n == 0) throw std::runtime_error("session generation failed");
  return n;
}
#ifdef QUESTIX_TEST_FAKE_IO
class Ledger : public q::Output {
public:
  explicit Ledger(const std::string& path) : f_(path, std::ios::app) {
    if (!f_) throw std::runtime_error("ledger open failed");
  }
  bool write_pulse(int us) override {
    f_ << now_ms() << " " << us << "\n";
    f_.flush();
    return static_cast<bool>(f_);
  }
  int error() const override { return -EIO; }

private:
  std::ofstream f_;
};
#endif
struct Peer {
  uid_t uid;
  bool owns{false};
};
int run(int argc, char** argv) {
  std::string socket_path = "/run/questix_pwm_guard/control.sock",
              lock_path = "/run/questix_pwm_guard/lock";
  std::string fake_log;
  uid_t allowed = uid_t(-1), admin = 0;
  gid_t socket_group = 0;
  bool recovery = false;
  q::HardwareConfig hc;
  for (int i = 1; i < argc; ++i) {
    std::string k = argv[i];
    if (k == "--recover-low") {
      recovery = true;
      continue;
    }
    if (i + 1 >= argc) throw std::runtime_error("missing option value");
    std::string v = argv[++i];
#ifdef QUESTIX_TEST_FAKE_IO
    if (k == "--fake-log") {
      fake_log = v;
      continue;
    }
    if (k == "--admin-uid") {
      if (!q::decimal(v, admin)) throw std::runtime_error("invalid admin uid");
      continue;
    }
#endif
    if (k == "--socket") {
      socket_path = v;
    } else if (k == "--lock") {
      lock_path = v;
    } else if (k == "--owner") {
      hc.owner_file = v;
    } else if (k == "--allowed-uid") {
      if (!q::decimal(v, allowed)) throw std::runtime_error("invalid uid");
    } else if (k == "--socket-gid") {
      if (!q::decimal(v, socket_group)) throw std::runtime_error("invalid gid");
    } else {
      throw std::runtime_error("unknown option: " + k);
    }
  }
  if (allowed == uid_t(-1) && !recovery) throw std::runtime_error("--allowed-uid required");
  int lock = open(lock_path.c_str(), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  struct stat st {};
  if (lock < 0 || fstat(lock, &st) < 0 || !S_ISREG(st.st_mode) || st.st_uid != geteuid() ||
      (st.st_mode & 0022) || flock(lock, LOCK_EX | LOCK_NB) < 0)
    throw std::runtime_error("exclusive lock unavailable");
  std::unique_ptr<q::Output> output;
#ifdef QUESTIX_TEST_FAKE_IO
  if (!fake_log.empty()) {
    output = std::make_unique<Ledger>(fake_log);
  }
#endif
  if (!output) {
    auto hw = std::make_unique<q::SysfsOutput>(hc);
    if (!hw->initialize(recovery))
      throw std::runtime_error("RP1 Low initialization failed: " + std::to_string(hw->error()));
    output = std::move(hw);
  }
  q::Core core(*output);
  if (!core.start()) throw std::runtime_error("Low request failed");
  if (recovery) {
    std::cout << "low_api_accepted; physical state unmeasured\n";
    return 0;
  }
  if (socket_path.size() >= sizeof(sockaddr_un::sun_path))
    throw std::runtime_error("socket path too long");
  if (lstat(socket_path.c_str(), &st) == 0) {
    if (!S_ISSOCK(st.st_mode) || st.st_uid != geteuid())
      throw std::runtime_error("unsafe stale socket");
    if (unlink(socket_path.c_str()) < 0) throw std::runtime_error("cannot clear stale socket");
  } else if (errno != ENOENT) {
    throw std::runtime_error("cannot inspect socket");
  }
  int server = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
  sockaddr_un a{};
  a.sun_family = AF_UNIX;
  std::memcpy(a.sun_path, socket_path.c_str(), socket_path.size() + 1);
  if (server < 0 || bind(server, reinterpret_cast<sockaddr*>(&a), sizeof(a)) < 0 ||
      chmod(socket_path.c_str(), 0660) < 0 ||
      chown(socket_path.c_str(), geteuid(), socket_group) < 0 || listen(server, 8) < 0)
    throw std::runtime_error("socket setup failed");
  struct sigaction sa {};
  sa.sa_handler = stop_handler;
  sigemptyset(&sa.sa_mask);
  sigaction(SIGTERM, &sa, nullptr);
  sigaction(SIGINT, &sa, nullptr);
  std::map<int, Peer> peers;
  int owner = -1;
  int64_t notified = now_ms();
  q::State last = core.state();
  notify("READY=1\nSTATUS=LOW_IDLE; API only, not physical confirmation");
  auto drop = [&](int fd) {
    if (fd == owner) {
      core.disconnected(now_ms());
      owner = -1;
    }
    close(fd);
    peers.erase(fd);
  };
  while (!exiting) {
    core.tick(now_ms());
    if (core.state() != last) {
      std::cout << "state=" << q::state_name(core.state()) << " applied_us=" << core.applied()
                << " fault=" << core.fault_error() << std::endl;
      last = core.state();
    }
    if (now_ms() - notified >= 250) {
      notify("WATCHDOG=1");
      notified = now_ms();
    }
    std::vector<pollfd> pf{{server, POLLIN, 0}};
    for (const auto& p : peers) pf.push_back({p.first, POLLIN, 0});
    int n = poll(pf.data(), pf.size(), 20);
    if (n < 0) {
      if (errno == EINTR) continue;
      throw std::runtime_error("poll failed");
    }
    core.tick(now_ms());  // Expiry wins over queued requests and ready sockets.
    if (pf[0].revents & POLLIN) {
      int fd = accept4(server, nullptr, nullptr, SOCK_CLOEXEC | SOCK_NONBLOCK);
      if (fd >= 0) {
        ucred c{};
        socklen_t size = sizeof(c);
        if (peers.size() >= 16 || getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &c, &size) < 0 ||
            (c.uid != allowed && c.uid != admin))
          close(fd);
        else
          peers.emplace(fd, Peer{c.uid, false});
      }
    }
    for (size_t i = 1; i < pf.size(); ++i) {
      int fd = pf[i].fd;
      if (!pf[i].revents) continue;
      if (pf[i].revents & POLLIN) {
        char b[256];
        auto len = recv(fd, b, sizeof(b), MSG_TRUNC);
        if (len <= 0 || len >= ssize_t(sizeof(b))) {
          drop(fd);
          continue;
        }
        q::Request r;
        bool ok = false;
        int error = -EPROTO;
        if (q::parse_request(std::string(b, len), r)) {
          auto& peer = peers.at(fd);
          auto t = now_ms();
          core.tick(t);
          if (r.op == "STATUS") {
            ok = true;
          } else if (r.op == "AUTHORIZE" && peer.uid == admin && owner < 0 && r.session == 0 &&
                     r.seq == 0 && r.pulse == 0) {
            ok = core.authorize(t);
          } else if (r.op == "LOW" && peer.uid == admin) {
            ok = core.emergency_low();
          } else if (r.op == "ARM" && peer.uid == allowed && owner < 0 && r.session == 0 &&
                     r.seq == 0 && r.pulse == 0) {
            ok = core.arm(generation(), t);
            if (ok) {
              owner = fd;
              peer.owns = true;
            }
          } else if (peer.owns && fd == owner) {
            if (r.op == "COMPLETE")
              ok = core.complete(r.session, r.seq, t);
            else if (r.op == "COMMAND")
              ok = core.command(r.session, r.seq, r.pulse, t);
            else if (r.op == "SHUTDOWN")
              ok = core.shutdown(r.session, r.seq, t);
            else if (r.op == "STOP")
              ok = core.stop(r.session, r.seq, t);
          }
          error = ok ? 0 : (core.error() ? core.error() : -EPERM);
        }
        std::string reply = "1 " + std::to_string(ok ? 1 : 0) + " " + q::state_name(core.state()) +
                            " " + std::to_string(core.applied()) + " " +
                            std::to_string(core.session()) + " " + std::to_string(error);
        if (send(fd, reply.data(), reply.size(), MSG_NOSIGNAL) != ssize_t(reply.size())) {
          drop(fd);
          continue;
        }
      }
      if (pf[i].revents & (POLLHUP | POLLERR | POLLNVAL)) {
        if (peers.count(fd)) drop(fd);
      }
    }
  }
  bool stopped = core.emergency_low();
  for (auto& p : peers) close(p.first);
  close(server);
  unlink(socket_path.c_str());
  close(lock);
  return stopped ? 0 : 2;
}
}  // namespace
int main(int argc, char** argv) {
  try {
    return run(argc, argv);
  } catch (const std::exception& e) {
    std::cerr << "guard failure: " << e.what()
              << "; output unknown, independent power cut required\n";
    return 2;
  }
}
