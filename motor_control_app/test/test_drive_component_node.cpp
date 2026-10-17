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
//   does not restart the drive by itself;
// * in current mode (experimental), one wheel's answers stopping latches the library, and the
//   node fault-stops both wheels through its "Motor not healthy" path (Issue #222, P0-2).
#include <fcntl.h>
#include <gtest/gtest.h>
#include <pty.h>
#include <termios.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <functional>
#include <geometry_msgs/msg/twist.hpp>
#include <lifecycle_msgs/msg/state.hpp>
#include <map>
#include <memory>
#include <mutex>
#include <questix_msgs/msg/drive_control_sample.hpp>
#include <questix_msgs/msg/drive_status.hpp>
#include <questix_msgs/msg/emergency_stop.hpp>
#include <questix_msgs/msg/motion_permission.hpp>
#include <rclcpp/rclcpp.hpp>
#include <string>
#include <thread>
#include <vector>

#include "motor_control_app/drive_component.hpp"
#include "motor_control_lib/ddt_protocol.hpp"

using namespace std::chrono_literals;

namespace {

namespace ddt = motor_control_lib::ddt_protocol;

constexpr uint8_t kLeftId = 4;  // launcher/config/drive_component.yaml
constexpr uint8_t kRightId = 5;
constexpr uint8_t kCommand = 0x64;     // Protocol 1 (velocity / current command)
constexpr uint8_t kModeSwitch = 0xA0;  // Protocol 3 (spec sheet layout: the mode in DATA[9])

int16_t commandValue(const std::vector<uint8_t>& frame) {
  return static_cast<int16_t>((static_cast<uint16_t>(frame[2]) << 8) | frame[3]);  // big-endian
}

// The motor side of the serial line: reads every frame the node writes and answers commands. It
// takes the spec sheet's mode frames and reports its mode; in the current loop it reports speed 0
// (a held wheel), so the node's current PI and its guard see no motion.
class FakeMotor {
public:
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

  // Command frames (0x64) received so far, oldest first.
  std::vector<std::vector<uint8_t>> commands() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return commands_;
  }

  void clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    commands_.clear();
  }

  // Stops (or resumes) answering this wheel's frames, as a broken link or a dead driver would.
  void setSilent(uint8_t motor_id, bool silent) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (silent) {
      silent_[motor_id] = true;
    } else {
      silent_.erase(motor_id);
    }
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
      const bool mode_frame = frame[1] == kModeSwitch;  // the spec sheet's mode frame has no CRC
      if ((!mode_frame && ddt::crc8Maxim(payload) != frame[9]) ||
          (frame[0] != kLeftId && frame[0] != kRightId)) {
        ++pos;
        continue;
      }
      pos += 10;
      if (frame[1] == kModeSwitch) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (frame[9] == 0x01 || frame[9] == 0x02) {
          modes_[frame[0]] = frame[9];
        }
        continue;
      }
      if (frame[1] != kCommand) {
        continue;
      }
      uint8_t mode = 0x02;
      bool silent = false;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        commands_.push_back(frame);
        auto it = modes_.find(frame[0]);
        mode = it == modes_.end() ? 0x02 : it->second;
        silent = silent_.count(frame[0]) != 0;
      }
      if (!silent) {
        reply(frame[0], mode, mode == 0x01 ? 0 : commandValue(frame));
      }
    }
    pending.erase(pending.begin(), pending.begin() + pos);
  }

  // A M0602C feedback frame: {ID, mode, current(2), speed(2), position(2), fault, CRC8}.
  void reply(uint8_t motor_id, uint8_t mode, int16_t speed_rpm) {
    std::vector<uint8_t> frame = {motor_id,
                                  mode,
                                  0x00,
                                  0x00,
                                  static_cast<uint8_t>((speed_rpm >> 8) & 0xFF),
                                  static_cast<uint8_t>(speed_rpm & 0xFF),
                                  0x00,
                                  0x00,
                                  0x00};
    frame.push_back(ddt::crc8Maxim(frame));
    const ssize_t written = write(master_, frame.data(), frame.size());
    (void)written;
  }

  int master_{-1};
  int slave_{-1};
  std::string path_;
  std::atomic<bool> running_{false};
  std::thread reader_;
  mutable std::mutex mutex_;
  std::vector<std::vector<uint8_t>> commands_;
  std::map<uint8_t, uint8_t> modes_;  // motor id -> the loop it runs (power-on: velocity)
  std::map<uint8_t, bool> silent_;
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
  void start(const std::string& extra_overrides = "") {
    ASSERT_FALSE(motor_.path().empty()) << "openpty failed";
    static int counter = 0;
    prefix_ = "/drive_node_test_" + std::to_string(getpid()) + "_" + std::to_string(counter++);
    overrides_path_ = "/tmp" + prefix_ + ".yaml";
    {
      std::ofstream out(overrides_path_);
      out << "drive_component:\n  ros__parameters:\n"
          << "    serial_port: \"" << motor_.path() << "\"\n"
          << "    connect_retry_period_sec: 0.5\n"
          << "    publish_tf: false\n"
          << "    odom_topic: \"" << prefix_ << "/odom\"\n"
          << "    typed_status_topic: \"" << prefix_ << "/drive_status\"\n"
          << "    emergency_stop_topic: \"" << prefix_ << "/emergency_stop\"\n"
          << "    motion_permission_topic: \"" << prefix_ << "/motion_permission\"\n"
          << "    control_sample_topic: \"" << prefix_ << "/drive_control_sample\"\n"
          << extra_overrides;
    }
    rclcpp::NodeOptions options;
    // Later files win: hardware YAML, operator profile, then this test's overrides.
    options.arguments({"--ros-args", "--params-file", QUESTIX_DRIVE_HARDWARE_YAML, "--params-file",
                       QUESTIX_DRIVE_CONTROL_YAML, "--params-file", overrides_path_, "-r",
                       "/target_twist:=" + prefix_ + "/target_twist"});
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
    sample_sub_ = helper_->create_subscription<questix_msgs::msg::DriveControlSample>(
        prefix_ + "/drive_control_sample", 50,
        [this](questix_msgs::msg::DriveControlSample::SharedPtr msg) {
          if (msg->tick_action == questix_msgs::msg::DriveControlSample::TICK_FAULT_STOP) {
            ++fault_stop_ticks_;
          }
        });
    executor_ = std::make_unique<rclcpp::executors::SingleThreadedExecutor>();
    executor_->add_node(drive_->get_node_base_interface());
    executor_->add_node(helper_);
    ASSERT_TRUE(spinUntil([this]() { return isActive(); }, 10s))
        << "drive_component did not reach ACTIVE on the fake motor";
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
          twist.linear.x = 0.5;
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
  rclcpp::Subscription<questix_msgs::msg::DriveControlSample>::SharedPtr sample_sub_;
  int fault_stop_ticks_{0};
  questix_msgs::msg::DriveStatus last_status_;
  bool have_status_{false};
  bool send_twist_{false};
  bool send_estop_{false};
  bool estop_active_{false};
  int estop_tick_{0};
  bool send_permission_{false};
  bool permission_allowed_{false};
};

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
  EXPECT_TRUE(spinUntil([this]() { return droveBothWheels(); }, 3s));
}

// A received pressed E-stop stops the drive, twists are ignored while it is pressed, and after
// the release a new twist drives again.
TEST_F(DriveComponentNode, PressedEstopStopsAndReleaseDrivesAgain) {
  start();
  operationManagerWithoutGpio();
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

// Current mode (experimental, Issue #222 P0-2): one wheel's answers stop while driving. The
// library latches, the node takes its "Motor not healthy" path (a fault-stop tick, safetyStop),
// and while the wheel stays silent no nonzero current reaches either wheel although twists keep
// coming. The combination with the neutral wait of #208 is added once #208 is on main.
TEST_F(DriveComponentNode, CurrentModeOneWheelGoingSilentFaultStopsBothWheels) {
  start("    control_mode: \"current\"\n");
  operationManagerWithoutGpio();
  send_twist_ = true;
  ASSERT_TRUE(spinUntil([this]() { return droveBothWheels(); }, 5s))
      << "no nonzero current reached the wheels";

  fault_stop_ticks_ = 0;
  motor_.setSilent(kRightId, true);
  ASSERT_TRUE(spinUntil([this]() { return fault_stop_ticks_ > 0 && lastCommandsAreZero(); }, 3s))
      << "the node did not fault-stop on the silent wheel";
  motor_.clear();
  spinFor(1000ms);  // twists keep coming, the right wheel stays silent
  EXPECT_FALSE(motor_.drove(kLeftId));
  EXPECT_FALSE(motor_.drove(kRightId));
  have_status_ = false;
  ASSERT_TRUE(spinUntil([this]() { return have_status_; }, 2s));
  EXPECT_FALSE(last_status_.emergency_stop);  // a fault, not an emergency stop
}

}  // namespace
