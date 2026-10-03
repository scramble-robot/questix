// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#include <gtest/gtest.h>

#include <chrono>
#include <functional>
#include <limits>
#include <memory>
#include <questix_msgs/msg/emergency_stop.hpp>
#include <rclcpp/rclcpp.hpp>
#include <rclcpp_lifecycle/lifecycle_node.hpp>
#include <string>
#include <thread>
#include <vector>

#include "questix_safety/emergency_stop_monitor.hpp"

using namespace std::chrono_literals;
using questix_msgs::msg::EmergencyStop;
using questix_safety::EmergencyStopMonitor;
using questix_safety::EstopState;

namespace {

EmergencyStop message(bool active, const std::string& reason) {
  EmergencyStop msg;
  msg.active = active;
  msg.source = "operation_manager";
  msg.reason = reason;
  return msg;
}

// A steady clock the test moves by hand.
struct FakeClock {
  std::chrono::steady_clock::time_point now{std::chrono::steady_clock::time_point{} + 100s};
  EmergencyStopMonitor::Clock fn() {
    return [this]() { return now; };
  }
};

class EmergencyStopMonitorTest : public ::testing::Test {
protected:
  static void SetUpTestSuite() {
    if (!rclcpp::ok()) {
      rclcpp::init(0, nullptr);
    }
  }
  static void TearDownTestSuite() { rclcpp::shutdown(); }
};

TEST_F(EmergencyStopMonitorTest, DeclaresTheParametersWithFailClosedDefaults) {
  auto node = std::make_shared<rclcpp::Node>("estop_monitor_defaults");
  const auto settings = EmergencyStopMonitor::declareAndRead(*node);
  EXPECT_EQ(settings.topic, "/emergency_stop");
  EXPECT_TRUE(settings.required);
  EXPECT_DOUBLE_EQ(settings.timeout_sec, 1.0);
  // A node that declared them itself keeps its values (no double declaration).
  auto declared = std::make_shared<rclcpp::Node>(
      "estop_monitor_declared",
      rclcpp::NodeOptions().parameter_overrides({{"require_emergency_stop", false}}));
  declared->declare_parameter("require_emergency_stop", true);
  EXPECT_FALSE(EmergencyStopMonitor::declareAndRead(*declared).required);
}

TEST_F(EmergencyStopMonitorTest, FollowsTheRuleOnItsOwnClock) {
  auto node = std::make_shared<rclcpp::Node>("estop_monitor_rule");
  FakeClock clock;
  std::vector<EmergencyStopMonitor::Change> changes;
  EmergencyStopMonitor monitor(
      *node, EmergencyStopMonitor::Settings{"", true, 1.0}, "test",
      [&changes](const EmergencyStop&, const EmergencyStopMonitor::Change& change) {
        changes.push_back(change);
      },
      clock.fn());

  EXPECT_EQ(monitor.state(), EstopState::kUnknown);
  EXPECT_FALSE(monitor.heard());
  EXPECT_TRUE(monitor.active());

  monitor.receive(message(false, "released (no GPIO safety path)"));
  EXPECT_EQ(monitor.state(), EstopState::kReleased);
  EXPECT_EQ(monitor.lastReason(), "released (no GPIO safety path)");
  ASSERT_EQ(changes.size(), 1u);
  EXPECT_TRUE(changes[0].first);
  EXPECT_TRUE(changes[0].was_active);

  clock.now += 900ms;
  EXPECT_EQ(monitor.state(), EstopState::kReleased);
  clock.now += 200ms;  // 1.1 s of silence
  EXPECT_EQ(monitor.state(), EstopState::kStale);
  EXPECT_TRUE(monitor.engaged());

  monitor.receive(message(true, "pin 5 is true, expected false; "));
  EXPECT_EQ(monitor.state(), EstopState::kPressed);
  ASSERT_EQ(changes.size(), 2u);
  EXPECT_FALSE(changes[1].first);
  EXPECT_FALSE(changes[1].was_active);

  monitor.receive(message(false, "released"));
  EXPECT_EQ(monitor.state(), EstopState::kReleased);
  EXPECT_TRUE(changes.back().was_active);
}

TEST_F(EmergencyStopMonitorTest, NonFiniteTimeoutDoesNotDisableTheStalenessCheck) {
  auto node = std::make_shared<rclcpp::Node>("estop_monitor_timeout");
  FakeClock clock;
  EmergencyStopMonitor monitor(
      *node, EmergencyStopMonitor::Settings{"", true, std::numeric_limits<double>::infinity()},
      "test", {}, clock.fn());
  EXPECT_DOUBLE_EQ(monitor.timeoutSec(), 1.0);
  monitor.receive(message(false, "released"));
  clock.now += 2s;
  EXPECT_EQ(monitor.state(), EstopState::kStale);
}

TEST_F(EmergencyStopMonitorTest, DiagnosticOptOutStillStopsOnAPressedMessage) {
  auto node = std::make_shared<rclcpp::Node>("estop_monitor_opt_out");
  FakeClock clock;
  EmergencyStopMonitor monitor(*node, EmergencyStopMonitor::Settings{"", false, 1.0}, "test", {},
                               clock.fn());
  EXPECT_EQ(monitor.state(), EstopState::kReleased);
  monitor.receive(message(true, "pressed"));
  EXPECT_EQ(monitor.state(), EstopState::kPressed);
}

// The real subscription on a lifecycle node (drive and shot are lifecycle nodes): the contract
// QoS, and a latched message reaches a late subscriber.
TEST_F(EmergencyStopMonitorTest, SubscribesWithTheContractQosOnALifecycleNode) {
  const std::string topic = "/estop_monitor_test/emergency_stop";
  auto publisher_node = std::make_shared<rclcpp::Node>("estop_monitor_publisher");
  auto publisher =
      publisher_node->create_publisher<EmergencyStop>(topic, EmergencyStopMonitor::qos());
  publisher->publish(message(false, "released (no GPIO safety path)"));  // before anyone listens

  auto node = std::make_shared<rclcpp_lifecycle::LifecycleNode>("estop_monitor_lifecycle");
  int calls = 0;
  EmergencyStopMonitor monitor(
      *node, EmergencyStopMonitor::Settings{topic, true, 1.0}, "test",
      [&calls](const EmergencyStop&, const EmergencyStopMonitor::Change&) { ++calls; });
  rclcpp::executors::SingleThreadedExecutor executor;
  executor.add_node(publisher_node);
  executor.add_node(node->get_node_base_interface());
  const auto deadline = std::chrono::steady_clock::now() + 3s;
  while (calls == 0 && std::chrono::steady_clock::now() < deadline) {
    executor.spin_some(10ms);
  }
  EXPECT_EQ(calls, 1);
  EXPECT_EQ(monitor.state(), EstopState::kReleased);

  const auto info = publisher_node->get_subscriptions_info_by_topic(topic);
  ASSERT_EQ(info.size(), 1u);
  EXPECT_EQ(info[0].qos_profile().reliability(), rclcpp::ReliabilityPolicy::Reliable);
  EXPECT_EQ(info[0].qos_profile().durability(), rclcpp::DurabilityPolicy::TransientLocal);
}

}  // namespace
