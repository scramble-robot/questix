// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// The real ShotComponent node on a fake servo bus (issue #175). A pseudo terminal stands in for
// /dev/servo and a fake Feetech servo on its other end answers Modbus reads and writes only while
// it is "powered" (RLY1 closed). The test plays operation_manager (/emergency_stop at 10 Hz) and
// spins the node on one single-threaded executor, as shot_component_node does.
//
// What this pins down:
// * releasing the E-stop while the servo does not answer yet never blocks the node's executor
//   for long: every spin returns within a short bound, so /emergency_stop keeps being processed
//   and the node's own reception timeout does not fire (it used to block about 2 s: a 500 ms
//   sleep plus a 1.5 s read inside the release callback);
// * once the servo answers, the node reaches ACTIVE without a new release;
// * pressing the E-stop during startup stops the probing, and the node does not activate while
//   the E-stop is pressed even if the servo answers;
// * after the startup window the node falls back to the slow retry period.
#include <fcntl.h>
#include <gtest/gtest.h>
#include <pty.h>
#include <termios.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <lifecycle_msgs/msg/state.hpp>
#include <memory>
#include <questix_msgs/msg/emergency_stop.hpp>
#include <rclcpp/rclcpp.hpp>
#include <string>
#include <thread>
#include <vector>

#include "motor_control_app/shot_component.hpp"
#include "motor_control_lib/feetech_protocol.hpp"

using namespace std::chrono_literals;

namespace {

constexpr uint16_t kPosition = 2048;

// The servo side of the bus: answers Modbus read (0x03) and write (0x06) requests while powered.
class FakeServoBus {
public:
  FakeServoBus() {
    char name[256] = {};
    if (openpty(&master_, &slave_, name, nullptr, nullptr) != 0) {
      return;
    }
    path_ = name;
    termios tio{};
    tcgetattr(slave_, &tio);
    cfmakeraw(&tio);
    tcsetattr(slave_, TCSANOW, &tio);
    fcntl(master_, F_SETFL, fcntl(master_, F_GETFL) | O_NONBLOCK);
    running_ = true;
    reader_ = std::thread([this]() { run(); });
  }

  ~FakeServoBus() {
    running_ = false;
    if (reader_.joinable()) {
      reader_.join();
    }
    if (slave_ >= 0) close(slave_);
    if (master_ >= 0) close(master_);
  }

  const std::string& path() const { return path_; }
  void setPowered(bool powered) { powered_ = powered; }
  int requests() const { return requests_.load(); }

private:
  void run() {
    std::vector<uint8_t> pending;
    uint8_t buf[256];
    while (running_) {
      const ssize_t n = read(master_, buf, sizeof(buf));
      if (n > 0) {
        pending.insert(pending.end(), buf, buf + n);
        while (pending.size() >= 8) {
          const std::vector<uint8_t> request(pending.begin(), pending.begin() + 8);
          pending.erase(pending.begin(), pending.begin() + 8);
          ++requests_;
          if (powered_) {
            answer(request);
          }
        }
      } else {
        std::this_thread::sleep_for(1ms);
      }
    }
  }

  void answer(const std::vector<uint8_t>& request) {
    std::vector<uint8_t> response;
    if (request[1] == 3) {  // read: [id][03][02][valH][valL][crcL][crcH]
      response = {request[0], 3, 2, static_cast<uint8_t>(kPosition >> 8),
                  static_cast<uint8_t>(kPosition & 0xFF)};
    } else {  // write: echo [id][06][addrH][addrL][valH][valL][crcL][crcH]
      response.assign(request.begin(), request.begin() + 6);
    }
    const uint16_t crc =
        motor_control_lib::feetech_protocol::calculateCrc16(response.data(), response.size());
    response.push_back(static_cast<uint8_t>(crc & 0xFF));  // CRC little endian (Modbus-RTU)
    response.push_back(static_cast<uint8_t>(crc >> 8));
    const ssize_t written = write(master_, response.data(), response.size());
    (void)written;
  }

  int master_{-1};
  int slave_{-1};
  std::string path_;
  std::atomic<bool> running_{false};
  std::atomic<bool> powered_{false};
  std::atomic<int> requests_{0};
  std::thread reader_;
};

class ShotComponentNode : public ::testing::Test {
protected:
  static void SetUpTestSuite() {
    if (!rclcpp::ok()) {
      rclcpp::init(0, nullptr);
    }
  }

  static void TearDownTestSuite() { rclcpp::shutdown(); }

  void TearDown() override {
    if (executor_) {
      executor_->cancel();
    }
    shot_.reset();
    helper_.reset();
    executor_.reset();
  }

  void start(double startup_window_sec) {
    ASSERT_FALSE(bus_.path().empty()) << "openpty failed";
    static int counter = 0;
    prefix_ = "/shot_node_test_" + std::to_string(getpid()) + "_" + std::to_string(counter++);
    rclcpp::NodeOptions options;
    options.parameter_overrides({
        {"port", bus_.path()},
        {"baudrate", 115200},
        {"tilt_servo_id", 11},
        {"trigger_servo_id", 10},
        {"joy_topic", prefix_ + "/joy"},
        {"auto_start", true},
        {"connect_retry_period_sec", 3.0},
        {"startup_retry_period_sec", 0.1},
        {"startup_window_sec", startup_window_sec},
        {"servo_response_timeout_ms", 50},
        {"emergency_stop_topic", prefix_ + "/emergency_stop"},
        {"emergency_stop_timeout_sec", 1.0},
        {"require_emergency_stop", true},
        {"teacher_permission_topic", prefix_ + "/actuation_authority"},
    });
    shot_ = std::make_shared<motor_control_app::ShotComponent>(options);
    helper_ = std::make_shared<rclcpp::Node>("shot_node_test_helper_" + std::to_string(getpid()) +
                                             "_" + std::to_string(counter));
    estop_pub_ = helper_->create_publisher<questix_msgs::msg::EmergencyStop>(
        prefix_ + "/emergency_stop", rclcpp::QoS(1).reliable().transient_local());
    executor_ = std::make_unique<rclcpp::executors::SingleThreadedExecutor>();
    executor_->add_node(shot_->get_node_base_interface());
    executor_->add_node(helper_);
  }

  uint8_t state() const { return shot_->get_current_state().id(); }
  bool isActive() const { return state() == lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE; }

  // Spins while publishing /emergency_stop every 100 ms (operation_manager), until pred or timeout.
  // Records the longest single spin: a callback that blocks the executor shows up here.
  bool spinUntil(const std::function<bool()>& pred, std::chrono::milliseconds timeout) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    auto next_estop = std::chrono::steady_clock::now();
    while (std::chrono::steady_clock::now() < deadline) {
      if (std::chrono::steady_clock::now() >= next_estop) {
        next_estop += 100ms;
        questix_msgs::msg::EmergencyStop msg;
        msg.header.stamp = helper_->now();
        msg.active = estop_active_;
        msg.source = "operation_manager";
        msg.reason = estop_active_ ? "pin 5 is true, expected false; " : "released";
        estop_pub_->publish(msg);
      }
      const auto spin_start = std::chrono::steady_clock::now();
      executor_->spin_some(10ms);
      longest_spin_ = std::max(longest_spin_, std::chrono::steady_clock::now() - spin_start);
      if (pred()) {
        return true;
      }
    }
    return pred();
  }

  void spinFor(std::chrono::milliseconds duration) {
    spinUntil([]() { return false; }, duration);
  }

  double longestSpinMs() const {
    return std::chrono::duration<double, std::milli>(longest_spin_).count();
  }

  FakeServoBus bus_;
  std::string prefix_;
  std::shared_ptr<motor_control_app::ShotComponent> shot_;
  std::shared_ptr<rclcpp::Node> helper_;
  std::unique_ptr<rclcpp::executors::SingleThreadedExecutor> executor_;
  rclcpp::Publisher<questix_msgs::msg::EmergencyStop>::SharedPtr estop_pub_;
  bool estop_active_{true};
  std::chrono::steady_clock::duration longest_spin_{};
};

// One startup step waits at most servo_response_timeout_ms (50 ms) plus the fixed RS485 waits;
// 400 ms leaves room for a loaded CI runner and is far below the 1 s reception timeout (and the
// about 2 s the release callback used to block).
constexpr double kMaxSpinMs = 400.0;

TEST_F(ShotComponentNode, ReleaseWithAnUnpoweredServoNeverBlocksAndStartsOncePowered) {
  start(5.0);
  spinFor(500ms);  // pressed: waits without probing
  EXPECT_EQ(state(), lifecycle_msgs::msg::State::PRIMARY_STATE_UNCONFIGURED);
  EXPECT_EQ(bus_.requests(), 0);

  estop_active_ = false;  // released; the servo is still booting (no answer)
  longest_spin_ = {};
  spinFor(1500ms);
  EXPECT_FALSE(isActive());
  EXPECT_GE(bus_.requests(), 3) << "the startup window probes on a short period";
  EXPECT_LT(longestSpinMs(), kMaxSpinMs);

  bus_.setPowered(true);  // the servo answers now; no new release is needed
  ASSERT_TRUE(spinUntil([this]() { return isActive(); }, 2s));
  EXPECT_LT(longestSpinMs(), kMaxSpinMs);
}

TEST_F(ShotComponentNode, PressDuringStartupStopsProbingAndHoldsEvenIfTheServoAnswers) {
  start(5.0);
  spinFor(300ms);
  estop_active_ = false;
  spinFor(500ms);  // probing an unpowered servo
  ASSERT_GE(bus_.requests(), 1);

  estop_active_ = true;  // pressed during startup
  spinFor(300ms);
  const int after_press = bus_.requests();
  bus_.setPowered(true);
  spinFor(1000ms);
  EXPECT_FALSE(isActive()) << "must not activate while the E-stop is pressed";
  EXPECT_EQ(bus_.requests(), after_press) << "no probing while the E-stop is pressed";

  estop_active_ = false;
  ASSERT_TRUE(spinUntil([this]() { return isActive(); }, 2s));
}

TEST_F(ShotComponentNode, AfterTheStartupWindowItFallsBackToTheSlowRetry) {
  start(0.6);
  spinFor(200ms);
  estop_active_ = false;
  spinFor(1000ms);  // the 0.6 s window ends while the servo stays silent
  const int after_window = bus_.requests();
  ASSERT_GE(after_window, 2);
  spinFor(1000ms);  // slow retry (3 s): at most one more probe in this second
  EXPECT_LE(bus_.requests() - after_window, 1);
  EXPECT_FALSE(isActive());

  bus_.setPowered(true);  // the slow retry picks it up (3 s period + one activation step)
  ASSERT_TRUE(spinUntil([this]() { return isActive(); }, 5s));
  EXPECT_LT(longestSpinMs(), kMaxSpinMs);
}

}  // namespace
