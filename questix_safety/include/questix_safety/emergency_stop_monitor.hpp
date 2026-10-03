// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

#ifndef QUESTIX_SAFETY__EMERGENCY_STOP_MONITOR_HPP_
#define QUESTIX_SAFETY__EMERGENCY_STOP_MONITOR_HPP_

#include <chrono>
#include <functional>
#include <mutex>
#include <questix_msgs/msg/emergency_stop.hpp>
#include <rclcpp/rclcpp.hpp>
#include <string>
#include <utility>

#include "questix_safety/estop_check.hpp"

// The one /emergency_stop check of the actuating nodes (drive_component, shot_component,
// esc_motor_control). It owns the parameters (emergency_stop_topic, require_emergency_stop,
// emergency_stop_timeout_sec), the subscription with the contract QoS (reliable + transient_local
// + keep-last(1), questix_msgs/README.md) and the receive state on the node's steady clock, and
// answers with estop_check.hpp's rule. What a node does about a change (stop the wheels, tear
// down the servo bus, zero the roller) stays in the node, through the callback.
//
// Thread-safe: the state has its own lock; the callback runs after it is released.
namespace questix_safety {

class EmergencyStopMonitor {
public:
  struct Settings {
    std::string topic{"/emergency_stop"};  // empty: not subscribed (unknown forever if required)
    bool required{true};                   // false only for an explicit diagnostic opt-out
    double timeout_sec{kDefaultEstopTimeoutSec};  // normalized: <= 0 disables staleness
  };

  // What changed with a received message, for the node's own edge handling.
  struct Change {
    bool first;       // the first message ever heard
    bool was_active;  // the previous message's active (true before the first one)
  };

  using Callback =
      std::function<void(const questix_msgs::msg::EmergencyStop& msg, const Change& change)>;
  using Clock = std::function<std::chrono::steady_clock::time_point()>;

  static rclcpp::QoS qos() { return rclcpp::QoS(1).reliable().transient_local(); }

  // Declares the three parameters (unless the node already did) and reads them.
  template <class NodeT>
  static Settings declareAndRead(NodeT& node) {
    if (!node.has_parameter("emergency_stop_topic")) {
      node.declare_parameter("emergency_stop_topic", std::string("/emergency_stop"));
    }
    if (!node.has_parameter("require_emergency_stop")) {
      node.declare_parameter("require_emergency_stop", true);
    }
    if (!node.has_parameter("emergency_stop_timeout_sec")) {
      node.declare_parameter("emergency_stop_timeout_sec", kDefaultEstopTimeoutSec);
    }
    Settings settings;
    settings.topic = node.get_parameter("emergency_stop_topic").as_string();
    settings.required = node.get_parameter("require_emergency_stop").as_bool();
    settings.timeout_sec = node.get_parameter("emergency_stop_timeout_sec").as_double();
    return settings;
  }

  // what: the node's actuator for the log lines ("drive", "launcher", "roller").
  template <class NodeT>
  EmergencyStopMonitor(NodeT& node, Settings settings, const std::string& what,
                       Callback on_message = {}, Clock clock = &std::chrono::steady_clock::now)
      : logger_(node.get_logger()),
        settings_(std::move(settings)),
        on_message_(std::move(on_message)),
        clock_(std::move(clock)) {
    if (!std::isfinite(settings_.timeout_sec)) {
      RCLCPP_WARN(logger_, "Invalid emergency_stop_timeout_sec=%g; using the default %.1f seconds",
                  settings_.timeout_sec, kDefaultEstopTimeoutSec);
      settings_.timeout_sec = normalizeEstopTimeout(settings_.timeout_sec);
    }
    if (!settings_.topic.empty()) {
      subscription_ = node.template create_subscription<questix_msgs::msg::EmergencyStop>(
          settings_.topic, qos(), [this](const questix_msgs::msg::EmergencyStop::SharedPtr msg) {
            if (msg) {
              receive(*msg);
            }
          });
    } else if (settings_.required) {
      RCLCPP_ERROR(logger_,
                   "emergency_stop_topic is empty but require_emergency_stop=true: the %s will "
                   "never move (set require_emergency_stop:=false only for a diagnostic run)",
                   what.c_str());
    }
    if (!settings_.required) {
      RCLCPP_WARN(logger_,
                  "require_emergency_stop=false (diagnostic opt-out): the %s may move before "
                  "/emergency_stop is heard. Never use this in an integrated launch",
                  what.c_str());
    }
  }

  EmergencyStopMonitor(const EmergencyStopMonitor&) = delete;
  EmergencyStopMonitor& operator=(const EmergencyStopMonitor&) = delete;

  // Records a message and tells the node (the subscription calls this; tests may too).
  void receive(const questix_msgs::msg::EmergencyStop& msg) {
    Change change{};
    {
      std::lock_guard<std::mutex> lock(mutex_);
      change.first = !known_;
      change.was_active = active_;
      known_ = true;
      active_ = msg.active;
      last_rx_ = clock_();
      last_source_ = msg.source;
      last_reason_ = msg.reason;
    }
    if (on_message_) {
      on_message_(msg, change);
    }
  }

  EstopInputs inputs() const {
    std::lock_guard<std::mutex> lock(mutex_);
    EstopInputs in;
    in.required = settings_.required;
    in.known = known_;
    in.active = active_;
    in.age_sec = known_ ? std::chrono::duration<double>(clock_() - last_rx_).count() : 0.0;
    in.timeout_sec = settings_.timeout_sec;
    return in;
  }

  EstopState state() const { return evaluateEstop(inputs()); }
  bool engaged() const { return questix_safety::engaged(state()); }

  bool heard() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return known_;
  }
  // The last message's active (true before the first one).
  bool active() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return active_;
  }
  // Seconds since the last message on the steady clock (0 before the first one).
  double ageSec() const { return inputs().age_sec; }
  std::string lastSource() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return last_source_;
  }
  std::string lastReason() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return last_reason_;
  }

  // Stops listening (node shutdown). The state stays, so it goes stale like a silent publisher.
  void unsubscribe() { subscription_.reset(); }

  const Settings& settings() const { return settings_; }
  const std::string& topic() const { return settings_.topic; }
  bool required() const { return settings_.required; }
  double timeoutSec() const { return settings_.timeout_sec; }

private:
  rclcpp::Logger logger_;
  Settings settings_;
  Callback on_message_;
  Clock clock_;
  rclcpp::Subscription<questix_msgs::msg::EmergencyStop>::SharedPtr subscription_;

  mutable std::mutex mutex_;
  bool known_{false};
  bool active_{true};
  std::chrono::steady_clock::time_point last_rx_{};
  std::string last_source_;
  std::string last_reason_;
};

}  // namespace questix_safety

#endif  // QUESTIX_SAFETY__EMERGENCY_STOP_MONITOR_HPP_
