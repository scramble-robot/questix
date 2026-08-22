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

#include <memory>
#include <rclcpp/rclcpp.hpp>
#include <string>

#include "motor_control_app/drive_component.hpp"

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

}  // namespace

int main(int argc, char** argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}
