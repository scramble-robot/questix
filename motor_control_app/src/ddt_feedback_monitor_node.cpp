// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// ddt_feedback_monitor: read-only CLI that subscribes to the typed motor
// feedback topics published by drive_component (and friends) and renders a
// per-motor table that updates in place. This lets DDT motors be monitored
// during tuning without opening /dev/ttyACM0 directly (which conflicts with a
// running drive_component). See questix_msgs/README.md for the topic contract.
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "motor_control_app/ddt_feedback_format.hpp"
#include "questix_msgs/msg/drive_status.hpp"
#include "questix_msgs/msg/motor_feedback.hpp"
#include "rclcpp/rclcpp.hpp"

namespace motor_control_app {

/// Node that collects MotorFeedback keyed by motor_id and prints a live table.
class DdtFeedbackMonitor : public rclcpp::Node {
public:
  explicit DdtFeedbackMonitor(const rclcpp::NodeOptions& options)
      : rclcpp::Node("ddt_feedback_monitor", options) {
    auto drive_status_topics = this->declare_parameter<std::vector<std::string>>(
        "drive_status_topics", std::vector<std::string>{"/drive_status"});
    auto motor_feedback_topics = this->declare_parameter<std::vector<std::string>>(
        "motor_feedback_topics", std::vector<std::string>{});
    double rate_hz = this->declare_parameter<double>("rate_hz", 5.0);
    stale_sec_ = this->declare_parameter<double>("stale_sec", 0.5);
    color_ = this->declare_parameter<bool>("color", true);
    if (rate_hz <= 0.0) {
      rate_hz = 5.0;
    }

    for (const auto& topic : drive_status_topics) {
      drive_status_subs_.push_back(this->create_subscription<questix_msgs::msg::DriveStatus>(
          topic, 10, [this](questix_msgs::msg::DriveStatus::ConstSharedPtr msg) {
            motors_[msg->left.motor_id] = msg->left;
            motors_[msg->right.motor_id] = msg->right;
          }));
      sources_.push_back(topic);
    }
    for (const auto& topic : motor_feedback_topics) {
      motor_feedback_subs_.push_back(this->create_subscription<questix_msgs::msg::MotorFeedback>(
          topic, 10, [this](questix_msgs::msg::MotorFeedback::ConstSharedPtr msg) {
            motors_[msg->motor_id] = *msg;
          }));
      sources_.push_back(topic);
    }

    timer_ = this->create_wall_timer(std::chrono::duration<double>(1.0 / rate_hz),
                                     [this]() { render(); });
  }

private:
  void render() {
    double now_sec = this->now().seconds();
    std::string sources;
    for (size_t i = 0; i < sources_.size(); ++i) {
      sources += (i == 0 ? "" : ", ") + sources_[i];
    }

    std::string out = kAnsiCursorHome;
    out += "DDT motor feedback monitor  (sources: " + sources + ")\n";
    out += "Ctrl-C to quit. '!' = stale, '--' = no feedback yet.\n\n";
    out += tableHeader() + "\n";
    out += std::string(tableHeader().size(), '-') + "\n";
    if (motors_.empty()) {
      out += "(waiting for messages...)\n";
    } else {
      for (const auto& entry : motors_) {
        out += formatRow(entry.second, now_sec, stale_sec_, color_) + "\n";
      }
    }
    std::fputs(out.c_str(), stdout);
    std::fflush(stdout);
  }

  std::map<uint8_t, questix_msgs::msg::MotorFeedback> motors_;
  std::vector<rclcpp::Subscription<questix_msgs::msg::DriveStatus>::SharedPtr> drive_status_subs_;
  std::vector<rclcpp::Subscription<questix_msgs::msg::MotorFeedback>::SharedPtr>
      motor_feedback_subs_;
  std::vector<std::string> sources_;
  rclcpp::TimerBase::SharedPtr timer_;
  double stale_sec_ = 0.5;
  bool color_ = true;
};

}  // namespace motor_control_app

int main(int argc, char* argv[]) {
  rclcpp::init(argc, argv);
  auto node = std::make_shared<motor_control_app::DdtFeedbackMonitor>(rclcpp::NodeOptions());
  try {
    rclcpp::spin(node);
  } catch (const std::exception& e) {
    RCLCPP_ERROR(node->get_logger(), "Exception during execution: %s", e.what());
  }
  rclcpp::shutdown();
  // Restore terminal styling below the last rendered table.
  std::fputs(motor_control_app::kAnsiReset, stdout);
  std::fputs("\n", stdout);
  std::fflush(stdout);
  return 0;
}
