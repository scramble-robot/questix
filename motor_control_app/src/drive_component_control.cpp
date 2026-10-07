// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// DriveComponent: motor library, control loop, E-stop / teacher permission gate, status
// and odometry (see drive_component.cpp for how the class is split).
#include <algorithm>
#include <chrono>
#include <cmath>
#include <exception>
#include <filesystem>
#include <functional>
#include <lifecycle_msgs/msg/state.hpp>
#include <limits>
#include <stdexcept>

#include "motor_control_app/drive_component.hpp"
#include "motor_control_app/drive_control_tick.hpp"
#include "motor_control_app/drive_slew.hpp"
#include "motor_control_app/lifecycle_auto_start.hpp"
#include "motor_control_app/motor_status_msg.hpp"

using namespace std::chrono_literals;

namespace motor_control_app {

namespace {
// 未武装（駆動指令を送っていない）間にフィードバック快照の鮮度を維持するポーリング周期の
// 目安 [s]。この鮮度以内なら再取得しない（≈5Hz）。odometry::kMaxFeedbackAgeSec（stale 判定）
// より十分小さくすること。
constexpr double kIdleFeedbackMaxAgeSec = 0.2;

// 停止指令を送れなかったとき（stop fault）の再送間隔 [s]。
constexpr double kStopRetryPeriodSec = 0.5;

double secondsSince(std::chrono::steady_clock::time_point then,
                    std::chrono::steady_clock::time_point now) {
  return std::chrono::duration<double>(now - then).count();
}
}  // namespace

bool DriveComponent::initializeMotorLib() {
  try {
    // DDTモータライブラリのインスタンスを作成
    motor_lib_ = std::make_shared<motor_control_lib::DdtMotorLib>(serial_port_, baud_rate_);

    // 最大RPMを設定
    if (!motor_lib_->setMaxRpm(max_motor_rpm_)) {
      RCLCPP_ERROR(this->get_logger(), "Failed to set max RPM");
      return false;
    }

    // 停止時の電気ブレーキ設定（velocity モードのみ有効）
    motor_lib_->setBrakeOnStop(brake_on_stop_);

    // ファーム側加速時間（velocity モードのみ有効）。実機評価で 1 に確定:
    // 1 より大きくすると高RPM の直進が乱れる。加速プロファイルの整形はホスト側の
    // スルーレート制限（max_*_accel + slew_taper_band_*）に一本化し、ファーム側の
    // 平滑化は実質無効（1 = 0.1ms/rpm）で固定する。パラメータとしては公開しない
    // （二重の加速プロファイルがチューニングを非直交にしていたため廃止）。
    constexpr int kFirmwareAccelTime0p1msPerRpm = 1;
    motor_lib_->setAccelTime(kFirmwareAccelTime0p1msPerRpm);

    // 指令送信後の追加待機（既定 0 = 無効）
    motor_lib_->setCommandWaitMs(command_wait_ms_);

    // 停止継続中のブレーキ再送間隔（停止直後の持続振動の緩和用）
    motor_lib_->setStopResendIntervalMs(stop_resend_interval_ms_);

    // 実測RPMローパス（フィードバック速度のノイズ平滑化。レポート/オドメトリ経路のみ）
    motor_lib_->setMeasuredLowpassTau(measured_lpf_tau_sec_);

    // モータライブラリを初期化（シリアルポートを開く。未通電なら失敗して再試行に回る）
    if (!motor_lib_->initialize()) {
      return false;
    }

    // 制御モード判定
    motor_control_lib::ControlMode mode = motor_control_lib::ControlMode::Velocity;
    if (control_mode_ == "current") {
      mode = motor_control_lib::ControlMode::Current;
      motor_lib_->setCurrentControlParams(current_kp_, current_ki_, max_current_amp_,
                                          integral_limit_amp_);
      motor_lib_->setCurrentZeroDeadbandRpm(current_zero_deadband_rpm_);
      motor_lib_->setCurrentInvertMeasured(current_invert_measured_);
    } else if (control_mode_ != "velocity") {
      RCLCPP_WARN(this->get_logger(), "未知の control_mode '%s' - velocity モードにフォールバック",
                  control_mode_.c_str());
    }

    // 個別モーターを初期化
    if (!motor_lib_->initializeMotor(left_motor_id_, mode) ||
        !motor_lib_->initializeMotor(right_motor_id_, mode)) {
      RCLCPP_ERROR(this->get_logger(), "Failed to initialize individual motors");
      return false;
    }

    // 差動駆動コントローラーを作成
    diff_drive_ = std::make_unique<motor_control_lib::DifferentialDrive>(
        motor_lib_, left_motor_id_, right_motor_id_, wheel_radius_, wheel_separation_);

    // 低速不感帯（ファーム速度ループが低速域で振動するため、その領域を指令しない）。
    // 通常経路の判定は control_core_ が行うが、自己完結パス（setVelocity）でも同じ
    // 不感帯が効くように両方へ設定する。
    diff_drive_->setMinCommandRpm(min_command_rpm_);

    // ホスト側の制御コア（スルーレート・運動学・停止判定）を構築する。
    control_core_ = std::make_unique<control_core::ControlCore>(makeControlCoreConfig());

    motor_initialized_ = true;
    RCLCPP_INFO(this->get_logger(), "Motor library initialized successfully");
    return true;

  } catch (const std::exception& e) {
    RCLCPP_ERROR(this->get_logger(), "Exception during motor initialization: %s", e.what());
    return false;
  }
}

void DriveComponent::shutdownMotorLib() {
  if (motor_lib_ && motor_initialized_) {
    RCLCPP_INFO(this->get_logger(), "Shutting down motor library");
    if (diff_drive_) {
      (void)diff_drive_->stopNow();
    }
    motor_lib_->emergencyStop();
    motor_lib_->shutdown();
  }
  control_core_.reset();
  diff_drive_.reset();
  motor_lib_.reset();
  motor_initialized_ = false;
}

void DriveComponent::resetCommandState() {
  // 武装解除（制御 tick は次の /target_twist まで駆動指令を送らない）+
  // 制御コアのリセット（次の駆動は 0 からのランプ、停止モードから再開）。
  has_target_ = false;
  target_linear_ = 0.0;
  target_angular_ = 0.0;
  if (control_core_) {
    control_core_->reset();
  }
}

void DriveComponent::resetOdometry() {
  odom_publisher_.reset();
  tf_broadcaster_.reset();
  odom_pose_ = {};
  has_last_odom_time_ = false;
}

void DriveComponent::twistCallback(const geometry_msgs::msg::Twist::SharedPtr msg) {
  // inactive 中の twist は無視する（lifecycle activate 後にのみ駆動する）
  if (this->get_current_state().id() != lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE) {
    return;
  }

  // 非常停止中・E-stop 不明/途絶・実行時許可なし・stop fault の間は目標を保存しない
  // （開いた後もモータは停止のまま、開いた後に届いた次の指令で再開）。
  const auto block = actuation_gate::evaluate(gateInputs());
  if (block != actuation_gate::Block::kNone) {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                         "Actuation blocked (%s), ignoring twist command",
                         actuation_gate::blockName(block));
    return;
  }

  // 制御実行は controlTimerCallback（固定周期の制御 tick）に集約されている。ここでは
  // 最新目標の保存のみを行い、シリアル I/O もスルーレート計算もしない。これにより
  // 制御周期（= スルーレートの dt）が上流の publish レートやメッセージ取りこぼしから
  // 独立する（従来は /target_twist の到着間隔が dt だった）。
  target_linear_ = msg->linear.x;
  target_angular_ = msg->angular.z;
  last_cmd_time_ = this->now();
  has_target_ = true;
}

void DriveComponent::controlTimerCallback() {
  const auto tick_start = std::chrono::steady_clock::now();

  // control_core_ は diff_drive_ と同じライフサイクル（initializeMotorLib で構築、
  // shutdownMotorLib で破棄）だが、kDrive 経路で参照するため準備判定に含める。
  const bool motor_ready = motor_initialized_ && diff_drive_ != nullptr && control_core_ != nullptr;

  // 停止指令を送れなかった後は、両輪へのゼロ送信が成功するまで一定間隔で再送する
  // （成功しても停止のまま。次の /target_twist で初めて動く）。
  if (stop_fault_ && motor_ready) {
    const auto now_steady = std::chrono::steady_clock::now();
    if (actuation_gate::shouldRetryStop(stop_fault_, secondsSince(last_stop_attempt_, now_steady),
                                        kStopRetryPeriodSec)) {
      last_stop_attempt_ = now_steady;
      if (diff_drive_->stopNow()) {
        stop_fault_ = false;
        RCLCPP_INFO(this->get_logger(),
                    "Stop fault cleared: zero sent to both wheels (still stopped until the next "
                    "command)");
      } else {
        RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                              "Stop fault: zero could not be sent yet, retrying every %.1fs",
                              kStopRetryPeriodSec);
      }
    }
  }

  // E-stop・実行時許可・stop fault のゲート。閉じたら停止 + 武装解除（applyGate）。
  const auto block = applyGate();

  const double elapsed = has_target_ ? (this->now() - last_cmd_time_).seconds() : 0.0;
  // isHealthy はキャッシュ済みフィードバックの fault コードを見るだけでシリアルには触らない
  const bool healthy = motor_ready && diff_drive_->isHealthy();

  switch (drive_control_tick::decideTickAction(has_target_, motor_ready,
                                               block != actuation_gate::Block::kNone, healthy,
                                               elapsed, cmd_timeout_sec_)) {
    case drive_control_tick::TickAction::kIdle:
      // 未武装（起動直後・タイムアウト/非常停止/フォールト停止後）またはゲートが閉じている。
      // 駆動指令は送らないが、フィードバックが古ければ低頻度で再取得する（外力で車輪が回された
      // 場合の観測と /drive_status の鮮度のため）。再取得が送るのは送信に成功したゼロだけで、
      // 非ゼロの再送はしない（DdtMotorLib::refreshMotorFeedback）。押下を受信している間と
      // stop fault の間（再送は上で行う）は送らない。
      if (motor_ready && motor_lib_ && block != actuation_gate::Block::kEstopActive &&
          block != actuation_gate::Block::kStopFault) {
        motor_lib_->refreshMotorFeedback(left_motor_id_, kIdleFeedbackMaxAgeSec);
        motor_lib_->refreshMotorFeedback(right_motor_id_, kIdleFeedbackMaxAgeSec);
      }
      return;
    case drive_control_tick::TickAction::kTimeoutStop:
      RCLCPP_WARN(this->get_logger(),
                  "Command timeout: no /target_twist for %.2fs (limit %.2fs), stopping motors",
                  elapsed, cmd_timeout_sec_);
      // safetyStop は各ホイールへスロットル無しでゼロを送り（電流PI積分状態もリセット）、
      // 武装解除する（WARN はイベント毎に1回）。次の /target_twist で自動的に再武装し、
      // スルーレートクランプもゼロから再スタートする。送れなければ stop fault。
      safetyStop("command timeout");
      return;
    case drive_control_tick::TickAction::kFaultStop:
      // モータ異常中は最後の指令を保持せず、明示的に停止指令を送って武装解除する。
      safetyStop("motor fault");
      RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                           "Motor not healthy: sending stop command");
      return;
    case drive_control_tick::TickAction::kDrive:
      break;
  }

  // ホスト側の制御コアで 1 ステップ進める（スルーレート制限 -> 運動学 -> 停止判定）。
  // dt は固定周期の定数なので、実効加速度プロファイルが上流の publish レートに依存しない。
  // 制御則の詳細は control_core.hpp / drive_slew.hpp を参照。
  const double dt = drive_control_tick::tickDtSec(control_rate_);

  // 実測車輪 RPM（生値、モータフレーム）を制御コアへ渡す。RUN 域 LQR+FF（velocity モード、
  // 有効時のみ）が使う。両輪のフィードバックが新鮮でなければ valid=false = FF のみ（従来挙動）。
  control_core::WheelFeedback feedback;
  if (motor_lib_) {
    motor_control_lib::DdtMotorLib::MotorFeedbackData left_fb, right_fb;
    const bool got = motor_lib_->getMotorFeedbackData(left_motor_id_, left_fb) &&
                     motor_lib_->getMotorFeedbackData(right_motor_id_, right_fb);
    if (got && left_fb.has_feedback && right_fb.has_feedback &&
        left_fb.feedback_age_sec <= velocity_run_feedback_max_age_sec_ &&
        right_fb.feedback_age_sec <= velocity_run_feedback_max_age_sec_) {
      feedback.valid = true;
      feedback.left_rpm = left_fb.velocity_rpm_raw;
      feedback.right_rpm = right_fb.velocity_rpm_raw;
    }
  }
  const auto out = control_core_->step(target_linear_, target_angular_, dt, feedback);

  // 指令送信（応答フレームでフィードバック快照も更新される）。停止判定は制御コアが
  // 済ませているため、送信先は停止指令か生の車輪 RPM のどちらかになる。
  const bool sent =
      out.stop ? diff_drive_->commandStop() : diff_drive_->setWheelRpm(out.left_rpm, out.right_rpm);
  if (!sent) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 1000,
                          "Failed to set motor velocity");
    return;
  }

  RCLCPP_DEBUG(this->get_logger(),
               "Command sent: linear=%.3f, angular=%.3f -> left=%d RPM (ref %d), right=%d RPM "
               "(ref %d), mode=%s, lqr=%s",
               out.linear, out.angular, out.left_rpm, out.left_ref_rpm, out.right_rpm,
               out.right_ref_rpm, motor_control_lib::drive_mode_fsm::toString(out.mode),
               out.lqr_active ? "on" : "off");

  // tick 所要時間の監視。シリアル応答待ち（最悪 10ms × 2）が周期予算を超えると
  // 制御周期が崩れるため、超過を可視化する（実機での control_rate 選定の材料）。
  const double tick_ms =
      std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - tick_start)
          .count();
  if (tick_ms > dt * 1000.0) {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                         "Control tick overrun: %.1f ms > budget %.1f ms (control_rate=%.1f)",
                         tick_ms, dt * 1000.0, control_rate_);
  }
}

void DriveComponent::onEmergencyStop(const questix_msgs::msg::EmergencyStop& msg,
                                     const questix_safety::EmergencyStopMonitor::Change& change) {
  // 未受信の間は押下扱い（was_active=true）。受信状態そのものは estop_monitor_ が持つ。
  const bool was_active = change.was_active;

  const bool motor_ready = motor_initialized_ && diff_drive_ != nullptr;
  bool stopped_now = false;
  switch (drive_watchdog::decideEstopAction(was_active, msg.active, motor_ready)) {
    case drive_watchdog::EstopAction::kStopNow:
      RCLCPP_WARN(this->get_logger(), "非常停止を受信 (source=%s, reason=%s)。モータを停止します",
                  msg.source.c_str(), msg.reason.c_str());
      // スロットル無しの即時停止 + 目標破棄。物理非常停止でモータ電源が落ちている場合は
      // シリアル書込みが失敗し得る。その場合は stop fault として閉じたまま再送する
      // （teardown へはエスカレートしない。デバイス消失は既存の configure リトライ経路）。
      safetyStop("emergency stop");
      stopped_now = true;
      break;
    case drive_watchdog::EstopAction::kClear:
      RCLCPP_INFO(this->get_logger(),
                  "非常停止が解除されました (source=%s)。twist 受付を再開します"
                  "（モータは次の指令まで停止のまま）",
                  msg.source.c_str());
      break;
    case drive_watchdog::EstopAction::kNone:
      if (msg.active && !was_active) {
        RCLCPP_WARN(this->get_logger(),
                    "非常停止を受信 (source=%s, reason=%s)。モータ未初期化のため指令なし",
                    msg.source.c_str(), msg.reason.c_str());
      }
      break;
  }
  // 途絶からの復帰・未受信からの初回受信を含め、ゲートの状態を更新する（開いても動かない）。
  applyGate(stopped_now);
}

void DriveComponent::teacherPermissionCallback(
    const questix_msgs::msg::ActuationAuthority::SharedPtr msg) {
  have_teacher_permission_msg_ = true;
  teacher_permission_drive_allowed_ = msg->drive_allowed;
  last_teacher_permission_rx_ = std::chrono::steady_clock::now();
  // OFF への変化は制御 tick を待たずに停止する（ON への変化は何も動かさない）。
  applyGate();
}

actuation_gate::EstopInputs DriveComponent::estopInputs() const { return estop_monitor_->inputs(); }

actuation_gate::TeacherPermissionInputs DriveComponent::teacherPermissionInputs() const {
  actuation_gate::TeacherPermissionInputs in;
  in.required = require_teacher_permission_;
  if (!require_teacher_permission_) {
    return in;  // disabled: nothing else is looked at
  }
  in.known = have_teacher_permission_msg_;
  in.allowed = teacher_permission_drive_allowed_;
  in.age_sec = have_teacher_permission_msg_
                   ? secondsSince(last_teacher_permission_rx_, std::chrono::steady_clock::now())
                   : 0.0;
  in.timeout_sec = teacher_permission_timeout_sec_;
  return in;
}

actuation_gate::Inputs DriveComponent::gateInputs() const {
  actuation_gate::Inputs in;
  in.estop = estopInputs();
  in.teacher_permission = teacherPermissionInputs();
  in.stop_fault = stop_fault_;
  return in;
}

bool DriveComponent::estopEngaged() const {
  // Only the E-stop: the teacher's permission is a permission and never reads as an E-stop.
  return estop_monitor_->engaged();
}

actuation_gate::Block DriveComponent::applyGate(bool stopped_now) {
  const auto block = actuation_gate::evaluate(gateInputs());
  const auto action = actuation_gate::decideGateAction(last_block_, block, has_target_);
  if (block != last_block_) {
    if (block == actuation_gate::Block::kNone) {
      RCLCPP_INFO(this->get_logger(),
                  "Actuation allowed again (was %s); the drive stays stopped until a new command",
                  actuation_gate::blockName(last_block_));
    } else {
      RCLCPP_WARN(this->get_logger(), "Actuation blocked: %s (was %s)",
                  actuation_gate::blockName(block), actuation_gate::blockName(last_block_));
    }
  }
  last_block_ = block;
  if (action == actuation_gate::GateAction::kSafetyStop && !stopped_now) {
    safetyStop(actuation_gate::blockName(block));
  }
  return block;
}

bool DriveComponent::safetyStop(const char* reason) {
  // 目標は送信の成否によらず必ず破棄する（古い目標を後で復活させない）。
  resetCommandState();
  if (!motor_initialized_ || !diff_drive_) {
    return false;  // 送る相手がない（未通電・未構成）。駆動指令も出ていない
  }
  last_stop_attempt_ = std::chrono::steady_clock::now();
  if (diff_drive_->stopNow()) {
    return true;
  }
  if (!stop_fault_) {
    RCLCPP_ERROR(this->get_logger(),
                 "Stop fault (%s): the zero command could not be sent to both wheels. Actuation "
                 "stays closed and the zero is retried every %.1fs",
                 reason, kStopRetryPeriodSec);
  }
  stop_fault_ = true;
  return false;
}

void DriveComponent::statusTimerCallback() {
  if (!motor_initialized_ || !diff_drive_) {
    return;
  }

  try {
    // 制御 tick（controlTimerCallback）が取り込んだフィードバック快照を読んで publish する
    // だけで、シリアルには触らない。走行中は tick の指令応答で control_rate 周期の実測が
    // 得られる。未武装（アイドル）中の鮮度維持は tick 側の低頻度ポーリングが担う。
    auto status = diff_drive_->getDriveStatus();

    // 型付きステータス（questix_msgs/DriveStatus）を publish
    rclcpp::Time now = this->now();
    motor_control_lib::DdtMotorLib::MotorFeedbackData left_fb, right_fb;
    motor_lib_->getMotorFeedbackData(left_motor_id_, left_fb);
    motor_lib_->getMotorFeedbackData(right_motor_id_, right_fb);

    questix_msgs::msg::DriveStatus typed_msg;
    typed_msg.header.stamp = now;
    typed_msg.left = toMotorFeedbackMsg(left_fb, now);
    typed_msg.right = toMotorFeedbackMsg(right_fb, now);
    typed_msg.linear_velocity = status.current_linear_velocity;
    typed_msg.angular_velocity = status.current_angular_velocity;
    // 非常停止として扱っている間（押下・未受信・途絶）は true。実行時許可の有無とは別。
    typed_msg.emergency_stop = estopEngaged();
    typed_status_publisher_->publish(typed_msg);

    // 左右両輪のフィードバックが新鮮なときのみ実測 twist を積分する。stale（非常停止・
    // 未通電を含む）なら twist ゼロ扱いで積分せず、現在ポーズで publish を継続する。
    const bool feedback_fresh =
        odometry::isFeedbackFresh(left_fb.has_feedback, left_fb.feedback_age_sec,
                                  odometry::kMaxFeedbackAgeSec) &&
        odometry::isFeedbackFresh(right_fb.has_feedback, right_fb.feedback_age_sec,
                                  odometry::kMaxFeedbackAgeSec);
    publishOdometry(status.current_linear_velocity, status.current_angular_velocity, feedback_fresh,
                    now);

    RCLCPP_DEBUG(this->get_logger(), "Current velocity: linear=%.3f, angular=%.3f",
                 status.current_linear_velocity, status.current_angular_velocity);

  } catch (const std::exception& e) {
    RCLCPP_ERROR_THROTTLE(this->get_logger(), *this->get_clock(), 5000,
                          "Exception in status timer callback: %s", e.what());
  }
}

void DriveComponent::publishOdometry(double linear, double angular, bool feedback_fresh,
                                     const rclcpp::Time& now) {
  if (!odom_publisher_) {
    return;
  }

  // 初回（activate 直後）は時刻アンカーのみ設定し、現在ポーズ・ゼロ twist で publish する。
  if (has_last_odom_time_) {
    const double dt = (now - last_odom_time_).seconds();
    if (odometry::isValidDt(dt, odometry::kMaxOdomDtSec)) {
      // stale なら twist ゼロ扱いで積分しない（stale RPM によるポーズドリフト防止）。
      const double eff_linear = feedback_fresh ? linear : 0.0;
      const double eff_angular = feedback_fresh ? angular : 0.0;
      odom_pose_ = odometry::integrate(odom_pose_, eff_linear, eff_angular, dt);
    }
    // dt が無効（<=0 または kMaxOdomDtSec 超過）ならこのサンプルは積分せず再アンカーのみ。
  }
  last_odom_time_ = now;
  has_last_odom_time_ = true;

  // publish に載せる twist は stale 時ゼロ（ポーズと整合させ、下流の誤積分を防ぐ）。
  const double reported_linear = feedback_fresh ? linear : 0.0;
  const double reported_angular = feedback_fresh ? angular : 0.0;
  const odometry::YawQuaternion q = odometry::yawToQuaternion(odom_pose_.theta);

  nav_msgs::msg::Odometry odom;
  odom.header.stamp = now;
  odom.header.frame_id = odom_frame_id_;
  odom.child_frame_id = base_frame_id_;
  odom.pose.pose.position.x = odom_pose_.x;
  odom.pose.pose.position.y = odom_pose_.y;
  odom.pose.pose.position.z = 0.0;
  odom.pose.pose.orientation.x = 0.0;
  odom.pose.pose.orientation.y = 0.0;
  odom.pose.pose.orientation.z = q.z;
  odom.pose.pose.orientation.w = q.w;
  odom.twist.twist.linear.x = reported_linear;
  odom.twist.twist.angular.z = reported_angular;

  // 固定共分散（issue 指定）。z/roll/pitch は非観測、vy は非ホロノミックで非観測。
  odom.pose.covariance[0] = 0.01;    // x
  odom.pose.covariance[7] = 0.01;    // y
  odom.pose.covariance[14] = 1e6;    // z
  odom.pose.covariance[21] = 1e6;    // roll
  odom.pose.covariance[28] = 1e6;    // pitch
  odom.pose.covariance[35] = 0.05;   // yaw
  odom.twist.covariance[0] = 0.01;   // vx
  odom.twist.covariance[7] = 1e6;    // vy
  odom.twist.covariance[14] = 1e6;   // vz
  odom.twist.covariance[21] = 1e6;   // wx
  odom.twist.covariance[28] = 1e6;   // wy
  odom.twist.covariance[35] = 0.05;  // wz
  odom_publisher_->publish(odom);

  // odom->base_link TF（Odometry と同一 stamp / フレーム）。
  if (publish_tf_ && tf_broadcaster_) {
    geometry_msgs::msg::TransformStamped tf;
    tf.header.stamp = now;
    tf.header.frame_id = odom_frame_id_;
    tf.child_frame_id = base_frame_id_;
    tf.transform.translation.x = odom_pose_.x;
    tf.transform.translation.y = odom_pose_.y;
    tf.transform.translation.z = 0.0;
    tf.transform.rotation.x = 0.0;
    tf.transform.rotation.y = 0.0;
    tf.transform.rotation.z = q.z;
    tf.transform.rotation.w = q.w;
    tf_broadcaster_->sendTransform(tf);
  }
}

}  // namespace motor_control_app
