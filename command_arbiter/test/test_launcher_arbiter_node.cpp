// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// The real LauncherArbiter node: the controller and a QUESTiX LAB run in, /launcher_command and
// the status out, on this test's own topics.
#include <gtest/gtest.h>

#include <chrono>
#include <cmath>
#include <functional>
#include <limits>
#include <memory>
#include <optional>
#include <questix_msgs/msg/actuation_authority.hpp>
#include <questix_msgs/msg/arbiter_status.hpp>
#include <questix_msgs/msg/launcher_command.hpp>
#include <rclcpp/rclcpp.hpp>
#include <string>
#include <vector>

#include "command_arbiter/launcher_arbiter_component.hpp"

using namespace std::chrono_literals;
using questix_msgs::msg::LauncherCommand;

namespace {

LauncherCommand command(float roller, uint32_t fire, const char* source,
                        float tilt = std::numeric_limits<float>::quiet_NaN()) {
  LauncherCommand msg;
  msg.roller_power = roller;
  msg.fire_seq = fire;
  msg.tilt_deg = tilt;
  msg.source = source;
  return msg;
}

class LauncherArbiterNode : public ::testing::Test {
protected:
  static void SetUpTestSuite() {
    if (!rclcpp::ok()) {
      rclcpp::init(0, nullptr);
    }
  }
  static void TearDownTestSuite() { rclcpp::shutdown(); }

  void SetUp() override {
    static int counter = 0;
    prefix_ = "/launcher_arbiter_test_" + std::to_string(counter++);
    rclcpp::NodeOptions options;
    options.parameter_overrides({
        {"joy_topic", prefix_ + "/joy"},
        {"lab_topic", prefix_ + "/lab"},
        {"output_topic", prefix_ + "/out"},
        {"status_topic", prefix_ + "/status"},
        {"lab_permission_topic", prefix_ + "/lab_permission"},
        {"spin_up_sec", 0.3},
    });
    arbiter_ = std::make_shared<command_arbiter::LauncherArbiterComponent>(options);
    helper_ = std::make_shared<rclcpp::Node>("launcher_arbiter_test_helper");
    const auto qos = rclcpp::QoS(1).reliable().durability_volatile();
    joy_pub_ = helper_->create_publisher<LauncherCommand>(prefix_ + "/joy", qos);
    lab_pub_ = helper_->create_publisher<LauncherCommand>(prefix_ + "/lab", qos);
    permission_pub_ = helper_->create_publisher<questix_msgs::msg::ActuationAuthority>(
        prefix_ + "/lab_permission", qos);
    out_sub_ = helper_->create_subscription<LauncherCommand>(
        prefix_ + "/out", rclcpp::QoS(10).reliable().durability_volatile(),
        [this](LauncherCommand::SharedPtr msg) { out_.push_back(*msg); });
    status_sub_ = helper_->create_subscription<questix_msgs::msg::ArbiterStatus>(
        prefix_ + "/status", rclcpp::QoS(10).reliable().durability_volatile(),
        [this](questix_msgs::msg::ArbiterStatus::SharedPtr msg) { status_ = *msg; });
    executor_.add_node(arbiter_);
    executor_.add_node(helper_);
    spinFor(300ms);  // discovery
  }

  // Spins while sending the permission every 100 ms (Robot Manager's heartbeat) and, when set,
  // the lab's heartbeat every 50 ms, until pred.
  bool spinUntil(const std::function<bool()>& pred, std::chrono::milliseconds timeout) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    auto next_permission = std::chrono::steady_clock::now();
    auto next_lab = std::chrono::steady_clock::now();
    while (std::chrono::steady_clock::now() < deadline) {
      const auto now = std::chrono::steady_clock::now();
      if (now >= next_permission) {
        next_permission += 100ms;
        questix_msgs::msg::ActuationAuthority msg;
        msg.drive_allowed = false;
        msg.launcher_allowed = true;
        permission_pub_->publish(msg);
      }
      if (lab_ && now >= next_lab) {
        next_lab += 50ms;
        lab_pub_->publish(*lab_);
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
  std::shared_ptr<command_arbiter::LauncherArbiterComponent> arbiter_;
  std::shared_ptr<rclcpp::Node> helper_;
  rclcpp::executors::SingleThreadedExecutor executor_;
  rclcpp::Publisher<LauncherCommand>::SharedPtr joy_pub_;
  rclcpp::Publisher<LauncherCommand>::SharedPtr lab_pub_;
  rclcpp::Publisher<questix_msgs::msg::ActuationAuthority>::SharedPtr permission_pub_;
  rclcpp::Subscription<LauncherCommand>::SharedPtr out_sub_;
  rclcpp::Subscription<questix_msgs::msg::ArbiterStatus>::SharedPtr status_sub_;
  std::vector<LauncherCommand> out_;
  questix_msgs::msg::ArbiterStatus status_;
  std::optional<LauncherCommand> lab_;
};

TEST_F(LauncherArbiterNode, ALabRunSpinsUpFiresAndTheControllerTakesOver) {
  ASSERT_TRUE(spinUntil([this]() { return status_.lab_permitted; }, 2s));
  EXPECT_EQ(status_.mechanism, "launcher");
  EXPECT_FLOAT_EQ(status_.max_power, 0.8f);
  EXPECT_TRUE(std::isnan(status_.max_linear));

  lab_ = command(1.0f, 0, "lab");  // beyond the cap; fire_seq 0 is the baseline
  ASSERT_TRUE(spinUntil([this]() { return status_.active_source == "lab"; }, 2s));
  ASSERT_FALSE(out_.empty());
  EXPECT_FLOAT_EQ(out_.back().roller_power, 0.8f);
  EXPECT_EQ(out_.back().source, "lab");
  ASSERT_TRUE(spinUntil([this]() { return status_.spin_ready_in_sec == 0.0f; }, 2s));
  lab_ = command(1.0f, 1, "lab");  // a shot after the spin-up
  ASSERT_TRUE(spinUntil([this]() { return !out_.empty() && out_.back().fire_seq == 1u; }, 2s));
  EXPECT_TRUE(spinUntil([this]() { return status_.next_fire_in_sec > 0.0f; }, 1s));

  joy_pub_->publish(command(0.0f, 0, "joy"));  // the controller's baseline
  spinFor(30ms);
  joy_pub_->publish(command(0.0f, 4, "joy"));  // a press: the controller takes over and fires
  ASSERT_TRUE(spinUntil([this]() { return out_.back().source == "joy"; }, 2s));
  ASSERT_TRUE(spinUntil([this]() { return status_.lab_locked; }, 2s));
  EXPECT_EQ(status_.active_source, "joy");
  EXPECT_FLOAT_EQ(out_.back().roller_power, 0.0f);
  EXPECT_EQ(out_.back().fire_seq, 2u);  // the output's own counter
}

TEST_F(LauncherArbiterNode, ASilentLabRunEndsWithTheRollerStopped) {
  ASSERT_TRUE(spinUntil([this]() { return status_.lab_permitted; }, 2s));
  lab_ = command(0.5f, 0, "lab");
  ASSERT_TRUE(spinUntil([this]() { return status_.active_source == "lab"; }, 2s));
  lab_.reset();  // the bridge died
  ASSERT_TRUE(spinUntil([this]() { return status_.switch_reason == "lab_idle"; }, 3s));
  EXPECT_FLOAT_EQ(out_.back().roller_power, 0.0f);
}

}  // namespace
