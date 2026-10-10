// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#include <gtest/gtest.h>

#include <chrono>      // NOLINT(build/include_order)
#include <functional>  // NOLINT(build/include_order)
#include <memory>      // NOLINT(build/include_order)
#include <questix_msgs/msg/actuation_authority.hpp>
#include <questix_msgs/msg/motion_permission.hpp>
#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/bool.hpp>
#include <stdexcept>  // NOLINT(build/include_order)
#include <string>     // NOLINT(build/include_order)
#include <thread>     // NOLINT(build/include_order)
#include <vector>     // NOLINT(build/include_order)

#include "operation_manager/motion_permission_manager_component.hpp"
#include "operation_manager/referee_monitor_component.hpp"

namespace {

using namespace std::chrono_literals;
using questix_msgs::msg::ActuationAuthority;
using questix_msgs::msg::MotionPermission;
using Strings = std::vector<std::string>;

bool spinUntil(rclcpp::executors::SingleThreadedExecutor& executor,
               const std::function<bool()>& condition, std::chrono::milliseconds timeout = 2000ms,
               const std::function<void()>& each = {}) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    if (each) {
      each();
    }
    executor.spin_some();
    if (condition()) {
      return true;
    }
    std::this_thread::sleep_for(5ms);
  }
  executor.spin_some();
  return condition();
}

rclcpp::QoS voteQos() { return rclcpp::QoS(1).reliable().durability_volatile(); }

class MotionPermissionNodesTest : public ::testing::Test {
protected:
  static void SetUpTestSuite() {
    if (!rclcpp::ok()) {
      rclcpp::init(0, nullptr);
    }
  }
  static void TearDownTestSuite() { rclcpp::shutdown(); }
};

rclcpp::NodeOptions managerOptions(const std::string& mode, const std::string& prefix,
                                   double lease_sec = 1.0) {
  rclcpp::NodeOptions options;
  options.parameter_overrides({
      rclcpp::Parameter("mode", mode),
      rclcpp::Parameter("lease_sec", lease_sec),
      rclcpp::Parameter("topic", prefix + "/motion_permission"),
      rclcpp::Parameter("votes.referee", prefix + "/motion_vote/referee"),
      rclcpp::Parameter("votes.teacher", prefix + "/actuation_authority"),
      rclcpp::Parameter("required.lesson", Strings{"teacher"}),
      rclcpp::Parameter("required.competition", Strings{"referee"}),
  });
  return options;
}

TEST_F(MotionPermissionNodesTest, PracticeNeedsNoVoteAndKeepsPublishing) {
  const std::string prefix = "/mpm_practice";
  auto observer = std::make_shared<rclcpp::Node>("mpm_practice_observer");
  std::vector<MotionPermission> received;
  auto sub = observer->create_subscription<MotionPermission>(
      prefix + "/motion_permission", voteQos(),
      [&received](MotionPermission::SharedPtr msg) { received.push_back(*msg); });
  auto manager = std::make_shared<operation_manager::MotionPermissionManagerComponent>(
      managerOptions("practice", prefix));
  rclcpp::executors::SingleThreadedExecutor executor;
  executor.add_node(observer);
  executor.add_node(manager);

  // Published periodically (20 Hz) even though nothing changes.
  ASSERT_TRUE(spinUntil(executor, [&received]() { return received.size() >= 3; }));
  EXPECT_TRUE(received.back().drive_allowed);
  EXPECT_TRUE(received.back().launcher_allowed);
  EXPECT_EQ(received.back().mode, "practice");
  EXPECT_TRUE(received.back().drive_blockers.empty());

  const auto info = observer->get_publishers_info_by_topic(prefix + "/motion_permission");
  ASSERT_EQ(info.size(), 1u);
  EXPECT_EQ(info[0].qos_profile().reliability(), rclcpp::ReliabilityPolicy::Reliable);
  EXPECT_EQ(info[0].qos_profile().durability(), rclcpp::DurabilityPolicy::Volatile);
}

TEST_F(MotionPermissionNodesTest, LessonFollowsTheTeachersVoteAndItsLease) {
  const std::string prefix = "/mpm_lesson";
  auto observer = std::make_shared<rclcpp::Node>("mpm_lesson_observer");
  MotionPermission::SharedPtr last;
  auto sub = observer->create_subscription<MotionPermission>(
      prefix + "/motion_permission", voteQos(),
      [&last](MotionPermission::SharedPtr msg) { last = msg; });
  auto teacher =
      observer->create_publisher<ActuationAuthority>(prefix + "/actuation_authority", voteQos());
  auto manager = std::make_shared<operation_manager::MotionPermissionManagerComponent>(
      managerOptions("lesson", prefix, 0.3));
  rclcpp::executors::SingleThreadedExecutor executor;
  executor.add_node(observer);
  executor.add_node(manager);

  ASSERT_TRUE(spinUntil(executor, [&last]() { return last != nullptr; }));
  EXPECT_FALSE(last->drive_allowed);
  EXPECT_EQ(last->drive_blockers, Strings{"teacher:unknown"});
  EXPECT_EQ(last->launcher_blockers, Strings{"teacher:unknown"});

  ActuationAuthority vote;
  vote.drive_allowed = true;
  vote.launcher_allowed = false;
  vote.source = "robot_manager";
  ASSERT_TRUE(spinUntil(
      executor, [&last]() { return last && last->drive_allowed; }, 2000ms,
      [&teacher, &vote]() { teacher->publish(vote); }));
  EXPECT_FALSE(last->launcher_allowed);
  EXPECT_EQ(last->launcher_blockers, Strings{"teacher:off"});

  // The heartbeat stops: the lease (0.3 s) runs out on its own.
  ASSERT_TRUE(spinUntil(executor, [&last]() { return last && !last->drive_allowed; }));
  EXPECT_EQ(last->drive_blockers, Strings{"teacher:stale"});
}

TEST_F(MotionPermissionNodesTest, CompetitionFollowsTheRefereeFromGpio27) {
  const std::string prefix = "/mpm_competition";
  auto observer = std::make_shared<rclcpp::Node>("mpm_competition_observer");
  MotionPermission::SharedPtr last;
  ActuationAuthority::SharedPtr last_vote;
  auto sub = observer->create_subscription<MotionPermission>(
      prefix + "/motion_permission", voteQos(),
      [&last](MotionPermission::SharedPtr msg) { last = msg; });
  auto vote_sub = observer->create_subscription<ActuationAuthority>(
      prefix + "/motion_vote/referee", voteQos(),
      [&last_vote](ActuationAuthority::SharedPtr msg) { last_vote = msg; });
  auto gpio27 = observer->create_publisher<std_msgs::msg::Bool>(prefix + "/gpio_27", 10);

  rclcpp::NodeOptions referee_options;
  referee_options.parameter_overrides({
      rclcpp::Parameter("timeout_seconds", 0.3),
      rclcpp::Parameter("vote_topic", prefix + "/motion_vote/referee"),
  });
  referee_options.arguments({"--ros-args", "-r", "__ns:=" + prefix});
  auto referee = std::make_shared<operation_manager::RefereeMonitorComponent>(referee_options);
  auto manager = std::make_shared<operation_manager::MotionPermissionManagerComponent>(
      managerOptions("competition", prefix));
  rclcpp::executors::SingleThreadedExecutor executor;
  executor.add_node(observer);
  executor.add_node(referee);
  executor.add_node(manager);

  // Nothing from GPIO27 yet: the referee votes "not allowed" (not unknown: it publishes).
  ASSERT_TRUE(spinUntil(executor, [&last, &last_vote]() {
    return last && last_vote && !last->drive_blockers.empty() &&
           last->drive_blockers[0] == "referee:off";
  }));
  EXPECT_FALSE(last_vote->drive_allowed);
  EXPECT_EQ(last_vote->source, "referee");

  std_msgs::msg::Bool high;
  high.data = true;
  ASSERT_TRUE(spinUntil(
      executor, [&last]() { return last && last->drive_allowed && last->launcher_allowed; }, 2000ms,
      [&gpio27, &high]() { gpio27->publish(high); }));
  EXPECT_EQ(last->mode, "competition");

  // Defeated (GPIO27 false): not allowed for both, reported as the referee's "off".
  std_msgs::msg::Bool low;
  low.data = false;
  ASSERT_TRUE(spinUntil(
      executor, [&last]() { return last && !last->drive_allowed; }, 2000ms,
      [&gpio27, &low]() { gpio27->publish(low); }));
  EXPECT_FALSE(last->launcher_allowed);
  EXPECT_EQ(last->drive_blockers, Strings{"referee:off"});
}

TEST_F(MotionPermissionNodesTest, AnUnknownModeOrAMissingVoteRefusesToStart) {
  EXPECT_THROW(std::make_shared<operation_manager::MotionPermissionManagerComponent>(
                   managerOptions("holiday", "/mpm_unknown")),
               std::invalid_argument);
  rclcpp::NodeOptions options;
  options.parameter_overrides({
      rclcpp::Parameter("mode", "lesson"),
      rclcpp::Parameter("required.lesson", Strings{"teacher"}),
  });
  EXPECT_THROW(std::make_shared<operation_manager::MotionPermissionManagerComponent>(options),
               std::invalid_argument);
  rclcpp::NodeOptions empty;
  EXPECT_THROW(std::make_shared<operation_manager::MotionPermissionManagerComponent>(empty),
               std::invalid_argument);  // no mode at all
}

}  // namespace
