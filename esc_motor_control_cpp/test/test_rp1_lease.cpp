// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>
#include <sys/syscall.h>

#include <atomic>
#include <cstring>
#include <filesystem>
#include <thread>

#include "esc_motor_control_cpp/esc_motor_control_component.hpp"
#include "questix_pwm_guard/core.hpp"
#include "questix_pwm_guard/protocol.hpp"

namespace esc_motor_control_cpp {
class LeaseOutput : public PwmBackend {
public:
  bool initialize(int) override { return true; }
  bool set_servo_pulse(int, int us) override {
    applied = us;
    return true;
  }
  bool stop_signal(int) override { return true; }
  int last_error() const override { return 0; }
  void cleanup() override {}
  std::string name() const override { return "rp1_hw"; }
  int applied{-1};
};
// Access only from this uninstalled test; no runtime override in production.
struct EscLeaseTestAccess {
  static void stale_lab(EscMotorControlComponent& node, std::unique_ptr<LeaseOutput> output) {
    node.pwm_ = std::move(output);
    node.pwm_backend_name_ = "rp1_hw";
    auto decision = node.roller_lab_logic_.onLab(0.6, node.steady_now_sec() - 2.0, false, false);
    ASSERT_TRUE(decision.apply);
    node.current_speed_ = decision.command;
  }
  static void renew(EscMotorControlComponent& node) { node.renew_pwm_lease(); }
  static void attach(EscMotorControlComponent& node, const std::string& socket) {
    auto backend = std::make_unique<Rp1HardwareBackend>(socket);
    ASSERT_TRUE(backend->initialize(13));
    ASSERT_TRUE(backend->complete_arm());
    node.pwm_ = std::move(backend);
    node.pwm_backend_name_ = "rp1_hw";
    ASSERT_TRUE(node.send_pulse(1800, 0.8));
  }
  static bool fault(EscMotorControlComponent& node) { return node.pwm_command_.fault(); }
  static void report(EscMotorControlComponent& node) { node.publish_roller_status(); }
  static void gate(EscMotorControlComponent& node) { node.apply_gate(); }
};
TEST(Rp1Lease, RenewalExpiresLabWithoutRunningSeparateLabTimer) {
  rclcpp::init(0, nullptr, rclcpp::InitOptions(), rclcpp::SignalHandlerOptions::None);
  {
    rclcpp::NodeOptions options;
    options.append_parameter_override("test_mode", true);
    options.append_parameter_override("require_emergency_stop", false);
    options.append_parameter_override("accept_lab_input", true);
    EscMotorControlComponent node(options);
    auto output = std::make_unique<LeaseOutput>();
    auto* observed = output.get();
    EscLeaseTestAccess::stale_lab(node, std::move(output));
    // No executor spin: the unrelated lab timer cannot hide the renewal defect.
    EscLeaseTestAccess::renew(node);
    EXPECT_EQ(observed->applied, 1000);
  }
  rclcpp::shutdown();
}
}  // namespace esc_motor_control_cpp

// Test executable only: shared component's real adapter accepts this unprivileged fakeguard.
extern "C" int getsockopt(int fd, int level, int option, void* value, socklen_t* size) {
  const int rc = static_cast<int>(syscall(SYS_getsockopt, fd, level, option, value, size));
  if (rc == 0 && level == SOL_SOCKET && option == SO_PEERCRED) static_cast<ucred*>(value)->uid = 0;
  return rc;
}
namespace esc_motor_control_cpp {
class GuardOutput : public questix_pwm_guard::Output {
public:
  bool write_pulse(int us) override {
    applied = us;
    return true;
  }
  int error() const override { return -EIO; }
  std::atomic<int> applied{0};
};
class FakeGuard {
public:
  FakeGuard() {
    char tmp[] = "/tmp/questix-component-XXXXXX";
    directory = mkdtemp(tmp);
    path = directory + "/socket";
    server = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, path.c_str(), path.size() + 1);
    if (bind(server, reinterpret_cast<sockaddr*>(&address), sizeof(address)) || listen(server, 1))
      throw std::runtime_error("fakeguard socket failed");
    worker = std::thread([this] { serve(); });
  }
  ~FakeGuard() {
    done = true;
    worker.join();
    close(server);
    std::filesystem::remove_all(directory);  // Only private test fixture.
  }
  void serve() {
    namespace q = questix_pwm_guard;
    q::Core core(output);
    core.start();
    const auto start = std::chrono::steady_clock::now();
    auto now = [&] {
      return std::chrono::duration_cast<std::chrono::milliseconds>(
                 std::chrono::steady_clock::now() - start)
          .count();
    };
    int fd = -1;
    while (!done) {
      core.tick(now());
      pollfd p{fd < 0 ? server : fd, POLLIN, 0};
      if (poll(&p, 1, 5) <= 0) continue;
      if (fd < 0) {
        fd = accept(server, nullptr, nullptr);
        continue;
      }
      char buffer[256];
      auto n = recv(fd, buffer, sizeof(buffer), MSG_DONTWAIT);
      if (n <= 0) {
        core.disconnected(now());
        close(fd);
        fd = -1;
        continue;
      }
      q::Request request;
      bool ok = false;
      if (q::parse_request(std::string(buffer, size_t(n)), request)) {
        if (request.op == "ARM") ok = core.arm(42, now());
        if (request.op == "COMPLETE") ok = core.complete(42, request.seq, now());
        if (request.op == "COMMAND") ok = core.command(42, request.seq, request.pulse, now());
        if (request.op == "STOP") ok = core.stop(42, request.seq, now());
        if (request.op == "REPORT") ok = request.session == core.session();
      }
      auto reply = std::string("1 ") + (ok ? "1 " : "0 ") + q::state_name(core.state()) + " " +
                   std::to_string(core.applied()) + " " + std::to_string(core.session()) + " " +
                   std::to_string(core.fault_error() ? core.fault_error() : core.error());
      send(fd, reply.data(), reply.size(), MSG_NOSIGNAL);
      requests++;
    }
    if (fd >= 0) close(fd);
  }
  std::string directory, path;
  GuardOutput output;
  std::atomic<int> requests{0};

private:
  int server{-1};
  std::atomic<bool> done{false};
  std::thread worker;
};
}  // namespace esc_motor_control_cpp

namespace esc_motor_control_cpp {
TEST(Rp1Lease, ExecutorSilenceGuardFaultIsPublishedAndGateDoesNotRepeatStop) {
  rclcpp::init(0, nullptr, rclcpp::InitOptions(), rclcpp::SignalHandlerOptions::None);
  {
    FakeGuard guard;
    rclcpp::NodeOptions options;
    options.append_parameter_override("test_mode", true);
    options.append_parameter_override("require_emergency_stop", false);
    auto node = std::make_shared<EscMotorControlComponent>(options);
    auto observer = std::make_shared<rclcpp::Node>("roller_status_test");
    std::string report;
    auto subscription = observer->create_subscription<std_msgs::msg::String>(
        "/roller/status", 10, [&](const std_msgs::msg::String& msg) { report = msg.data; });
    EscLeaseTestAccess::attach(*node, guard.path);
    std::this_thread::sleep_for(std::chrono::milliseconds(650));  // No executor renewals.
    EXPECT_EQ(guard.output.applied, 0);
    EscLeaseTestAccess::renew(*node);
    EXPECT_TRUE(EscLeaseTestAccess::fault(*node));
    const auto calls = guard.requests.load();
    for (int i = 0; i < 10; ++i) EscLeaseTestAccess::gate(*node);
    EXPECT_EQ(guard.requests.load(), calls);
    rclcpp::executors::SingleThreadedExecutor executor;
    executor.add_node(node);
    executor.add_node(observer);
    const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (std::chrono::steady_clock::now() < until &&
           report.find("FAULT_LOW") == std::string::npos) {
      EscLeaseTestAccess::report(*node);
      executor.spin_some();
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    EXPECT_NE(report.find("FAULT_LOW"), std::string::npos);
    EXPECT_NE(report.find("\"pwm_fault\": true"), std::string::npos);
    EXPECT_NE(report.find("\"applied_pulse_us\": 0"), std::string::npos);
    node->begin_shutdown();
  }
  rclcpp::shutdown();
}
}  // namespace esc_motor_control_cpp
