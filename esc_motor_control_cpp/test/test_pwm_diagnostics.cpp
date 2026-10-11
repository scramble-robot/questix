// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include <cstdarg>
#include <cstdio>
#include <string>
#include <utility>
#include <vector>

#include "esc_motor_control_cpp/esc_motor_control_component.hpp"
#include "rcutils/logging.h"

namespace {
std::vector<std::pair<int, std::string>> logs;
void capture(const rcutils_log_location_t*, int severity, const char*, rcutils_time_point_value_t,
             const char* format, va_list* args) {
  char text[1024];
  std::vsnprintf(text, sizeof(text), format, *args);
  logs.emplace_back(severity, text);
}
class PwmDiagnosticsTest : public ::testing::Test {
protected:
  void SetUp() override {
    rclcpp::init(0, nullptr, rclcpp::InitOptions(), rclcpp::SignalHandlerOptions::None);
    previous_ = rcutils_logging_get_output_handler();
    rcutils_logging_set_output_handler(capture);
    logs.clear();
  }
  void TearDown() override {
    rcutils_logging_set_output_handler(previous_);
    rclcpp::shutdown();
  }
  bool has_error(const std::string& text) {
    for (const auto& log : logs) {
      if (log.first == RCUTILS_LOG_SEVERITY_ERROR && log.second.find(text) != std::string::npos) {
        return true;
      }
    }
    return false;
  }
  rcutils_logging_output_handler_t previous_{nullptr};
};
}  // namespace

TEST_F(PwmDiagnosticsTest, InvalidConfigurationLogsErrorWithoutChangingParameters) {
  rclcpp::NodeOptions options;
  options.append_parameter_override("test_mode", true);
  options.append_parameter_override("min_pulse_width", 499);
  options.append_parameter_override("max_pulse_width", 3000);
  options.append_parameter_override("neutral_pulse_width", 3000);
  esc_motor_control_cpp::EscMotorControlComponent node(options);
  EXPECT_TRUE(has_error("min_speed maps to 499 us"));
  EXPECT_TRUE(has_error("max_speed maps to 3000 us"));
  EXPECT_TRUE(has_error("neutral maps to 3000 us"));
  EXPECT_EQ(node.get_parameter("min_pulse_width").as_int(), 499);
  EXPECT_EQ(node.get_parameter("max_pulse_width").as_int(), 3000);
  EXPECT_EQ(node.get_parameter("neutral_pulse_width").as_int(), 3000);
}

TEST_F(PwmDiagnosticsTest, DefaultIntervalWarnsAndSimulationIsReported) {
  rclcpp::NodeOptions options;
  options.append_parameter_override("test_mode", true);
  esc_motor_control_cpp::EscMotorControlComponent node(options);
  EXPECT_TRUE(has_error("continuous speed interval intersects 1-499 us"));
  bool simulation = false;
  for (const auto& log : logs) {
    if (log.second == "PWM backend: simulation") simulation = true;
  }
  EXPECT_TRUE(simulation);
}
