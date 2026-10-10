// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#include <gtest/gtest.h>

#include <chrono>
#include <memory>
#include <questix_msgs/msg/motion_permission.hpp>
#include <rclcpp/rclcpp.hpp>
#include <rclcpp_lifecycle/lifecycle_node.hpp>
#include <string>
#include <vector>

#include "questix_safety/permission_monitor.hpp"

using namespace std::chrono_literals;
using questix_msgs::msg::MotionPermission;
using questix_safety::PermissionMonitor;
using questix_safety::PermissionState;

namespace {

MotionPermission message(bool drive, bool launcher, const std::string& mode = "lesson") {
  MotionPermission msg;
  msg.drive_allowed = drive;
  msg.launcher_allowed = launcher;
  msg.mode = mode;
  if (!drive) {
    msg.drive_blockers.push_back("teacher:off");
  }
  if (!launcher) {
    msg.launcher_blockers.push_back("teacher:off");
  }
  return msg;
}

// A steady clock the test moves by hand.
struct FakeClock {
  std::chrono::steady_clock::time_point now{std::chrono::steady_clock::time_point{} + 100s};
  PermissionMonitor::Clock fn() {
    return [this]() { return now; };
  }
};

class PermissionMonitorTest : public ::testing::Test {
protected:
  static void SetUpTestSuite() {
    if (!rclcpp::ok()) {
      rclcpp::init(0, nullptr);
    }
  }
  static void TearDownTestSuite() { rclcpp::shutdown(); }
};

TEST_F(PermissionMonitorTest, DeclaresTheParametersWithFailClosedDefaults) {
  auto node = std::make_shared<rclcpp::Node>("permission_monitor_defaults");
  const auto settings = PermissionMonitor::declareAndRead(*node);
  EXPECT_EQ(settings.topic, "/motion_permission");
  EXPECT_TRUE(settings.required);
  EXPECT_DOUBLE_EQ(settings.timeout_sec, 0.5);
  // A node that declared them itself keeps its values (no double declaration).
  auto declared = std::make_shared<rclcpp::Node>(
      "permission_monitor_declared",
      rclcpp::NodeOptions().parameter_overrides({{"require_motion_permission", false}}));
  declared->declare_parameter("require_motion_permission", true);
  EXPECT_FALSE(PermissionMonitor::declareAndRead(*declared).required);
}

TEST_F(PermissionMonitorTest, FollowsItsOwnFlagOnItsOwnClock) {
  auto node = std::make_shared<rclcpp::Node>("permission_monitor_rule");
  FakeClock clock;
  std::vector<PermissionMonitor::Change> changes;
  PermissionMonitor monitor(
      *node, PermissionMonitor::Settings{"", true, 0.5}, PermissionMonitor::Flag::kLauncher,
      "launcher",
      [&changes](const MotionPermission&, const PermissionMonitor::Change& change) {
        changes.push_back(change);
      },
      clock.fn());

  EXPECT_EQ(monitor.state(), PermissionState::kUnknown);
  EXPECT_FALSE(monitor.heard());
  EXPECT_FALSE(monitor.allowed());

  monitor.receive(message(false, true));  // drive off, launcher allowed: this node is launcher
  EXPECT_EQ(monitor.state(), PermissionState::kAllowed);
  EXPECT_EQ(monitor.lastMode(), "lesson");
  EXPECT_TRUE(monitor.lastBlockers().empty());
  ASSERT_EQ(changes.size(), 1u);
  EXPECT_TRUE(changes[0].first);
  EXPECT_FALSE(changes[0].was_allowed);

  clock.now += 400ms;
  EXPECT_EQ(monitor.state(), PermissionState::kAllowed);
  clock.now += 200ms;  // 0.6 s of silence
  EXPECT_EQ(monitor.state(), PermissionState::kStale);
  EXPECT_TRUE(monitor.blocks());

  monitor.receive(message(true, false));
  EXPECT_EQ(monitor.state(), PermissionState::kOff);
  EXPECT_EQ(monitor.lastBlockers(), std::vector<std::string>{"teacher:off"});
  ASSERT_EQ(changes.size(), 2u);
  EXPECT_FALSE(changes[1].first);
  EXPECT_TRUE(changes[1].was_allowed);
}

TEST_F(PermissionMonitorTest, TheDriveFlagIsSeparate) {
  auto node = std::make_shared<rclcpp::Node>("permission_monitor_drive");
  FakeClock clock;
  PermissionMonitor monitor(*node, PermissionMonitor::Settings{"", true, 0.5},
                            PermissionMonitor::Flag::kDrive, "drive", {}, clock.fn());
  monitor.receive(message(false, true));
  EXPECT_EQ(monitor.state(), PermissionState::kOff);
  monitor.receive(message(true, false));
  EXPECT_EQ(monitor.state(), PermissionState::kAllowed);
}

TEST_F(PermissionMonitorTest, AnInvalidTimeoutStillExpires) {
  auto node = std::make_shared<rclcpp::Node>("permission_monitor_timeout");
  FakeClock clock;
  PermissionMonitor monitor(*node, PermissionMonitor::Settings{"", true, 0.0},
                            PermissionMonitor::Flag::kDrive, "drive", {}, clock.fn());
  EXPECT_DOUBLE_EQ(monitor.timeoutSec(), 0.5);
  monitor.receive(message(true, true));
  clock.now += 600ms;
  EXPECT_EQ(monitor.state(), PermissionState::kStale);
}

TEST_F(PermissionMonitorTest, DiagnosticOptOutAllowsWithoutAMessage) {
  auto node = std::make_shared<rclcpp::Node>("permission_monitor_opt_out");
  PermissionMonitor monitor(*node, PermissionMonitor::Settings{"", false, 0.5},
                            PermissionMonitor::Flag::kDrive, "drive");
  EXPECT_EQ(monitor.state(), PermissionState::kAllowed);
}

// The real subscription on a lifecycle node: the contract QoS (volatile: nothing latched).
TEST_F(PermissionMonitorTest, SubscribesWithTheContractQosOnALifecycleNode) {
  const std::string topic = "/permission_monitor_test/motion_permission";
  auto publisher_node = std::make_shared<rclcpp::Node>("permission_monitor_publisher");
  auto publisher =
      publisher_node->create_publisher<MotionPermission>(topic, PermissionMonitor::qos());

  auto node = std::make_shared<rclcpp_lifecycle::LifecycleNode>("permission_monitor_lifecycle");
  int calls = 0;
  PermissionMonitor monitor(
      *node, PermissionMonitor::Settings{topic, true, 0.5}, PermissionMonitor::Flag::kDrive,
      "drive", [&calls](const MotionPermission&, const PermissionMonitor::Change&) { ++calls; });
  rclcpp::executors::SingleThreadedExecutor executor;
  executor.add_node(publisher_node);
  executor.add_node(node->get_node_base_interface());
  const auto deadline = std::chrono::steady_clock::now() + 3s;
  while (calls == 0 && std::chrono::steady_clock::now() < deadline) {
    publisher->publish(message(true, true, "practice"));
    executor.spin_some(20ms);
  }
  EXPECT_GE(calls, 1);
  EXPECT_EQ(monitor.state(), PermissionState::kAllowed);
  EXPECT_EQ(monitor.lastMode(), "practice");

  const auto info = publisher_node->get_subscriptions_info_by_topic(topic);
  ASSERT_EQ(info.size(), 1u);
  EXPECT_EQ(info[0].qos_profile().reliability(), rclcpp::ReliabilityPolicy::Reliable);
  EXPECT_EQ(info[0].qos_profile().durability(), rclcpp::DurabilityPolicy::Volatile);
}

}  // namespace
