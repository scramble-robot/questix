// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// The real DriveComponent node, end to end: /target_twist in, DDT frames out. A pseudo terminal
// stands in for the motor's /dev/ttyACM0 and a fake motor on its other end records every command
// frame and answers it like a M0602C (echoing the commanded speed, fault 0). The node is loaded
// with the integrated hardware YAML (launcher/config/drive_component.yaml) and the DualShock
// operator profile, as questix_core does. The test plays operation_manager: /emergency_stop at
// 10 Hz ("released (no GPIO safety path)" for a manual diagnostic run without the GPIO safety
// path) and /motion_permission at 20 Hz (MotionPermissionManager).
//
// What this pins down:
// * a practice robot (released E-stop, allowed permission) drives on /target_twist; it stops when
//   /emergency_stop goes silent (operation_manager gone) and when a pressed E-stop is received;
// * an unheard E-stop keeps the drive stopped until a release is heard;
// * the motion permission (L2) gates the drive on its own: unheard, silent or "not allowed" (the
//   referee, the teacher) stops it, it is never reported as an emergency stop, and it coming back
//   does not restart the drive by itself.
#include <fcntl.h>
#include <gtest/gtest.h>
#include <pty.h>
#include <termios.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <functional>
#include <geometry_msgs/msg/twist.hpp>
#include <iomanip>
#include <lifecycle_msgs/msg/state.hpp>
#include <memory>
#include <mutex>
#include <nav_msgs/msg/odometry.hpp>
#include <questix_msgs/msg/drive_control_sample.hpp>
#include <questix_msgs/msg/drive_status.hpp>
#include <questix_msgs/msg/emergency_stop.hpp>
#include <questix_msgs/msg/motion_permission.hpp>
#include <rcl_interfaces/msg/log.hpp>
#include <rclcpp/rclcpp.hpp>
#include <string>
#include <thread>
#include <vector>

#include "motor_control_app/drive_component.hpp"
#include "motor_control_lib/ddt_protocol.hpp"

using namespace std::chrono_literals;

namespace motor_control_app {
struct DriveRearmNodeAccess {
  static void failedStop(DriveComponent& node) {
    node.resetCommandState();
    node.stop_fault_ = true;  // inject failure state; actual zero retry still uses the PTY
  }
};
}  // namespace motor_control_app

namespace {

namespace ddt = motor_control_lib::ddt_protocol;

constexpr uint8_t kLeftId = 4;  // launcher/config/drive_component.yaml
constexpr uint8_t kRightId = 5;
constexpr uint8_t kCommand = 0x64;  // Protocol 1 (velocity / current command)

int16_t commandValue(const std::vector<uint8_t>& frame) {
  return static_cast<int16_t>((static_cast<uint16_t>(frame[2]) << 8) | frame[3]);  // big-endian
}

// The motor side of the serial line: reads every frame the node writes and answers commands.
class FakeMotor {
public:
  void setMode(uint8_t mode) { mode_ = mode; }
  void setFault(uint8_t fault) { fault_ = fault; }
  FakeMotor() {
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

  ~FakeMotor() {
    running_ = false;
    if (reader_.joinable()) {
      reader_.join();
    }
    if (slave_ >= 0) close(slave_);
    if (master_ >= 0) close(master_);
  }

  const std::string& path() const { return path_; }

  void positions(uint16_t left, uint16_t right) {
    left_position_ = left;
    right_position_ = right;
  }
  void answerLeft(bool enabled) { answer_left_ = enabled; }
  void answerRight(bool enabled) { answer_right_ = enabled; }
  void answerBoth(bool enabled) {
    answer_left_ = enabled;
    answer_right_ = enabled;
  }
  void fault(uint8_t code) { fault_ = code; }

  // Close only the fake PTY peer: subsequent writes fail, like a lost serial line.
  void disconnect() {
    running_ = false;
    if (reader_.joinable()) reader_.join();
    if (master_ >= 0) close(master_);
    master_ = -1;
  }

  // Command frames (0x64) received so far, oldest first.
  std::vector<std::vector<uint8_t>> commands() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return commands_;
  }

  void clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    commands_.clear();
  }

  // A nonzero command reached this wheel since the last clear().
  bool drove(uint8_t motor_id) const {
    for (const auto& frame : commands()) {
      if (frame[0] == motor_id && commandValue(frame) != 0) {
        return true;
      }
    }
    return false;
  }

  // The newest command to this wheel is a zero (stop) frame.
  bool lastCommandIsZero(uint8_t motor_id) const {
    const auto frames = commands();
    for (auto it = frames.rbegin(); it != frames.rend(); ++it) {
      if ((*it)[0] == motor_id) {
        return ddt::isZeroCommandFrame(*it);
      }
    }
    return false;
  }

private:
  void run() {
    std::vector<uint8_t> pending;
    uint8_t buf[256];
    while (running_) {
      const ssize_t n = read(master_, buf, sizeof(buf));
      if (n > 0) {
        pending.insert(pending.end(), buf, buf + n);
        consume(pending);
      } else {
        std::this_thread::sleep_for(1ms);
      }
    }
  }

  // Frames are 10 bytes with CRC8 over the first 9; resynchronize on the CRC so that a lost
  // byte can never shift every later frame.
  void consume(std::vector<uint8_t>& pending) {
    size_t pos = 0;
    while (pending.size() - pos >= 10) {
      std::vector<uint8_t> frame(pending.begin() + pos, pending.begin() + pos + 10);
      const std::vector<uint8_t> payload(frame.begin(), frame.begin() + 9);
      if (ddt::crc8Maxim(payload) != frame[9] || (frame[0] != kLeftId && frame[0] != kRightId)) {
        ++pos;
        continue;
      }
      pos += 10;
      if (frame[1] != kCommand) {
        continue;  // mode switch etc.
      }
      {
        std::lock_guard<std::mutex> lock(mutex_);
        commands_.push_back(frame);
      }
      reply(frame[0], commandValue(frame));
    }
    pending.erase(pending.begin(), pending.begin() + pos);
  }

  // A M0602C feedback frame: {ID, mode, current(2), speed(2), position(2), fault, CRC8}.
  void reply(uint8_t motor_id, int16_t speed_rpm) {
    if ((motor_id == kLeftId && !answer_left_) || (motor_id == kRightId && !answer_right_)) return;
    const uint16_t position = motor_id == kLeftId ? left_position_.load() : right_position_.load();
    std::vector<uint8_t> frame = {motor_id,
                                  mode_.load(),
                                  0x00,
                                  0x00,
                                  static_cast<uint8_t>(mode_ == 1 ? 0 : (speed_rpm >> 8) & 0xFF),
                                  static_cast<uint8_t>(mode_ == 1 ? 0 : speed_rpm & 0xFF),
                                  static_cast<uint8_t>((position >> 8) & 0xFF),
                                  static_cast<uint8_t>(position & 0xFF),
                                  fault_.load()};
    frame.push_back(ddt::crc8Maxim(frame));
    const ssize_t written = write(master_, frame.data(), frame.size());
    (void)written;
  }

  int master_{-1};
  std::atomic<uint8_t> mode_{2};
  std::atomic<uint8_t> fault_{0};
  int slave_{-1};
  std::string path_;
  std::atomic<bool> running_{false};
  std::thread reader_;
  mutable std::mutex mutex_;
  std::vector<std::vector<uint8_t>> commands_;
  std::atomic<uint16_t> left_position_{0};
  std::atomic<uint16_t> right_position_{0};
  std::atomic<bool> answer_left_{true};
  std::atomic<bool> answer_right_{true};
};

// operation_manager's /emergency_stop reason without the GPIO safety path.
constexpr char kNoGpioReason[] = "released (no GPIO safety path)";

class DriveComponentNode : public ::testing::Test {
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
    drive_.reset();
    helper_.reset();
    executor_.reset();
    std::remove(overrides_path_.c_str());
  }

  // Starts the node as questix_core would (hardware YAML, operator profile), on this test's own
  // topics and the fake motor's serial line. The E-stop and permission requirements come from
  // the integrated YAML (never overridden here).
  void start(const std::string& mode = "velocity", double linear_band = 0.0,
             bool expect_active = true, bool missing_motor = false) {
    motor_.setMode(mode == "current" ? 1 : 2);
    ASSERT_FALSE(motor_.path().empty()) << "openpty failed";
    static int counter = 0;
    prefix_ = "/drive_node_test_" + std::to_string(getpid()) + "_" + std::to_string(counter++);
    overrides_path_ = "/tmp" + prefix_ + ".yaml";
    {
      std::ofstream out(overrides_path_);
      out << "drive_component:\n  ros__parameters:\n"
          << "    serial_port: \"" << (missing_motor ? overrides_path_ + ".absent" : motor_.path())
          << "\"\n"
          << "    connect_retry_period_sec: 0.5\n"
          << "    control_mode: " << mode << "\n"
          << "    rearm_neutral_linear: " << std::showpoint << linear_band << "\n"
          << "    publish_tf: false\n"
          << "    odom_topic: \"" << prefix_ << "/odom\"\n"
          << "    typed_status_topic: \"" << prefix_ << "/drive_status\"\n"
          << "    emergency_stop_topic: \"" << prefix_ << "/emergency_stop\"\n"
          << "    motion_permission_topic: \"" << prefix_ << "/motion_permission\"\n";
    }
    rclcpp::NodeOptions options;
    // Later files win: hardware YAML, operator profile, then this test's overrides.
    options.arguments({"--ros-args", "--params-file", QUESTIX_DRIVE_HARDWARE_YAML, "--params-file",
                       QUESTIX_DRIVE_CONTROL_YAML, "--params-file", overrides_path_, "-r",
                       "/target_twist:=" + prefix_ + "/target_twist", "-r",
                       "/drive_control_sample:=" + prefix_ + "/drive_control_sample"});
    drive_ = std::make_shared<motor_control_app::DriveComponent>(options);
    helper_ = std::make_shared<rclcpp::Node>("drive_node_test_helper_" + std::to_string(getpid()) +
                                             "_" + std::to_string(counter));
    twist_pub_ = helper_->create_publisher<geometry_msgs::msg::Twist>(prefix_ + "/target_twist", 1);
    estop_pub_ = helper_->create_publisher<questix_msgs::msg::EmergencyStop>(
        prefix_ + "/emergency_stop", rclcpp::QoS(1).reliable().transient_local());
    permission_pub_ = helper_->create_publisher<questix_msgs::msg::MotionPermission>(
        prefix_ + "/motion_permission", rclcpp::QoS(1).reliable().durability_volatile());
    status_sub_ = helper_->create_subscription<questix_msgs::msg::DriveStatus>(
        prefix_ + "/drive_status", 10, [this](questix_msgs::msg::DriveStatus::SharedPtr msg) {
          last_status_ = *msg;
          have_status_ = true;
        });
    log_sub_ = helper_->create_subscription<rcl_interfaces::msg::Log>(
        "/rosout", 100, [this](rcl_interfaces::msg::Log::SharedPtr msg) {
          if (msg->name == "drive_component") logs_.push_back(msg->msg);
        });
    sample_sub_ = helper_->create_subscription<questix_msgs::msg::DriveControlSample>(
        prefix_ + "/drive_control_sample", 10,
        [this](questix_msgs::msg::DriveControlSample::SharedPtr msg) { last_sample_ = *msg; });
    odom_sub_ = helper_->create_subscription<nav_msgs::msg::Odometry>(
        prefix_ + "/odom", 10, [this](nav_msgs::msg::Odometry::SharedPtr msg) {
          last_odom_ = *msg;
          have_odom_ = true;
        });
    rosout_sub_ = helper_->create_subscription<rcl_interfaces::msg::Log>(
        "/rosout", rclcpp::QoS(1000).reliable().durability_volatile(),
        [this](rcl_interfaces::msg::Log::SharedPtr msg) {
          if (msg->name == "drive_component" && msg->level >= rcl_interfaces::msg::Log::WARN &&
              msg->msg.find("Wheel position odometry anchor reset:") != std::string::npos) {
            odom_warnings_.push_back(msg->msg);
          }
          if (msg->name == "drive_component" && msg->level == rcl_interfaces::msg::Log::INFO &&
              msg->msg.find("Wheel position odometry deferred: E-stop polling suspended") !=
                  std::string::npos) {
            odom_estop_infos_.push_back(msg->msg);
          }
        });
    executor_ = std::make_unique<rclcpp::executors::SingleThreadedExecutor>();
    executor_->add_node(drive_->get_node_base_interface());
    executor_->add_node(helper_);
    if (expect_active) {
      ASSERT_TRUE(spinUntil([this]() { return isActive(); }, 10s))
          << "drive_component did not reach ACTIVE on the fake motor";
    } else {
      spinFor(200ms);
    }
  }

  void startRepressedEstop() {
    operationManagerWithoutGpio();
    estop_active_ = true;
    motor_.answerBoth(false);
    start();
    ASSERT_TRUE(spinUntil([this]() { return odom_estop_infos_.size() == 1; }, 2s));
    estop_active_ = false;
    motor_.answerBoth(true);
    ASSERT_TRUE(spinUntil(
        [this]() {
          return last_sample_.left.feedback_count > 0 && last_sample_.right.feedback_count > 0;
        },
        2s));
    spinFor(400ms);
    estop_active_ = true;
    ASSERT_TRUE(spinUntil([this]() { return odom_estop_infos_.size() == 2; }, 2s));
    spinFor(800ms);  // the retained pair is stale (>0.5 s), polling deliberately suspended
    ASSERT_EQ(drive_->get_parameter("stop_resend_interval_ms").as_int(), 300);
  }

  void expectStaggeredRelease(bool left_first) {
    ASSERT_NO_FATAL_FAILURE(startRepressedEstop());
    const auto left_count = last_sample_.left.feedback_count;
    const auto right_count = last_sample_.right.feedback_count;
    motor_.answerLeft(left_first);
    motor_.answerRight(!left_first);
    odom_warnings_.clear();  // only this release through the new pair, not previous stages
    estop_active_ = false;
    publishEstop(false, kNoGpioReason);
    ASSERT_TRUE(spinUntil(
        [this, left_first, left_count, right_count]() {
          return left_first ? last_sample_.left.feedback_count > left_count
                            : last_sample_.right.feedback_count > right_count;
        },
        400ms));
    spinFor(200ms);  // one fresh wheel; the other still has its pre-release stale frame
    EXPECT_EQ(left_first ? last_sample_.right.feedback_count : last_sample_.left.feedback_count,
              left_first ? right_count : left_count);
    EXPECT_TRUE(odom_warnings_.empty());
    motor_.answerBoth(true);
    ASSERT_TRUE(spinUntil(
        [this, left_count, right_count]() {
          return last_sample_.left.feedback_count > left_count &&
                 last_sample_.right.feedback_count > right_count;
        },
        400ms));
    spinFor(100ms);  // include re-anchoring and rosout delivery
    EXPECT_TRUE(odom_warnings_.empty());
    EXPECT_EQ(odom_estop_infos_.size(), 2u);
    EXPECT_TRUE(lastCommandsAreZero());
    EXPECT_NEAR(last_odom_.pose.pose.position.x, 0, 1e-9);
    EXPECT_NEAR(last_odom_.pose.pose.position.y, 0, 1e-9);
  }

  bool isActive() const {
    return drive_->get_current_state().id() == lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE;
  }

  // Spins (and keeps whatever periodic inputs are switched on flowing) until pred or timeout.
  bool spinUntil(const std::function<bool()>& pred, std::chrono::milliseconds timeout) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    auto next_input = std::chrono::steady_clock::now();
    while (std::chrono::steady_clock::now() < deadline) {
      if (std::chrono::steady_clock::now() >= next_input) {
        next_input += 50ms;  // a controller at 20 Hz, /motion_permission at 20 Hz
        // operation_manager evaluates every 100 ms and publishes each time.
        if (send_estop_ && (++estop_tick_ % 2 == 0)) {
          publishEstop(estop_active_,
                       estop_active_ ? "pin 5 is true, expected false; " : kNoGpioReason);
        }
        if (send_twist_) {
          geometry_msgs::msg::Twist twist;
          twist.linear.x = twist_linear_;
          twist_pub_->publish(twist);
        }
        if (send_permission_) {
          questix_msgs::msg::MotionPermission permission;
          permission.drive_allowed = permission_allowed_;
          permission.launcher_allowed = false;
          permission.mode = "competition";
          if (!permission_allowed_) {
            permission.drive_blockers.push_back("referee:off");
          }
          permission.launcher_blockers.push_back("referee:off");
          permission_pub_->publish(permission);
        }
      }
      executor_->spin_some(10ms);
      if (pred()) {
        return true;
      }
    }
    return pred();
  }

  // Spins for a fixed time (used to show that something does NOT happen).
  void spinFor(std::chrono::milliseconds duration) {
    spinUntil([]() { return false; }, duration);
  }

  void neutral() {
    twist_linear_ = 0.0;
    send_twist_ = true;
    spinFor(400ms);  // gates must be heard before a neutral can rearm
    twist_linear_ = 0.5;
  }

  bool droveBothWheels() const { return motor_.drove(kLeftId) && motor_.drove(kRightId); }

  void publishEstop(bool active, const std::string& reason) {
    questix_msgs::msg::EmergencyStop msg;
    msg.active = active;
    msg.source = "operation_manager";
    msg.reason = reason;
    estop_pub_->publish(msg);
  }

  // Plays operation_manager without the GPIO safety path: "released" at 10 Hz, and
  // MotionPermissionManager of a practice run: allowed at 20 Hz.
  void operationManagerWithoutGpio() {
    send_estop_ = true;
    estop_active_ = false;
    send_permission_ = true;
    permission_allowed_ = true;
  }

  bool lastCommandsAreZero() const {
    return motor_.lastCommandIsZero(kLeftId) && motor_.lastCommandIsZero(kRightId);
  }

  FakeMotor motor_;
  std::string prefix_;
  std::string overrides_path_;
  std::shared_ptr<motor_control_app::DriveComponent> drive_;
  std::shared_ptr<rclcpp::Node> helper_;
  std::unique_ptr<rclcpp::executors::SingleThreadedExecutor> executor_;
  rclcpp::Publisher<geometry_msgs::msg::Twist>::SharedPtr twist_pub_;
  rclcpp::Publisher<questix_msgs::msg::EmergencyStop>::SharedPtr estop_pub_;
  rclcpp::Publisher<questix_msgs::msg::MotionPermission>::SharedPtr permission_pub_;
  rclcpp::Subscription<questix_msgs::msg::DriveStatus>::SharedPtr status_sub_;
  questix_msgs::msg::DriveStatus last_status_;
  rclcpp::Subscription<questix_msgs::msg::DriveControlSample>::SharedPtr sample_sub_;
  questix_msgs::msg::DriveControlSample last_sample_;
  rclcpp::Subscription<nav_msgs::msg::Odometry>::SharedPtr odom_sub_;
  nav_msgs::msg::Odometry last_odom_;
  bool have_odom_{false};
  rclcpp::Subscription<rcl_interfaces::msg::Log>::SharedPtr rosout_sub_;
  std::vector<std::string> odom_warnings_;
  std::vector<std::string> odom_estop_infos_;
  bool have_status_{false};
  rclcpp::Subscription<rcl_interfaces::msg::Log>::SharedPtr log_sub_;
  std::vector<std::string> logs_;
  bool send_twist_{false};
  double twist_linear_{0.5};
  bool send_estop_{false};
  bool estop_active_{false};
  int estop_tick_{0};
  bool send_permission_{false};
  bool permission_allowed_{false};
};

TEST_F(DriveComponentNode, EstopStartupAndRepressDeferOnlyExpectedOdomLogs) {
  operationManagerWithoutGpio();
  estop_active_ = true;
  motor_.answerBoth(false);
  start();
  ASSERT_TRUE(spinUntil([this]() { return odom_estop_infos_.size() == 1; }, 2s));
  spinFor(100ms);  // drain any initial unknown-state log before the confirmed pressed interval
  odom_warnings_.clear();
  motor_.clear();
  spinFor(1400ms);
  ASSERT_TRUE(have_odom_ && have_status_);
  EXPECT_EQ(last_status_.left.header.stamp.sec, 0);
  EXPECT_EQ(last_status_.right.header.stamp.sec, 0);
  EXPECT_TRUE(odom_warnings_.empty());
  EXPECT_EQ(odom_estop_infos_.size(), 1u);
  EXPECT_TRUE(motor_.commands().empty());  // logging must not resume polling

  // Release with replies: the first new pair re-anchors, including the expected idle gap.
  odom_warnings_.clear();
  motor_.answerBoth(true);
  estop_active_ = false;
  ASSERT_TRUE(spinUntil(
      [this]() {
        return last_status_.left.header.stamp.sec != 0 && last_status_.right.header.stamp.sec != 0;
      },
      2s));
  spinFor(400ms);
  EXPECT_TRUE(odom_warnings_.empty());
  EXPECT_EQ(odom_estop_infos_.size(), 1u);

  estop_active_ = true;
  ASSERT_TRUE(spinUntil([this]() { return odom_estop_infos_.size() == 2; }, 2s));
  spinFor(100ms);
  odom_warnings_.clear();
  motor_.clear();
  spinFor(1400ms);  // cached feedback is now stale, but polling was intentionally suspended
  EXPECT_TRUE(odom_warnings_.empty());
  EXPECT_EQ(odom_estop_infos_.size(), 2u);
  EXPECT_TRUE(motor_.commands().empty());
  EXPECT_NEAR(last_odom_.pose.pose.position.x, 0, 1e-9);
  EXPECT_NEAR(last_odom_.pose.pose.position.y, 0, 1e-9);
  EXPECT_NEAR(last_odom_.pose.pose.orientation.z, 0, 1e-9);
}

// Retained feedback must stay quiet through each release, not just the unheard first one.
TEST_F(DriveComponentNode, RepeatedEstopReleaseWaitsQuietlyForFreshPair) {
  operationManagerWithoutGpio();
  estop_active_ = true;
  motor_.answerBoth(false);
  start();
  ASSERT_EQ(drive_->get_parameter("stop_resend_interval_ms").as_int(), 300);
  for (size_t press = 1; press <= 3; ++press) {
    SCOPED_TRACE(press);
    ASSERT_TRUE(spinUntil([this, press]() { return odom_estop_infos_.size() == press; }, 2s));
    spinFor(100ms);  // drain logs from the preceding stage
    odom_warnings_.clear();
    spinFor(700ms);  // retained feedback, when present, becomes stale while pressed
    EXPECT_TRUE(odom_warnings_.empty());
    const auto left_count = last_sample_.left.feedback_count;
    const auto right_count = last_sample_.right.feedback_count;

    motor_.answerBoth(false);
    odom_warnings_.clear();  // count only this release through the fresh-pair anchor
    estop_active_ = false;
    publishEstop(false, kNoGpioReason);
    spinFor(1050ms);  // delay replies within the 1.64 s grace, as on ID13
    EXPECT_TRUE(odom_warnings_.empty());
    motor_.answerBoth(true);
    ASSERT_TRUE(spinUntil(
        [this, left_count, right_count]() {
          return last_sample_.left.feedback_count > left_count &&
                 last_sample_.right.feedback_count > right_count;
        },
        400ms));
    spinFor(100ms);
    EXPECT_TRUE(odom_warnings_.empty());
    EXPECT_EQ(odom_estop_infos_.size(), press);
    EXPECT_TRUE(lastCommandsAreZero());
    EXPECT_NEAR(last_odom_.pose.pose.position.x, 0, 1e-9);
    EXPECT_NEAR(last_odom_.pose.pose.position.y, 0, 1e-9);
    if (press < 3) {
      estop_active_ = true;
      publishEstop(true, "test repress");
    }
  }
}

TEST_F(DriveComponentNode, SecondEstopReleaseWithoutRepliesEventuallyWarns) {
  operationManagerWithoutGpio();
  estop_active_ = true;
  start();
  ASSERT_TRUE(spinUntil([this]() { return odom_estop_infos_.size() == 1; }, 2s));
  estop_active_ = false;
  ASSERT_TRUE(spinUntil(
      [this]() {
        return last_status_.left.header.stamp.sec != 0 && last_status_.right.header.stamp.sec != 0;
      },
      2s));
  spinFor(400ms);
  estop_active_ = true;
  ASSERT_TRUE(spinUntil([this]() { return odom_estop_infos_.size() == 2; }, 2s));
  spinFor(800ms);
  motor_.answerBoth(false);
  odom_warnings_.clear();
  estop_active_ = false;
  publishEstop(false, kNoGpioReason);
  spinFor(1050ms);
  EXPECT_TRUE(odom_warnings_.empty());
  odom_warnings_.clear();  // expiry interval is distinct from the quiet grace
  ASSERT_TRUE(spinUntil([this]() { return !odom_warnings_.empty(); }, 2200ms));
  EXPECT_NE(odom_warnings_.back().find("stale feedback"), std::string::npos);
}

TEST_F(DriveComponentNode, SecondEstopReleaseLeftFirstWaitsQuietlyForRetainedRight) {
  expectStaggeredRelease(true);
}

TEST_F(DriveComponentNode, SecondEstopReleaseRightFirstWaitsQuietlyForRetainedLeft) {
  expectStaggeredRelease(false);
}

TEST_F(DriveComponentNode, SecondEstopReleaseWithUpdatedWheelBecomingStaleStillWarns) {
  ASSERT_NO_FATAL_FAILURE(startRepressedEstop());
  const auto left_count = last_sample_.left.feedback_count;
  const auto right_count = last_sample_.right.feedback_count;
  motor_.answerRight(false);
  odom_warnings_.clear();
  estop_active_ = false;
  publishEstop(false, kNoGpioReason);
  const auto released_at = std::chrono::steady_clock::now();
  ASSERT_TRUE(spinUntil(
      [this, left_count]() { return last_sample_.left.feedback_count > left_count; }, 400ms));
  motor_.answerBoth(false);
  spinFor(200ms);  // the updated left frame is still fresh
  EXPECT_TRUE(odom_warnings_.empty());
  EXPECT_EQ(last_sample_.right.feedback_count, right_count);
  odom_warnings_.clear();  // now count only the updated-left-becomes-stale interval
  ASSERT_TRUE(spinUntil([this]() { return !odom_warnings_.empty(); }, 850ms));
  EXPECT_NE(odom_warnings_.back().find("stale feedback"), std::string::npos);
  EXPECT_LT(std::chrono::duration<double>(std::chrono::steady_clock::now() - released_at).count(),
            1.5);  // WARN precedes expiry of the 1.64 s release grace
}

TEST_F(DriveComponentNode, SecondEstopReleaseWithOneFreshWheelEventuallyWarns) {
  ASSERT_NO_FATAL_FAILURE(startRepressedEstop());
  const auto left_count = last_sample_.left.feedback_count;
  const auto right_count = last_sample_.right.feedback_count;
  motor_.answerRight(false);  // left keeps answering, right never updates
  odom_warnings_.clear();
  estop_active_ = false;
  publishEstop(false, kNoGpioReason);
  ASSERT_TRUE(spinUntil(
      [this, left_count]() { return last_sample_.left.feedback_count > left_count; }, 400ms));
  spinFor(700ms);
  EXPECT_TRUE(odom_warnings_.empty());
  const auto first_left_count = last_sample_.left.feedback_count;
  odom_warnings_.clear();  // grace expiry, not the initial staggered recovery
  ASSERT_TRUE(spinUntil([this]() { return !odom_warnings_.empty(); }, 1800ms));
  EXPECT_NE(odom_warnings_.back().find("stale feedback"), std::string::npos);
  EXPECT_GT(last_sample_.left.feedback_count, first_left_count);
  EXPECT_EQ(last_sample_.right.feedback_count, right_count);
}

TEST_F(DriveComponentNode, EstopReleaseWithoutRepliesEventuallyWarns) {
  operationManagerWithoutGpio();
  estop_active_ = true;
  motor_.answerBoth(false);
  start();
  ASSERT_TRUE(spinUntil([this]() { return !odom_estop_infos_.empty(); }, 2s));
  spinFor(100ms);
  odom_warnings_.clear();
  estop_active_ = false;
  spinFor(1100ms);  // inside 1.64 s release grace at the integrated YAML's 50 Hz
  EXPECT_TRUE(odom_warnings_.empty());
  odom_warnings_.clear();
  ASSERT_TRUE(spinUntil([this]() { return !odom_warnings_.empty(); }, 2200ms));
  EXPECT_NE(odom_warnings_.back().find("invalid feedback or geometry"), std::string::npos);
}

TEST_F(DriveComponentNode, UnheardEstopKeepsOdomWarnings) {
  motor_.answerBoth(false);
  send_permission_ = true;
  permission_allowed_ = true;
  start();  // never publish an E-stop message
  spinFor(100ms);
  odom_warnings_.clear();
  ASSERT_TRUE(spinUntil([this]() { return !odom_warnings_.empty(); }, 1500ms));
  EXPECT_TRUE(odom_estop_infos_.empty());
}

TEST_F(DriveComponentNode, SilentEstopKeepsOdomWarnings) {
  operationManagerWithoutGpio();
  start();
  spinFor(500ms);
  send_estop_ = false;
  motor_.answerBoth(false);
  spinFor(1200ms);  // past the E-stop's 1.0 s lease; start a separate log-count interval
  odom_warnings_.clear();
  ASSERT_TRUE(spinUntil([this]() { return !odom_warnings_.empty(); }, 1500ms));
  EXPECT_TRUE(odom_estop_infos_.empty());
}

TEST_F(DriveComponentNode, PermissionOffStillPollsFeedbackForOdometry) {
  operationManagerWithoutGpio();
  permission_allowed_ = false;  // the same L2 vote result as the teacher's permission OFF
  start();
  spinFor(500ms);
  ASSERT_TRUE(have_status_);
  const auto stamp = rclcpp::Time(last_status_.left.header.stamp);
  odom_warnings_.clear();
  motor_.clear();
  spinFor(1400ms);
  EXPECT_GT(rclcpp::Time(last_status_.left.header.stamp).nanoseconds(), stamp.nanoseconds());
  EXPECT_FALSE(motor_.commands().empty());
  EXPECT_TRUE(odom_estop_infos_.empty());
  EXPECT_TRUE(odom_warnings_.empty());
}

TEST_F(DriveComponentNode, StationaryIdlePollingDoesNotEmitOdomWarnings) {
  start();
  operationManagerWithoutGpio();
  spinFor(1700ms);  // several normal 300ms feedback gaps, > one WARN throttle period
  ASSERT_TRUE(have_status_ && have_odom_);
  EXPECT_EQ(last_status_.left.velocity_rpm_raw, 0);
  EXPECT_EQ(last_status_.right.velocity_rpm_raw, 0);
  EXPECT_TRUE(odom_warnings_.empty());
  EXPECT_NEAR(last_odom_.pose.pose.position.x, 0, 1e-9);
}

TEST_F(DriveComponentNode, UnpoweredInitializationRetriesDoNotEmitOdomWarnings) {
  start("velocity", 0.0, false, true);
  operationManagerWithoutGpio();
  spinFor(1700ms);
  EXPECT_FALSE(isActive());
  EXPECT_TRUE(odom_warnings_.empty());
}

TEST_F(DriveComponentNode, MovingFeedbackGapStillEmitsOdomWarning) {
  start();
  operationManagerWithoutGpio();
  neutral();
  send_twist_ = true;
  ASSERT_TRUE(spinUntil([this]() { return droveBothWheels() && have_odom_; }, 5s));
  spinFor(100ms);
  odom_warnings_.clear();
  motor_.answerRight(false);
  ASSERT_TRUE(spinUntil(
      [this]() {
        return std::any_of(odom_warnings_.begin(), odom_warnings_.end(), [](const auto& message) {
          return message.find("reset: feedback pairing time limit") != std::string::npos;
        });
      },
      2s));
  // Count a separate, later interval: the pairing gap must not hide the stale-feedback WARN.
  odom_warnings_.clear();
  ASSERT_TRUE(spinUntil(
      [this]() {
        return std::any_of(odom_warnings_.begin(), odom_warnings_.end(), [](const auto& message) {
          return message.find("reset: stale feedback") != std::string::npos;
        });
      },
      2s));
}

TEST_F(DriveComponentNode, PersistentStopFaultWarnsOnlyOnStateTransition) {
  start();
  operationManagerWithoutGpio();
  neutral();
  send_twist_ = true;
  ASSERT_TRUE(spinUntil([this]() { return droveBothWheels() && have_odom_; }, 5s));
  odom_warnings_.clear();
  motor_.disconnect();
  permission_allowed_ = false;  // force a real failed zero write, not an injected fault flag
  const auto stop_fault_warnings = [this]() {
    return std::count_if(odom_warnings_.begin(), odom_warnings_.end(), [](const auto& message) {
      return message.find("reset: stop fault (pose retained)") != std::string::npos;
    });
  };
  // A genuine moving-gap WARN can precede the failed stop; keep that warning.
  ASSERT_TRUE(spinUntil([&]() { return stop_fault_warnings() > 0; }, 2s));
  spinFor(1500ms);  // persistent fault for longer than the previous throttle period
  EXPECT_EQ(stop_fault_warnings(), 1);
}

TEST_F(DriveComponentNode, PositionMovesPoseAndFrozenPositionDoesNotExtrapolateRpm) {
  start();
  operationManagerWithoutGpio();
  neutral();
  send_twist_ = true;
  ASSERT_TRUE(spinUntil([this]() { return droveBothWheels() && have_odom_; }, 5s));
  spinFor(200ms);
  EXPECT_NEAR(last_odom_.pose.pose.position.x, 0, 1e-9);
  EXPECT_GT(last_odom_.twist.twist.linear.x, 0);  // existing velocity field unchanged
  motor_.positions(1000, ddt::kPositionRawPerTurn - 1000);
  ASSERT_TRUE(spinUntil([this]() { return last_odom_.pose.pose.position.x > .005; }, 2s));
  const double x = last_odom_.pose.pose.position.x;
  EXPECT_NEAR(x, .05 * 6.283185307179586 * 1000 / ddt::kPositionRawPerTurn, 1e-6);
  spinFor(300ms);
  EXPECT_NEAR(last_odom_.pose.pose.position.x, x, 1e-9);
  EXPECT_NEAR(last_odom_.pose.pose.orientation.z, 0, 1e-6);
}

TEST_F(DriveComponentNode, MissingWheelDoesNotIntegrateUnpairedMotionOrRecoveryJump) {
  start();
  operationManagerWithoutGpio();
  neutral();
  send_twist_ = true;
  ASSERT_TRUE(spinUntil([this]() { return droveBothWheels() && have_odom_; }, 5s));
  spinFor(100ms);
  motor_.answerRight(false);
  motor_.positions(2000, 0);
  spinFor(300ms);  // pairing deadline, before the 0.5s stale boundary
  EXPECT_NEAR(last_odom_.pose.pose.position.x, 0, 1e-9);
  motor_.positions(8000, ddt::kPositionRawPerTurn - 8000);
  motor_.answerRight(true);
  spinFor(700ms);
  neutral();  // rearm after the missing wheel recovers under #208
  EXPECT_NEAR(last_odom_.pose.pose.position.x, 0, 1e-9);
  motor_.positions(8500, ddt::kPositionRawPerTurn - 8500);
  ASSERT_TRUE(spinUntil([this]() { return last_odom_.pose.pose.position.x > .002; }, 2s));
  EXPECT_NEAR(last_odom_.pose.pose.position.x,
              .05 * 6.283185307179586 * 500 / ddt::kPositionRawPerTurn, 1e-6);
}

TEST_F(DriveComponentNode, FaultDiscardsPositionIntervalAndPreservesPose) {
  start();
  operationManagerWithoutGpio();
  neutral();
  send_twist_ = true;
  ASSERT_TRUE(spinUntil([this]() { return droveBothWheels() && have_odom_; }, 5s));
  spinFor(100ms);
  motor_.positions(1000, ddt::kPositionRawPerTurn - 1000);
  ASSERT_TRUE(spinUntil([this]() { return last_odom_.pose.pose.position.x > .005; }, 2s));
  const auto pose = last_odom_.pose.pose;
  motor_.fault(1);
  motor_.positions(3000, ddt::kPositionRawPerTurn - 3000);
  ASSERT_TRUE(
      spinUntil([this]() { return have_status_ && last_status_.left.fault_code != 0; }, 2s));
  spinFor(150ms);
  EXPECT_NEAR(last_odom_.pose.pose.position.x, pose.position.x, 1e-9);
  motor_.positions(6000, ddt::kPositionRawPerTurn - 6000);
  motor_.fault(0);
  ASSERT_TRUE(spinUntil(
      [this]() { return last_status_.left.fault_code == 0 && last_status_.right.fault_code == 0; },
      2s));
  spinFor(100ms);
  EXPECT_NEAR(last_odom_.pose.pose.position.x, pose.position.x, 1e-9);
}

TEST_F(DriveComponentNode, CleanupReconfigureAndActivateReanchorWithoutTeleporting) {
  start();
  operationManagerWithoutGpio();
  neutral();
  send_twist_ = true;
  ASSERT_TRUE(spinUntil([this]() { return droveBothWheels() && have_odom_; }, 5s));
  spinFor(100ms);
  motor_.positions(1000, ddt::kPositionRawPerTurn - 1000);
  ASSERT_TRUE(spinUntil([this]() { return last_odom_.pose.pose.position.x > .005; }, 2s));
  const double x = last_odom_.pose.pose.position.x;
  drive_->deactivate();
  drive_->cleanup();
  motor_.positions(7000, ddt::kPositionRawPerTurn - 7000);
  drive_->configure();
  drive_->activate();
  ASSERT_TRUE(isActive());
  spinFor(300ms);
  EXPECT_NEAR(last_odom_.pose.pose.position.x, x, 1e-9);
  neutral();  // rearm after lifecycle activation under #208
  motor_.clear();
  ASSERT_TRUE(spinUntil([this]() { return droveBothWheels(); }, 2s));
  spinFor(100ms);  // fresh moving feedback pairs before the test's next position increment
  motor_.positions(7500, ddt::kPositionRawPerTurn - 7500);
  ASSERT_TRUE(spinUntil([this, x]() { return last_odom_.pose.pose.position.x > x + .002; }, 2s));
}

// The node's own defaults: the E-stop and the motion permission are both fail-closed.
TEST_F(DriveComponentNode, NodeDefaultsRequireTheEstopAndThePermission) {
  rclcpp::NodeOptions options;
  options.parameter_overrides({{"auto_start", false}});
  auto node = std::make_shared<motor_control_app::DriveComponent>(options);
  EXPECT_TRUE(node->get_parameter("require_emergency_stop").as_bool());
  EXPECT_TRUE(node->get_parameter("require_motion_permission").as_bool());
  EXPECT_EQ(node->get_parameter("motion_permission_topic").as_string(), "/motion_permission");
  EXPECT_DOUBLE_EQ(node->get_parameter("motion_permission_timeout_sec").as_double(), 0.5);
  EXPECT_FALSE(node->has_parameter("require_teacher_permission"));
}

// A manual diagnostic run without the GPIO safety path (enable_gpio_ref:=false; production launches
// always read GPIO5), in practice: with operation_manager's "released (no GPIO safety path)" and an
// allowed /motion_permission, /target_twist drives both wheels; when that /emergency_stop goes
// silent the drive stops.
TEST_F(DriveComponentNode, PracticeWithoutGpioDrivesOnTargetTwist) {
  start();
  EXPECT_TRUE(drive_->get_parameter("require_emergency_stop").as_bool());     // integrated YAML
  EXPECT_TRUE(drive_->get_parameter("require_motion_permission").as_bool());  // integrated YAML
  operationManagerWithoutGpio();
  neutral();
  send_twist_ = true;
  EXPECT_TRUE(spinUntil([this]() { return droveBothWheels(); }, 3s))
      << "no nonzero command reached the wheels";
  ASSERT_TRUE(spinUntil([this]() { return have_status_; }, 2s));
  EXPECT_FALSE(last_status_.emergency_stop);

  send_estop_ = false;  // operation_manager gone: silent for longer than 1.0 s
  ASSERT_TRUE(spinUntil([this]() { return lastCommandsAreZero(); }, 3s));
  motor_.clear();
  spinFor(500ms);
  EXPECT_FALSE(motor_.drove(kLeftId));
  EXPECT_FALSE(motor_.drove(kRightId));
}

// The motion permission is a lease: MotionPermissionManager going silent stops the drive (not an
// emergency stop), and its return does not restart it until the controller sends again.
TEST_F(DriveComponentNode, SilentPermissionStopsTheDriveButIsNotAnEstop) {
  start();
  operationManagerWithoutGpio();
  neutral();
  send_twist_ = true;
  ASSERT_TRUE(spinUntil([this]() { return droveBothWheels(); }, 3s));

  send_permission_ = false;  // silent for longer than 0.5 s
  ASSERT_TRUE(spinUntil([this]() { return lastCommandsAreZero(); }, 2s));
  motor_.clear();
  spinFor(500ms);  // twists keep coming
  EXPECT_FALSE(motor_.drove(kLeftId));
  have_status_ = false;
  ASSERT_TRUE(spinUntil([this]() { return have_status_; }, 2s));
  EXPECT_FALSE(last_status_.emergency_stop);

  send_twist_ = false;
  send_permission_ = true;  // back, but nothing new commanded
  spinFor(500ms);
  EXPECT_FALSE(motor_.drove(kLeftId));
  send_twist_ = true;
  spinFor(400ms);
  EXPECT_FALSE(droveBothWheels());
  neutral();
  EXPECT_TRUE(spinUntil([this]() { return droveBothWheels(); }, 3s));
}

// A received pressed E-stop stops the drive, twists are ignored while it is pressed, and after
// the release a new twist drives again.
TEST_F(DriveComponentNode, PressedEstopStopsAndReleaseDrivesAgain) {
  start();
  operationManagerWithoutGpio();
  neutral();
  send_twist_ = true;
  ASSERT_TRUE(spinUntil([this]() { return droveBothWheels(); }, 3s));

  estop_active_ = true;
  ASSERT_TRUE(spinUntil([this]() { return lastCommandsAreZero(); }, 2s));
  motor_.clear();
  spinFor(500ms);  // twists keep coming
  EXPECT_FALSE(motor_.drove(kLeftId));
  EXPECT_FALSE(motor_.drove(kRightId));
  ASSERT_TRUE(spinUntil([this]() { return have_status_ && last_status_.emergency_stop; }, 2s));

  estop_active_ = false;
  spinFor(400ms);
  EXPECT_FALSE(droveBothWheels());
  neutral();
  EXPECT_TRUE(spinUntil([this]() { return droveBothWheels(); }, 3s));
}

// An unheard E-stop (operation_manager not up yet) counts as pressed: no twist moves the drive
// until a release has been heard.
TEST_F(DriveComponentNode, UnheardEstopKeepsTheDriveStopped) {
  start();
  send_permission_ = true;
  permission_allowed_ = true;
  send_twist_ = true;
  spinFor(1000ms);
  EXPECT_FALSE(motor_.drove(kLeftId));
  EXPECT_FALSE(motor_.drove(kRightId));
  ASSERT_TRUE(spinUntil([this]() { return have_status_; }, 2s));
  EXPECT_TRUE(last_status_.emergency_stop);

  operationManagerWithoutGpio();
  spinFor(400ms);
  EXPECT_FALSE(droveBothWheels());
  neutral();
  EXPECT_TRUE(spinUntil([this]() { return droveBothWheels(); }, 3s));
}

// The motion permission gates the drive on its own (the referee says "not allowed"), and it is
// never an emergency stop. Unheard counts as not allowed.
TEST_F(DriveComponentNode, PermissionGatesTheDriveButIsNotAnEstop) {
  start();
  send_estop_ = true;  // released E-stop, no /motion_permission yet
  estop_active_ = false;
  send_twist_ = true;
  spinFor(800ms);
  EXPECT_FALSE(motor_.drove(kLeftId));
  ASSERT_TRUE(spinUntil([this]() { return have_status_; }, 2s));
  EXPECT_FALSE(last_status_.emergency_stop);  // refused by the permission, not by an E-stop

  send_permission_ = true;
  permission_allowed_ = true;
  spinFor(400ms);
  EXPECT_FALSE(droveBothWheels());
  neutral();
  ASSERT_TRUE(spinUntil([this]() { return droveBothWheels(); }, 3s));

  permission_allowed_ = false;  // defeated
  ASSERT_TRUE(spinUntil([this]() { return lastCommandsAreZero(); }, 2s));
  motor_.clear();
  spinFor(500ms);
  EXPECT_FALSE(motor_.drove(kLeftId));
  have_status_ = false;
  ASSERT_TRUE(spinUntil([this]() { return have_status_; }, 2s));
  EXPECT_FALSE(last_status_.emergency_stop);
}

class DriveRearmModes : public DriveComponentNode,
                        public ::testing::WithParamInterface<std::string> {};

TEST_P(DriveRearmModes, HeldInputAcrossEveryStopNeedsNeutral) {
  start(GetParam());
  operationManagerWithoutGpio();
  send_twist_ = true;
  spinFor(500ms);
  EXPECT_FALSE(droveBothWheels());
  EXPECT_TRUE(std::any_of(logs_.begin(), logs_.end(), [](const std::string& text) {
    return text.find("linear=0.5 angular=0; bands linear=0 angular=0") != std::string::npos;
  }));
  neutral();
  ASSERT_TRUE(spinUntil([this] { return droveBothWheels(); }, 3s));
  for (int cause = 0; cause < 5; ++cause) {
    SCOPED_TRACE(cause);
    if (cause == 0) permission_allowed_ = false;
    if (cause == 1) estop_active_ = true;
    if (cause == 2) send_twist_ = false;
    if (cause == 3) motor_.setFault(1);
    if (cause == 4) motor_control_app::DriveRearmNodeAccess::failedStop(*drive_);
    ASSERT_TRUE(spinUntil([this] { return lastCommandsAreZero(); }, 3s));
    // A neutral while inhibited is not a release for the later recovery.
    if (cause == 0 || cause == 1 || cause == 3) {
      twist_linear_ = 0;
      spinFor(200ms);
      twist_linear_ = .5;
    }
    permission_allowed_ = true;
    estop_active_ = false;
    send_twist_ = true;
    motor_.setFault(0);
    motor_.clear();
    spinFor(600ms);
    EXPECT_FALSE(droveBothWheels());
    neutral();
    ASSERT_TRUE(spinUntil([this] { return droveBothWheels(); }, 3s));
    motor_.clear();
  }
}

TEST_P(DriveRearmModes, BandRearmsToZeroButDoesNotFilterArmedMotion) {
  start(GetParam(), .05);
  operationManagerWithoutGpio();
  send_twist_ = true;
  twist_linear_ = .05001;
  spinFor(400ms);
  EXPECT_FALSE(droveBothWheels());
  send_twist_ = false;
  geometry_msgs::msg::Twist release;
  release.linear.x = .05;
  twist_pub_->publish(release);
  spinFor(400ms);
  // A qualifying nonzero neutral is saved as zero, not as .05 m/s.
  EXPECT_FALSE(droveBothWheels());
  twist_linear_ = .04;
  send_twist_ = true;
  ASSERT_TRUE(spinUntil([this] { return droveBothWheels(); }, 3s));
}

INSTANTIATE_TEST_SUITE_P(VelocityAndCurrent, DriveRearmModes,
                         ::testing::Values("velocity", "current"));

}  // namespace
