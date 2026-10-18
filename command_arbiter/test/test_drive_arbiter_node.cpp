// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// The real DriveArbiter node: the controller and a QUESTiX LAB run in, /target_twist and the
// status out, on this test's own topics.
#include <gtest/gtest.h>

#include <chrono>
#include <functional>
#include <geometry_msgs/msg/twist.hpp>
#include <limits>
#include <memory>
#include <questix_msgs/msg/actuation_authority.hpp>
#include <questix_msgs/msg/arbiter_status.hpp>
#include <rclcpp/rclcpp.hpp>
#include <string>
#include <thread>
#include <vector>

#include "command_arbiter/drive_arbiter_component.hpp"

using namespace std::chrono_literals;

namespace {

geometry_msgs::msg::Twist twist(double linear, double angular) {
  geometry_msgs::msg::Twist msg;
  msg.linear.x = linear;
  msg.angular.z = angular;
  return msg;
}

class DriveArbiterNode : public ::testing::Test {
protected:
  static void SetUpTestSuite() {
    if (!rclcpp::ok()) {
      rclcpp::init(0, nullptr);
    }
  }
  static void TearDownTestSuite() { rclcpp::shutdown(); }

  void SetUp() override {
    static int counter = 0;
    prefix_ = "/drive_arbiter_test_" + std::to_string(counter++);
    rclcpp::NodeOptions options;
    options.parameter_overrides({
        {"joy_topic", prefix_ + "/joy"},
        {"lab_topic", prefix_ + "/lab"},
        {"output_topic", prefix_ + "/out"},
        {"status_topic", prefix_ + "/status"},
        {"lab_permission_topic", prefix_ + "/lab_permission"},
    });
    arbiter_ = std::make_shared<command_arbiter::DriveArbiterComponent>(options);
    helper_ = std::make_shared<rclcpp::Node>("drive_arbiter_test_helper");
    joy_pub_ = helper_->create_publisher<geometry_msgs::msg::Twist>(prefix_ + "/joy", 1);
    lab_pub_ = helper_->create_publisher<geometry_msgs::msg::Twist>(prefix_ + "/lab", 1);
    permission_pub_ = helper_->create_publisher<questix_msgs::msg::ActuationAuthority>(
        prefix_ + "/lab_permission", rclcpp::QoS(1).reliable().durability_volatile());
    out_sub_ = helper_->create_subscription<geometry_msgs::msg::Twist>(
        prefix_ + "/out", 10,
        [this](geometry_msgs::msg::Twist::SharedPtr msg) { out_.push_back(*msg); });
    status_sub_ = helper_->create_subscription<questix_msgs::msg::ArbiterStatus>(
        prefix_ + "/status", rclcpp::QoS(10).reliable().durability_volatile(),
        [this](questix_msgs::msg::ArbiterStatus::SharedPtr msg) { status_ = *msg; });
    executor_.add_node(arbiter_);
    executor_.add_node(helper_);
    spinFor(300ms);  // discovery
  }

  // Spins while sending the permission every 100 ms (Robot Manager's heartbeat), until pred.
  bool spinUntil(const std::function<bool()>& pred, std::chrono::milliseconds timeout) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    auto next = std::chrono::steady_clock::now();
    while (std::chrono::steady_clock::now() < deadline) {
      if (std::chrono::steady_clock::now() >= next) {
        next += 100ms;
        if (send_permission_) {
          questix_msgs::msg::ActuationAuthority msg;
          msg.drive_allowed = permitted_;
          msg.launcher_allowed = false;
          permission_pub_->publish(msg);
        }
      }
      executor_.spin_some(10ms);
      if (pred()) {
        return true;
      }
    }
    return pred();
  }
  void spinFor(std::chrono::milliseconds duration) {
    spinUntil([]() { return false; }, duration);
  }

  std::string prefix_;
  std::shared_ptr<command_arbiter::DriveArbiterComponent> arbiter_;
  std::shared_ptr<rclcpp::Node> helper_;
  rclcpp::executors::SingleThreadedExecutor executor_;
  rclcpp::Publisher<geometry_msgs::msg::Twist>::SharedPtr joy_pub_;
  rclcpp::Publisher<geometry_msgs::msg::Twist>::SharedPtr lab_pub_;
  rclcpp::Publisher<questix_msgs::msg::ActuationAuthority>::SharedPtr permission_pub_;
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr out_sub_;
  rclcpp::Subscription<questix_msgs::msg::ArbiterStatus>::SharedPtr status_sub_;
  std::vector<geometry_msgs::msg::Twist> out_;
  questix_msgs::msg::ArbiterStatus status_;
  bool send_permission_{true};
  bool permitted_{true};
};

TEST_F(DriveArbiterNode, TheLabDrivesWithinItsCapsAndTheStickTakesOver) {
  ASSERT_TRUE(spinUntil([this]() { return status_.lab_permitted; }, 2s));
  EXPECT_EQ(status_.mechanism, "drive");
  EXPECT_EQ(status_.active_source, "joy");
  EXPECT_FLOAT_EQ(status_.max_linear, 0.15f);

  lab_pub_->publish(twist(0.5, -2.0));  // beyond the caps
  ASSERT_TRUE(spinUntil([this]() { return !out_.empty(); }, 2s));
  EXPECT_DOUBLE_EQ(out_.back().linear.x, 0.15);
  EXPECT_DOUBLE_EQ(out_.back().angular.z, -0.5);
  ASSERT_TRUE(spinUntil([this]() { return status_.active_source == "lab"; }, 2s));
  EXPECT_EQ(status_.lab_count, 1u);

  joy_pub_->publish(twist(0.3, 0.0));  // a hand on the stick
  ASSERT_TRUE(spinUntil([this]() { return status_.lab_locked; }, 2s));
  EXPECT_EQ(status_.active_source, "joy");
  EXPECT_EQ(status_.switch_reason, "controller");
  EXPECT_DOUBLE_EQ(out_.back().linear.x, 0.3);
  out_.clear();
  lab_pub_->publish(twist(0.1, 0.0));
  ASSERT_TRUE(spinUntil([this]() { return status_.lab_refusal == "locked"; }, 2s));
  EXPECT_TRUE(out_.empty());
}

TEST_F(DriveArbiterNode, NoPermissionNoLabDriveAndASilentLabRunEndsWithAStop) {
  permitted_ = false;
  ASSERT_TRUE(spinUntil([this]() { return status_.mechanism == "drive"; }, 2s));
  lab_pub_->publish(twist(0.1, 0.0));
  ASSERT_TRUE(spinUntil([this]() { return status_.lab_refusal == "not_permitted"; }, 2s));
  EXPECT_TRUE(out_.empty());

  permitted_ = true;
  ASSERT_TRUE(spinUntil([this]() { return status_.lab_permitted; }, 2s));
  lab_pub_->publish(twist(0.1, 0.0));
  ASSERT_TRUE(spinUntil([this]() { return status_.active_source == "lab"; }, 2s));
  // The lab goes silent: after 0.3 s a stop, and the controller again.
  ASSERT_TRUE(spinUntil([this]() { return status_.switch_reason == "lab_idle"; }, 2s));
  ASSERT_FALSE(out_.empty());
  EXPECT_DOUBLE_EQ(out_.back().linear.x, 0.0);
  EXPECT_EQ(status_.active_source, "joy");
}

TEST_F(DriveArbiterNode, LosingThePermissionStopsTheLabRun) {
  ASSERT_TRUE(spinUntil([this]() { return status_.lab_permitted; }, 2s));
  lab_pub_->publish(twist(0.1, 0.0));
  ASSERT_TRUE(spinUntil([this]() { return status_.active_source == "lab"; }, 2s));
  send_permission_ = false;  // Robot Manager's heartbeat stops: the lease runs out
  for (int i = 0; i < 20 && status_.active_source == "lab"; ++i) {
    lab_pub_->publish(twist(0.1, 0.0));
    spinFor(100ms);
  }
  EXPECT_EQ(status_.active_source, "joy");
  EXPECT_EQ(status_.switch_reason, "not_permitted");
  EXPECT_DOUBLE_EQ(out_.back().linear.x, 0.0);
}

TEST_F(DriveArbiterNode, StartupLabNeutralPassesOnlyWithPermissionAndIdleController) {
  ASSERT_TRUE(spinUntil([this] { return status_.lab_permitted; }, 2s));
  lab_pub_->publish(twist(0, 0));
  ASSERT_TRUE(spinUntil([this] { return !out_.empty(); }, 2s));
  EXPECT_EQ(out_.back().linear.x, 0);
  EXPECT_EQ(status_.active_source, "joy");
  joy_pub_->publish(twist(.3, 0));
  ASSERT_TRUE(spinUntil([this] { return out_.back().linear.x == .3; }, 2s));
  out_.clear();
  lab_pub_->publish(twist(0, 0));
  spinFor(150ms);
  EXPECT_TRUE(out_.empty());
  spinFor(500ms);  // controller timeout; a neutral does not steal its fresh input
  permitted_ = false;
  ASSERT_TRUE(spinUntil([this] { return !status_.lab_permitted; }, 2s));
  lab_pub_->publish(twist(0, 0));
  spinFor(150ms);
  EXPECT_TRUE(out_.empty());
}

TEST_F(DriveArbiterNode, InvalidControllerInputIsNeverForwardedAsNeutral) {
  for (double value :
       {std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::infinity()}) {
    joy_pub_->publish(twist(value, 0));
    spinFor(100ms);
    joy_pub_->publish(twist(0, value));
    spinFor(100ms);
    EXPECT_TRUE(out_.empty());
  }
}

}  // namespace
