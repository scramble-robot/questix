// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#include <gtest/gtest.h>

#include <chrono>
#include <diagnostic_msgs/msg/diagnostic_array.hpp>
#include <functional>  // NOLINT(build/include_order)
#include <memory>      // NOLINT(build/include_order)
#include <questix_msgs/msg/emergency_stop.hpp>
#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/bool.hpp>
#include <string>  // NOLINT(build/include_order)
#include <thread>  // NOLINT(build/include_order)
#include <vector>  // NOLINT(build/include_order)

#include "operation_manager/operation_manager_component.hpp"

namespace {

using namespace std::chrono_literals;

bool spin_until(rclcpp::executors::SingleThreadedExecutor& executor,
                const std::function<bool()>& condition,
                std::chrono::milliseconds timeout = 1000ms) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    executor.spin_some();
    if (condition()) {
      return true;
    }
    std::this_thread::sleep_for(5ms);
  }
  executor.spin_some();
  return condition();
}

std::string diagnostic_value(const diagnostic_msgs::msg::DiagnosticStatus& status,
                             const std::string& key) {
  for (const auto& value : status.values) {
    if (value.key == key) {
      return value.value;
    }
  }
  return "";
}

TEST(OperationManagerNodeTest, PublishesFailSafeStatesDiagnosticsAndContractQos) {
  const std::string estop_topic = "/test_operation_manager/emergency_stop";
  auto observer = std::make_shared<rclcpp::Node>("operation_manager_test_observer");

  questix_msgs::msg::EmergencyStop::SharedPtr last_estop;
  diagnostic_msgs::msg::DiagnosticArray::SharedPtr last_diagnostic;
  std_msgs::msg::Bool::SharedPtr last_controllable;
  auto estop_sub = observer->create_subscription<questix_msgs::msg::EmergencyStop>(
      estop_topic, rclcpp::QoS(1).reliable().transient_local(),
      [&last_estop](questix_msgs::msg::EmergencyStop::SharedPtr msg) { last_estop = msg; });
  auto diagnostic_sub = observer->create_subscription<diagnostic_msgs::msg::DiagnosticArray>(
      "/diagnostics", 10, [&last_diagnostic](diagnostic_msgs::msg::DiagnosticArray::SharedPtr msg) {
        last_diagnostic = msg;
      });
  auto controllable_sub = observer->create_subscription<std_msgs::msg::Bool>(
      "/gpio/controllable", 10,
      [&last_controllable](std_msgs::msg::Bool::SharedPtr msg) { last_controllable = msg; });
  auto gpio5_pub = observer->create_publisher<std_msgs::msg::Bool>("/gpio_5", 10);
  auto gpio27_pub = observer->create_publisher<std_msgs::msg::Bool>("/gpio_27", 10);

  rclcpp::NodeOptions options;
  options.parameter_overrides({
      rclcpp::Parameter("safe_low_pins", std::vector<int64_t>{5}),
      rclcpp::Parameter("safe_high_pins", std::vector<int64_t>{27}),
      rclcpp::Parameter("timeout_seconds", 0.2),
      rclcpp::Parameter("emergency_stop_topic", estop_topic),
  });
  auto manager = std::make_shared<operation_manager::OperationManagerComponent>(options);

  rclcpp::executors::SingleThreadedExecutor executor;
  executor.add_node(observer);
  executor.add_node(manager);

  ASSERT_TRUE(spin_until(executor, [&]() {
    return last_estop && last_diagnostic && last_controllable &&
           gpio5_pub->get_subscription_count() == 1U && gpio27_pub->get_subscription_count() == 1U;
  }));
  ASSERT_TRUE(last_estop->active);
  EXPECT_EQ(last_estop->source, "operation_manager");
  EXPECT_EQ(last_estop->reason, "pin 5 not received; pin 27 not received; ");
  EXPECT_FALSE(last_controllable->data);
  ASSERT_EQ(last_diagnostic->status.size(), 1U);
  EXPECT_EQ(last_diagnostic->status[0].level, diagnostic_msgs::msg::DiagnosticStatus::ERROR);
  EXPECT_EQ(diagnostic_value(last_diagnostic->status[0], "pin_5_state"), "not_received");
  EXPECT_EQ(diagnostic_value(last_diagnostic->status[0], "pin_5_age_sec"), "not_received");
  EXPECT_EQ(diagnostic_value(last_diagnostic->status[0], "pin_27_signal_limit"),
            "true cannot distinguish permission, disconnected, client unpowered, or "
            "primary-side open");

  const auto publisher_info = observer->get_publishers_info_by_topic(estop_topic);
  ASSERT_EQ(publisher_info.size(), 1U);
  EXPECT_EQ(publisher_info[0].qos_profile().reliability(), rclcpp::ReliabilityPolicy::Reliable);
  EXPECT_EQ(publisher_info[0].qos_profile().durability(), rclcpp::DurabilityPolicy::TransientLocal);
  const auto contract_qos = operation_manager::OperationManagerComponent::emergency_stop_qos();
  EXPECT_EQ(contract_qos.history(), rclcpp::HistoryPolicy::KeepLast);
  EXPECT_EQ(contract_qos.get_rmw_qos_profile().depth, 1U);

  std_msgs::msg::Bool gpio5;
  gpio5.data = false;
  gpio5_pub->publish(gpio5);
  ASSERT_TRUE(spin_until(
      executor, [&]() { return last_estop && last_estop->reason == "pin 27 not received; "; }));
  EXPECT_TRUE(last_estop->active);

  std_msgs::msg::Bool gpio27;
  gpio27.data = true;
  gpio27_pub->publish(gpio27);
  ASSERT_TRUE(spin_until(executor, [&]() { return last_estop && !last_estop->active; }));
  EXPECT_TRUE(last_controllable->data);
  EXPECT_EQ(last_estop->reason, "released");
  ASSERT_EQ(last_diagnostic->status.size(), 1U);
  EXPECT_EQ(last_diagnostic->status[0].level, diagnostic_msgs::msg::DiagnosticStatus::OK);
  EXPECT_EQ(diagnostic_value(last_diagnostic->status[0], "pin_5_state"), "false");
  EXPECT_EQ(diagnostic_value(last_diagnostic->status[0], "pin_27_state"), "true");

  gpio5.data = true;
  gpio5_pub->publish(gpio5);
  ASSERT_TRUE(spin_until(executor, [&]() {
    return last_estop && last_estop->reason == "pin 5 is true, expected false; ";
  }));
  EXPECT_TRUE(last_estop->active);
  EXPECT_EQ(last_diagnostic->status[0].level, diagnostic_msgs::msg::DiagnosticStatus::ERROR);

  gpio5.data = false;
  gpio27.data = false;
  gpio5_pub->publish(gpio5);
  gpio27_pub->publish(gpio27);
  ASSERT_TRUE(spin_until(executor, [&]() {
    return last_estop && last_estop->reason == "pin 27 is false, expected true; ";
  }));
  EXPECT_TRUE(last_estop->active);

  gpio27.data = true;
  gpio5_pub->publish(gpio5);
  gpio27_pub->publish(gpio27);
  ASSERT_TRUE(spin_until(executor, [&]() { return last_estop && !last_estop->active; }));
  ASSERT_TRUE(spin_until(
      executor,
      [&]() {
        return last_estop && last_estop->active &&
               last_estop->reason.find("timeout") != std::string::npos;
      },
      1000ms));
  EXPECT_FALSE(last_controllable->data);
  EXPECT_EQ(last_diagnostic->status[0].level, diagnostic_msgs::msg::DiagnosticStatus::ERROR);

  (void)estop_sub;
  (void)diagnostic_sub;
  (void)controllable_sub;
}

}  // namespace

int main(int argc, char** argv) {
  rclcpp::init(argc, argv);
  testing::InitGoogleTest(&argc, argv);
  const int result = RUN_ALL_TESTS();
  rclcpp::shutdown();
  return result;
}
