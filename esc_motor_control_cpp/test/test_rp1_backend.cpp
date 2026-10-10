// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <thread>
#include <vector>

#include "esc_motor_control_cpp/pwm_backend.hpp"
#include "esc_motor_control_cpp/pwm_command.hpp"
#include "questix_pwm_guard/core.hpp"
#include "questix_pwm_guard/protocol.hpp"
// Test-only peer credentials for the unprivileged fakeguard; never linked into product ELFs.
extern "C" int __real_getsockopt(int, int, int, void*, socklen_t*);
extern "C" int __wrap_getsockopt(int fd, int level, int option, void* value, socklen_t* size) {
  const int result = __real_getsockopt(fd, level, option, value, size);
  if (result == 0 && level == SOL_SOCKET && option == SO_PEERCRED)
    static_cast<ucred*>(value)->uid = 0;
  return result;
}
namespace {
namespace q = questix_pwm_guard;
class FakeOutput : public q::Output {
public:
  bool write_pulse(int us) override {
    last = us;
    return true;
  }
  int error() const override { return -EIO; }
  std::atomic<int> last{0};
};
class BackendTest : public testing::Test {
protected:
  void SetUp() override {
    char path[] = "/tmp/questix-backend-XXXXXX";
    dir = mkdtemp(path);
    socket_path = dir + "/socket";
    server = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    ASSERT_GE(server, 0);
    sockaddr_un a{};
    a.sun_family = AF_UNIX;
    ASSERT_LT(socket_path.size(), sizeof(a.sun_path));
    std::memcpy(a.sun_path, socket_path.c_str(), socket_path.size() + 1);
    ASSERT_EQ(bind(server, reinterpret_cast<sockaddr*>(&a), sizeof(a)), 0);
    ASSERT_EQ(listen(server, 1), 0);
    thread = std::thread([this] { serve(); });
  }
  void TearDown() override {
    done = true;
    if (thread.joinable()) thread.join();
    close(server);
    std::filesystem::remove_all(dir);
  }
  void serve() {
    q::Core core(output);
    core.start();
    core.authorize(0);
    auto epoch = std::chrono::steady_clock::now();
    auto now = [&] {
      return std::chrono::duration_cast<std::chrono::milliseconds>(
                 std::chrono::steady_clock::now() - epoch)
          .count();
    };
    int fd = -1;
    while (!done) {
      core.tick(now());
      pollfd p{fd < 0 ? server : fd, POLLIN, 0};
      if (poll(&p, 1, 10) <= 0) continue;
      if (fd < 0) {
        fd = accept(server, nullptr, nullptr);
        continue;
      }
      char b[256];
      ssize_t n = recv(fd, b, sizeof(b), MSG_DONTWAIT);
      if (n <= 0) {
        close(fd);
        fd = -1;
        continue;
      }
      if (silent) continue;
      std::this_thread::sleep_for(std::chrono::milliseconds(delay_ms.load()));
      q::Request r;
      bool ok = false;
      if (q::parse_request(std::string(b, n), r)) {
        if (r.op == "ARM")
          ok = core.arm(42, now());
        else if (r.op == "COMPLETE")
          ok = core.complete(r.session, r.seq, now());
        else if (r.op == "COMMAND")
          ok = core.command(r.session, r.seq, r.pulse, now());
        else if (r.op == "STOP")
          ok = core.stop(r.session, r.seq, now());
        else if (r.op == "SHUTDOWN")
          ok = core.shutdown(r.session, r.seq, now());
        else if (r.op == "STATUS")
          ok = true;
      }
      auto reply = std::string("1 ") + (ok ? "1 " : "0 ") +
                   (drain_forever ? "DRAINING" : q::state_name(core.state())) + " " +
                   std::to_string(drain_forever ? 1000 : core.applied()) + " " +
                   std::to_string(core.session()) + " " + std::to_string(ok ? 0 : core.error());
      send(fd, reply.data(), reply.size(), MSG_NOSIGNAL);
    }
    if (fd >= 0) close(fd);
  }
  std::string dir, socket_path;
  int server{-1};
  std::thread thread;
  std::atomic<bool> done{false}, silent{false};
  std::atomic<int> delay_ms{0};
  std::atomic<bool> drain_forever{false};
  FakeOutput output;
};
TEST_F(BackendTest, LifecycleDrainsThenRejectsNeutralAndHoldsLow) {
  esc_motor_control_cpp::Rp1HardwareBackend b(socket_path);
  ASSERT_TRUE(b.initialize(13));
  ASSERT_TRUE(b.complete_arm());
  ASSERT_TRUE(b.set_servo_pulse(13, 1800));
  auto begin = std::chrono::steady_clock::now();
  ASSERT_TRUE(b.graceful_shutdown());
  EXPECT_GE(std::chrono::steady_clock::now() - begin, std::chrono::milliseconds(480));
  EXPECT_TRUE(b.terminal());
  EXPECT_FALSE(b.set_servo_pulse(13, 1000));
  EXPECT_EQ(output.last, 0);
  b.cleanup();
  EXPECT_EQ(output.last, 0);
}
TEST_F(BackendTest, InvalidPinNeverArms) {
  esc_motor_control_cpp::Rp1HardwareBackend b(socket_path);
  EXPECT_FALSE(b.initialize(12));
  EXPECT_EQ(output.last, 0);
}
TEST_F(BackendTest, RequestTimeoutIsBoundedAndLatchesTerminal) {
  esc_motor_control_cpp::Rp1HardwareBackend b(socket_path);
  ASSERT_TRUE(b.initialize(13));
  silent = true;
  auto begin = std::chrono::steady_clock::now();
  EXPECT_FALSE(b.complete_arm());
  EXPECT_LT(std::chrono::steady_clock::now() - begin, std::chrono::milliseconds(250));
  EXPECT_TRUE(b.terminal());
  EXPECT_FALSE(b.set_servo_pulse(13, 1800));
}
TEST_F(BackendTest, NoFallbackAndTerminalCommandPolicy) {
  std::string actual;
  auto b = esc_motor_control_cpp::make_pwm_backend("rp1_hw", 4, actual, socket_path);
  ASSERT_EQ(actual, "rp1_hw");
  ASSERT_TRUE(b->initialize(13));
  ASSERT_TRUE(b->complete_arm());
  esc_motor_control_cpp::PwmCommand command;
  auto changed = [](int, int, double) {};
  auto error = [](int) {};
  ASSERT_TRUE(command.send(*b, 13, 1800, .8, changed, error));
  ASSERT_TRUE(b->stop_signal(13));
  EXPECT_FALSE(command.send(*b, 13, 1000, 0, changed, error));
  EXPECT_TRUE(command.fault());
  EXPECT_EQ(output.last, 0);
}
TEST_F(BackendTest, ShutdownBudgetIncludesFirstAndFinalRpc) {
  esc_motor_control_cpp::Rp1HardwareBackend b(socket_path);
  ASSERT_TRUE(b.initialize(13));
  ASSERT_TRUE(b.complete_arm());
  delay_ms = 80;
  drain_forever = true;
  auto begin = std::chrono::steady_clock::now();
  EXPECT_FALSE(b.graceful_shutdown());
  const auto elapsed = std::chrono::steady_clock::now() - begin;
  EXPECT_GE(elapsed, std::chrono::milliseconds(780));
  EXPECT_LT(elapsed, std::chrono::milliseconds(850));
  EXPECT_TRUE(b.terminal());
  EXPECT_FALSE(b.set_servo_pulse(13, 1000));
}
}  // namespace
