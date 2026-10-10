// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>

#include "esc_motor_control_cpp/esc_motor_control_component.hpp"

namespace esc_motor_control_cpp {
class LeaseOutput : public PwmBackend {
public:
  bool initialize(int) override { return true; }
  bool set_servo_pulse(int, int us) override {
    applied = us;
    return true;
  }
  bool stop_signal(int) override { return true; }
  int last_error() const override { return 0; }
  void cleanup() override {}
  std::string name() const override { return "rp1_hw"; }
  int applied{-1};
};
// Access only from this uninstalled test; no runtime override in production.
struct EscLeaseTestAccess {
  static void stale_lab(EscMotorControlComponent& node, std::unique_ptr<LeaseOutput> output) {
    node.pwm_ = std::move(output);
    node.pwm_backend_name_ = "rp1_hw";
    auto decision = node.roller_lab_logic_.onLab(0.6, node.steady_now_sec() - 2.0, false, false);
    ASSERT_TRUE(decision.apply);
    node.current_speed_ = decision.command;
  }
  static void renew(EscMotorControlComponent& node) { node.renew_pwm_lease(); }
};
TEST(Rp1Lease, RenewalExpiresLabWithoutRunningSeparateLabTimer) {
  rclcpp::init(0, nullptr, rclcpp::InitOptions(), rclcpp::SignalHandlerOptions::None);
  {
    rclcpp::NodeOptions options;
    options.append_parameter_override("test_mode", true);
    options.append_parameter_override("require_emergency_stop", false);
    options.append_parameter_override("accept_lab_input", true);
    EscMotorControlComponent node(options);
    auto output = std::make_unique<LeaseOutput>();
    auto* observed = output.get();
    EscLeaseTestAccess::stale_lab(node, std::move(output));
    // No executor spin: the unrelated lab timer cannot hide the renewal defect.
    EscLeaseTestAccess::renew(node);
    EXPECT_EQ(observed->applied, 1000);
  }
  rclcpp::shutdown();
}
}  // namespace esc_motor_control_cpp
