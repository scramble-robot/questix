// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#ifndef QUESTIX_SAFETY__PERMISSION_MONITOR_HPP_
#define QUESTIX_SAFETY__PERMISSION_MONITOR_HPP_

#include <chrono>
#include <cmath>
#include <functional>
#include <mutex>
#include <questix_msgs/msg/motion_permission.hpp>
#include <rclcpp/rclcpp.hpp>
#include <string>
#include <utility>
#include <vector>

#include "questix_safety/permission_check.hpp"

// The one /motion_permission check of the actuating nodes (drive_component: the drive flag;
// shot_component and esc_motor_control: the launcher flag). It owns the parameters
// (motion_permission_topic, require_motion_permission, motion_permission_timeout_sec), the
// subscription with the contract QoS (reliable + volatile + keep-last(1), questix_msgs/README.md)
// and the receive state on the node's steady clock, and answers with permission_check.hpp's rule.
// What a node does about a change (stop the wheels, refuse fire and tilt, zero the roller) stays
// in the node, through the callback.
//
// A permission is not an emergency stop: EmergencyStopMonitor is a separate check, and a node
// that has both judges the permission first and the E-stop last (the E-stop wins when both block).
//
// Thread-safe: the state has its own lock; the callback runs after it is released.
namespace questix_safety {

class PermissionMonitor {
public:
  // Which flag of questix_msgs/MotionPermission this node obeys.
  enum class Flag { kDrive, kLauncher };

  struct Settings {
    std::string topic{"/motion_permission"};  // empty: not subscribed (unknown forever if required)
    bool required{true};                      // false only for an explicit diagnostic opt-out
    double timeout_sec{kDefaultPermissionTimeoutSec};  // normalized: always a positive lease
  };

  // What changed with a received message, for the node's own edge handling.
  struct Change {
    bool first;        // the first message ever heard
    bool was_allowed;  // the previous message's flag (false before the first one)
  };

  using Callback =
      std::function<void(const questix_msgs::msg::MotionPermission& msg, const Change& change)>;
  using Clock = std::function<std::chrono::steady_clock::time_point()>;

  // Never transient_local: a permission must not be latched (questix_msgs/README.md).
  static rclcpp::QoS qos() { return rclcpp::QoS(1).reliable().durability_volatile(); }

  // Declares the three parameters (unless the node already did) and reads them.
  template <class NodeT>
  static Settings declareAndRead(NodeT& node) {
    if (!node.has_parameter("motion_permission_topic")) {
      node.declare_parameter("motion_permission_topic", std::string("/motion_permission"));
    }
    if (!node.has_parameter("require_motion_permission")) {
      node.declare_parameter("require_motion_permission", true);
    }
    if (!node.has_parameter("motion_permission_timeout_sec")) {
      node.declare_parameter("motion_permission_timeout_sec", kDefaultPermissionTimeoutSec);
    }
    Settings settings;
    settings.topic = node.get_parameter("motion_permission_topic").as_string();
    settings.required = node.get_parameter("require_motion_permission").as_bool();
    settings.timeout_sec = node.get_parameter("motion_permission_timeout_sec").as_double();
    return settings;
  }

  // what: the node's actuator for the log lines ("drive", "launcher", "roller").
  template <class NodeT>
  PermissionMonitor(NodeT& node, Settings settings, Flag flag, const std::string& what,
                    Callback on_message = {}, Clock clock = &std::chrono::steady_clock::now)
      : logger_(node.get_logger()),
        settings_(std::move(settings)),
        flag_(flag),
        on_message_(std::move(on_message)),
        clock_(std::move(clock)) {
    const double requested = settings_.timeout_sec;
    settings_.timeout_sec = permissionLease(requested);
    if (settings_.timeout_sec != requested) {
      RCLCPP_WARN(logger_,
                  "Invalid motion_permission_timeout_sec=%g; using the default %.1f seconds (a "
                  "permission always expires)",
                  requested, kDefaultPermissionTimeoutSec);
    }
    if (!settings_.topic.empty()) {
      subscription_ = node.template create_subscription<questix_msgs::msg::MotionPermission>(
          settings_.topic, qos(), [this](const questix_msgs::msg::MotionPermission::SharedPtr msg) {
            if (msg) {
              receive(*msg);
            }
          });
    } else if (settings_.required) {
      RCLCPP_ERROR(logger_,
                   "motion_permission_topic is empty but require_motion_permission=true: the %s "
                   "will never move (set require_motion_permission:=false only for a diagnostic "
                   "run)",
                   what.c_str());
    }
    if (!settings_.required) {
      RCLCPP_WARN(logger_,
                  "require_motion_permission=false (diagnostic opt-out): the %s moves without "
                  "/motion_permission (no referee, no teacher). Never use this in an integrated "
                  "launch",
                  what.c_str());
    }
  }

  PermissionMonitor(const PermissionMonitor&) = delete;
  PermissionMonitor& operator=(const PermissionMonitor&) = delete;

  // Records a message and tells the node (the subscription calls this; tests may too).
  void receive(const questix_msgs::msg::MotionPermission& msg) {
    Change change{};
    {
      std::lock_guard<std::mutex> lock(mutex_);
      change.first = !known_;
      change.was_allowed = allowed_;
      known_ = true;
      allowed_ = flagOf(msg);
      last_rx_ = clock_();
      last_mode_ = msg.mode;
      last_blockers_ = flag_ == Flag::kDrive ? msg.drive_blockers : msg.launcher_blockers;
    }
    if (on_message_) {
      on_message_(msg, change);
    }
  }

  PermissionInputs inputs() const {
    std::lock_guard<std::mutex> lock(mutex_);
    PermissionInputs in;
    in.required = settings_.required;
    in.known = known_;
    in.allowed = allowed_;
    in.age_sec = known_ ? std::chrono::duration<double>(clock_() - last_rx_).count() : 0.0;
    in.timeout_sec = settings_.timeout_sec;
    return in;
  }

  PermissionState state() const { return evaluatePermission(inputs()); }
  bool blocks() const { return questix_safety::blocks(state()); }

  bool heard() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return known_;
  }
  // The last message's flag (false before the first one).
  bool allowed() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return allowed_;
  }
  // Seconds since the last message on the steady clock (0 before the first one).
  double ageSec() const { return inputs().age_sec; }
  // The running mode the last message reported ("" before the first one). Display only.
  std::string lastMode() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return last_mode_;
  }
  // Why the last message said "not allowed" for this node's flag. Display only.
  std::vector<std::string> lastBlockers() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return last_blockers_;
  }

  // Stops listening (node shutdown). The state stays, so it goes stale like a silent publisher.
  void unsubscribe() { subscription_.reset(); }

  const Settings& settings() const { return settings_; }
  const std::string& topic() const { return settings_.topic; }
  bool required() const { return settings_.required; }
  double timeoutSec() const { return settings_.timeout_sec; }
  Flag flag() const { return flag_; }

private:
  bool flagOf(const questix_msgs::msg::MotionPermission& msg) const {
    return flag_ == Flag::kDrive ? msg.drive_allowed : msg.launcher_allowed;
  }

  rclcpp::Logger logger_;
  Settings settings_;
  Flag flag_;
  Callback on_message_;
  Clock clock_;
  rclcpp::Subscription<questix_msgs::msg::MotionPermission>::SharedPtr subscription_;

  mutable std::mutex mutex_;
  bool known_{false};
  bool allowed_{false};
  std::chrono::steady_clock::time_point last_rx_{};
  std::string last_mode_;
  std::vector<std::string> last_blockers_;
};

}  // namespace questix_safety

#endif  // QUESTIX_SAFETY__PERMISSION_MONITOR_HPP_
