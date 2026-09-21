// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// 実行時パラメータ変更ポリシーのテスト。
//  - 即時反映できるチューニング系パラメータは成功する
//  - 再初期化が必要なパラメータは「拒否」される（受理して黙って無視すると
//    `ros2 param set` が成功を報告してしまい、変わっていないことに気付けない）
#include <gtest/gtest.h>

#include <limits>
#include <memory>
#include <rclcpp/rclcpp.hpp>
#include <string>
#include <vector>

#include "motor_control_app/drive_component.hpp"

namespace motor_control_app {
// Initialize parameter members without lifecycle configure or hardware access.
struct DriveParamPolicyAccess {
  static void initialize(DriveComponent& node) { node.readParameters(); }
  static std::vector<double> snapshot(const DriveComponent& n) {
    return {n.max_linear_accel_,
            n.max_angular_accel_,
            n.slew_taper_band_linear_,
            n.slew_taper_band_angular_,
            static_cast<double>(n.min_command_rpm_),
            n.cmd_timeout_sec_,
            static_cast<double>(n.brake_on_stop_),
            static_cast<double>(n.stop_resend_interval_ms_),
            n.measured_lpf_tau_sec_,
            static_cast<double>(n.command_wait_ms_),
            n.current_kp_,
            n.current_ki_,
            n.max_current_amp_,
            n.integral_limit_amp_,
            static_cast<double>(n.current_zero_deadband_rpm_),
            static_cast<double>(n.current_invert_measured_)};
  }
};
}  // namespace motor_control_app

namespace {

class DriveParamPolicyTest : public ::testing::Test {
protected:
  static void SetUpTestSuite() { rclcpp::init(0, nullptr); }
  static void TearDownTestSuite() { rclcpp::shutdown(); }

  void SetUp() override {
    rclcpp::NodeOptions options;
    // auto_start を切って lifecycle 遷移タイマーなしの素の状態でテストする
    options.append_parameter_override("auto_start", false);
    node_ = std::make_shared<motor_control_app::DriveComponent>(options);
    motor_control_app::DriveParamPolicyAccess::initialize(*node_);
  }

  std::shared_ptr<motor_control_app::DriveComponent> node_;
};

TEST_F(DriveParamPolicyTest, LiveTuningParametersAreAccepted) {
  EXPECT_TRUE(node_->set_parameter(rclcpp::Parameter("max_linear_accel", 2.5)).successful);
  EXPECT_TRUE(node_->set_parameter(rclcpp::Parameter("max_angular_accel", 2.5)).successful);
  EXPECT_TRUE(node_->set_parameter(rclcpp::Parameter("slew_taper_band_linear", 0.3)).successful);
  EXPECT_TRUE(node_->set_parameter(rclcpp::Parameter("min_command_rpm", 6)).successful);
  EXPECT_TRUE(node_->set_parameter(rclcpp::Parameter("cmd_timeout_sec", 0.5)).successful);
  EXPECT_TRUE(node_->set_parameter(rclcpp::Parameter("brake_on_stop", true)).successful);
  EXPECT_TRUE(node_->set_parameter(rclcpp::Parameter("stop_resend_interval_ms", 200)).successful);
}

TEST_F(DriveParamPolicyTest, CurrentPiGainsAreLiveTunable) {
  // Phase C（電流モード実機チューニング）の前提: PI ゲインが ros2 param set で反映される
  EXPECT_TRUE(node_->set_parameter(rclcpp::Parameter("current_kp", 0.002)).successful);
  EXPECT_TRUE(node_->set_parameter(rclcpp::Parameter("current_ki", 0.0001)).successful);
  EXPECT_TRUE(node_->set_parameter(rclcpp::Parameter("max_current_amp", 1.5)).successful);
  EXPECT_TRUE(node_->set_parameter(rclcpp::Parameter("integral_limit_amp", 0.4)).successful);
  EXPECT_TRUE(node_->set_parameter(rclcpp::Parameter("current_zero_deadband_rpm", 6)).successful);
  EXPECT_TRUE(node_->set_parameter(rclcpp::Parameter("current_invert_measured", false)).successful);
}

TEST_F(DriveParamPolicyTest, ReconfigureOnlyParametersAreRejected) {
  const auto result = node_->set_parameter(rclcpp::Parameter("control_rate", 100.0));
  EXPECT_FALSE(result.successful);
  // 拒否理由に復旧手順（YAML 編集 + 再起動）が含まれること
  EXPECT_NE(result.reason.find("restart"), std::string::npos);

  EXPECT_FALSE(node_->set_parameter(rclcpp::Parameter("max_motor_rpm", 400)).successful);
  EXPECT_FALSE(node_->set_parameter(rclcpp::Parameter("control_mode", "current")).successful);
  EXPECT_FALSE(node_->set_parameter(rclcpp::Parameter("wheel_radius", 0.2)).successful);
  EXPECT_FALSE(node_->set_parameter(rclcpp::Parameter("serial_port", "/dev/null")).successful);
  EXPECT_FALSE(node_->set_parameter(rclcpp::Parameter("auto_start", true)).successful);
}

TEST_F(DriveParamPolicyTest, RejectedParameterKeepsOldValue) {
  const double before = node_->get_parameter("control_rate").as_double();
  (void)node_->set_parameter(rclcpp::Parameter("control_rate", before + 50.0));
  EXPECT_DOUBLE_EQ(node_->get_parameter("control_rate").as_double(), before);
}

TEST_F(DriveParamPolicyTest, MixedRequestsAreAtomicInBothOrders) {
  const std::vector<rclcpp::Parameter> allowed = {
      rclcpp::Parameter("max_linear_accel", 9.0),
      rclcpp::Parameter("min_command_rpm", 15),
      rclcpp::Parameter("brake_on_stop", true),
      rclcpp::Parameter("command_wait_ms", 7),
      rclcpp::Parameter("stop_resend_interval_ms", 99),
      rclcpp::Parameter("measured_lpf_tau_sec", 0.9),
      rclcpp::Parameter("current_kp", 0.03),
      rclcpp::Parameter("current_ki", 0.04),
      rclcpp::Parameter("max_current_amp", 3.0),
      rclcpp::Parameter("integral_limit_amp", 2.0),
      rclcpp::Parameter("current_zero_deadband_rpm", 17),
      rclcpp::Parameter("current_invert_measured", false)};
  const auto members = motor_control_app::DriveParamPolicyAccess::snapshot(*node_);
  std::vector<rclcpp::Parameter> old;
  for (const auto& p : allowed) {
    old.push_back(node_->get_parameter(p.get_name()));
  }
  for (bool rejected_first : {false, true}) {
    auto request = allowed;
    request.insert(rejected_first ? request.begin() : request.end(),
                   rclcpp::Parameter("control_rate", 100.0));
    EXPECT_FALSE(node_->set_parameters_atomically(request).successful);
    EXPECT_EQ(motor_control_app::DriveParamPolicyAccess::snapshot(*node_), members);
    for (const auto& p : old) {
      EXPECT_EQ(node_->get_parameter(p.get_name()).get_parameter_value(), p.get_parameter_value());
    }
  }
  ASSERT_TRUE(node_->set_parameters_atomically(allowed).successful);
  EXPECT_NE(motor_control_app::DriveParamPolicyAccess::snapshot(*node_), members);
  for (const auto& p : allowed) {
    EXPECT_EQ(node_->get_parameter(p.get_name()).get_parameter_value(), p.get_parameter_value());
  }
  const auto committed = motor_control_app::DriveParamPolicyAccess::snapshot(*node_);
  EXPECT_DOUBLE_EQ(committed[0], 9.0);
  EXPECT_DOUBLE_EQ(committed[4], 15.0);
  EXPECT_DOUBLE_EQ(committed[10], 0.03);
  EXPECT_DOUBLE_EQ(committed[11], 0.04);
  EXPECT_DOUBLE_EQ(committed[12], 3.0);
  EXPECT_DOUBLE_EQ(committed[13], 2.0);
}

TEST_F(DriveParamPolicyTest, CurrentPiValidationRejectsWithoutSideEffects) {
  std::vector<rclcpp::Parameter> invalid;
  for (const auto& name : {"current_kp", "current_ki", "max_current_amp", "integral_limit_amp"}) {
    for (double value :
         {std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::infinity(),
          -std::numeric_limits<double>::infinity()}) {
      invalid.emplace_back(name, value);
    }
  }
  invalid.emplace_back("max_current_amp", -0.1);
  invalid.emplace_back("integral_limit_amp", -0.1);
  invalid.emplace_back("current_zero_deadband_rpm", -1);
  invalid.emplace_back("current_zero_deadband_rpm",
                       static_cast<int64_t>(std::numeric_limits<int>::max()) + 1);
  invalid.emplace_back("current_invert_measured", 1);
  const auto before = motor_control_app::DriveParamPolicyAccess::snapshot(*node_);
  for (const auto& bad : invalid) {
    const auto old = node_->get_parameter(bad.get_name()).get_parameter_value();
    EXPECT_FALSE(
        node_->set_parameters_atomically({rclcpp::Parameter("current_kp", 0.5), bad}).successful);
    EXPECT_EQ(motor_control_app::DriveParamPolicyAccess::snapshot(*node_), before);
    EXPECT_EQ(node_->get_parameter(bad.get_name()).get_parameter_value(), old);
  }
}

TEST_F(DriveParamPolicyTest, CurrentPiBoundariesAndExistingDisableSemantics) {
  EXPECT_TRUE(
      node_
          ->set_parameters_atomically(
              {rclcpp::Parameter("current_kp", -1.0), rclcpp::Parameter("current_ki", -2.0),
               rclcpp::Parameter("max_current_amp", 0.0),
               rclcpp::Parameter("integral_limit_amp", 0.0),
               rclcpp::Parameter("current_zero_deadband_rpm", std::numeric_limits<int>::max()),
               rclcpp::Parameter("current_invert_measured", true)})
          .successful);
  EXPECT_TRUE(node_->set_parameter(rclcpp::Parameter("current_zero_deadband_rpm", 0)).successful);
  for (const auto& name : {"command_wait_ms", "stop_resend_interval_ms", "min_command_rpm"}) {
    EXPECT_TRUE(node_->set_parameter(rclcpp::Parameter(name, -1)).successful);
    EXPECT_FALSE(node_
                     ->set_parameter(rclcpp::Parameter(
                         name, static_cast<int64_t>(std::numeric_limits<int>::max()) + 1))
                     .successful);
    EXPECT_FALSE(node_
                     ->set_parameter(rclcpp::Parameter(
                         name, static_cast<int64_t>(std::numeric_limits<int>::min()) - 1))
                     .successful);
  }
}

}  // namespace

int main(int argc, char** argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
