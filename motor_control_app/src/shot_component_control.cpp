// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// ShotComponent: E-stop and teacher permission, controller input, QUESTiX LAB requests and
// the shot sequence (see shot_component.cpp for how the class is split).
#include <algorithm>
#include <chrono>
#include <cmath>
#include <exception>
#include <functional>
#include <lifecycle_msgs/msg/state.hpp>
#include <limits>
#include <string>
#include <thread>

#include "motor_control_app/shot_angle.hpp"
#include "motor_control_app/shot_auto_start.hpp"
#include "motor_control_app/shot_component.hpp"

namespace motor_control_app {

void ShotComponent::onEmergencyStop(const questix_msgs::msg::EmergencyStop& msg,
                                    const questix_safety::EmergencyStopMonitor::Change& change) {
  const bool first = change.first;
  // 途絶で teardown した後は押下扱いだったので、解除の受信はエッジとして扱う。
  const bool recovered = estop_timed_out_;
  const bool prev = recovered || change.was_active;
  estop_timed_out_ = false;
  if (recovered) {
    RCLCPP_INFO(this->get_logger(), "%s reception recovered", estop_monitor_->topic().c_str());
  }
  if (!first && msg.active == prev) {
    return;  // 値に変化なし（評価毎に配信されるため、エッジのみ処理する）
  }

  if (msg.active) {
    // 非常停止押下。サーボバスが断たれるため、ACTIVE / 自動起動途中の INACTIVE は
    // 解体してサーボ接続を解放し、unconfigured で解除を待つ。
    // 手動 deactivate 済み（タイマー停止中）のノードは操作者の制御を尊重して触らない。
    const uint8_t state_id = this->get_current_state().id();
    if (state_id == lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE) {
      RCLCPP_WARN(this->get_logger(),
                  "非常停止押下を検出（source=%s, reason=%s）。"
                  "deactivate→cleanup してサーボ接続を解放します",
                  msg.source.c_str(), msg.reason.c_str());
      transitionToUnconfiguredForAutoRecovery("emergency_stop active");
    } else if (state_id == lifecycle_msgs::msg::State::PRIMARY_STATE_INACTIVE &&
               auto_start_timer_ && !auto_start_timer_->is_canceled()) {
      RCLCPP_WARN(this->get_logger(),
                  "非常停止押下を検出（source=%s, reason=%s）。cleanup してサーボ接続を解放します",
                  msg.source.c_str(), msg.reason.c_str());
      transitionToUnconfiguredForAutoRecovery("emergency_stop active");
    }
    return;
  }

  // 非常停止解除（または初回受信が解除状態）。タイマー停止中は手動運用
  // （手動 deactivate 済み or 正常 ACTIVE）なので自動遷移しない。
  if (!auto_start_timer_ || auto_start_timer_->is_canceled()) {
    return;
  }
  if (!first) {
    RCLCPP_INFO(this->get_logger(), "非常停止解除を検出（source=%s）。起動シーケンスを開始します",
                msg.source.c_str());
  }
  // 周期を仕切り直してから即時試行する。失敗時（サーボ起動中など）は
  // connect_retry_period_sec 周期のリトライに引き継ぐ。
  auto_start_timer_->reset();
  try {
    tryAutoStart();
  } catch (const std::exception& error) {
    RCLCPP_ERROR(this->get_logger(), "E-stop release auto-start failed: %s", error.what());
  } catch (...) {
    RCLCPP_ERROR(this->get_logger(), "E-stop release auto-start failed with unknown exception");
  }
}

void ShotComponent::emergencyStopTimeoutCallback() {
  try {
    const double timeout_sec = estop_monitor_->timeoutSec();
    if (estop_timed_out_ || timeout_sec <= 0.0 || !estop_monitor_->heard()) {
      return;
    }
    const double elapsed = estop_monitor_->ageSec();
    if (!shot_auto_start::isControllableSignalStale(timeout_sec, !estop_monitor_->active(),
                                                    elapsed)) {
      return;
    }
    // ACTIVEでは通常運転到達時にtimerがcancel済みでもfail-safe teardownする。
    // INACTIVE/UNCONFIGUREDかつcancel済みはmanual lifecycle操作として尊重し、latchせず
    // 再評価を続ける（hold中にlatchすると、その後の手動activateでstale信号のまま
    // ACTIVEになってもfail-safe teardownが二度と発動しないため）。
    const uint8_t state_id = this->get_current_state().id();
    const bool timer_canceled = !auto_start_timer_ || auto_start_timer_->is_canceled();
    if (shot_auto_start::shouldHoldManualLifecycle(state_id, timer_canceled)) {
      return;
    }
    estop_timed_out_ = true;  // 次の受信まで押下扱い（estopBlocks）
    RCLCPP_WARN(this->get_logger(),
                "%s reception timed out after %.2fs; applying fail-safe teardown",
                estop_monitor_->topic().c_str(), elapsed);
    transitionToUnconfiguredForAutoRecovery("emergency_stop timeout");
  } catch (const std::exception& error) {
    RCLCPP_ERROR(this->get_logger(), "Emergency stop timeout callback failed: %s", error.what());
  } catch (...) {
    RCLCPP_ERROR(this->get_logger(),
                 "Emergency stop timeout callback failed with unknown exception");
  }
}

bool ShotComponent::estopBlocks() const {
  // 共通のチェック（押下・未受信・途絶）に、途絶 teardown のラッチ（次の受信まで）を加える。
  // ラッチ（手動 lifecycle 中は保留される）に頼らず、途絶そのものは monitor が見る。
  return estop_timed_out_ || estop_monitor_->engaged();
}

actuation_gate::Block ShotComponent::teacherPermissionBlock() const {
  // 教員の許可だけを見る（非常停止は estopBlocks() が別の概念として扱う）。無効なら何も見ない。
  if (!require_teacher_permission_) {
    return actuation_gate::Block::kNone;
  }
  actuation_gate::TeacherPermissionInputs in;
  in.required = true;
  in.known = have_teacher_permission_msg_;
  in.allowed = teacher_permission_launcher_allowed_;
  in.age_sec = have_teacher_permission_msg_
                   ? std::chrono::duration<double>(std::chrono::steady_clock::now() -
                                                   last_teacher_permission_rx_)
                         .count()
                   : 0.0;
  in.timeout_sec = teacher_permission_timeout_sec_;
  return actuation_gate::evaluateTeacherPermission(in);
}

void ShotComponent::teacherPermissionCallback(
    const questix_msgs::msg::ActuationAuthority::SharedPtr msg) {
  if (!msg) {
    return;
  }
  have_teacher_permission_msg_ = true;
  teacher_permission_launcher_allowed_ = msg->launcher_allowed;
  last_teacher_permission_rx_ = std::chrono::steady_clock::now();
  // OFF への変化はタイマーを待たずに処理する。
  if (!msg->launcher_allowed && teacher_permission_was_allowed_) {
    teacherPermissionTimerCallback();
  }
}

void ShotComponent::teacherPermissionTimerCallback() {
  try {
    const auto block = teacherPermissionBlock();
    const bool allowed = block == actuation_gate::Block::kNone;
    if (allowed == teacher_permission_was_allowed_) {
      return;
    }
    teacher_permission_was_allowed_ = allowed;
    if (!allowed) {
      // 以後の射撃・チルトは断る。押しっぱなしの入力は、許可が戻っても離すまで無視する。
      last_button_state_ = true;
      tilt_edges_.requireRelease();
      const uint8_t state_id = this->get_current_state().id();
      RCLCPP_WARN(this->get_logger(),
                  "Launcher teacher permission lost (%s): stopping the launcher (not an emergency "
                  "stop)",
                  actuation_gate::blockName(block));
      if (auto_start_timer_ && (state_id == lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE ||
                                (state_id == lifecycle_msgs::msg::State::PRIMARY_STATE_INACTIVE &&
                                 !auto_start_timer_->is_canceled()))) {
        // 非常停止と同じ安全 teardown（射撃中なら home に戻してサーボ接続を解放）。
        transitionToUnconfiguredForAutoRecovery("teacher permission off");
      } else if (state_id == lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE) {
        cancelShotSequence();  // 手動運用: lifecycle は操作者に任せ、動作中の射撃だけ止める
      }
      publishShotStatus();
      return;
    }
    RCLCPP_INFO(this->get_logger(),
                "Launcher teacher permission granted: starting up (a new press or request is "
                "needed to move)");
    publishShotStatus();
    if (auto_start_timer_ && !auto_start_timer_->is_canceled()) {
      auto_start_timer_->reset();
      tryAutoStart();
    }
  } catch (const std::exception& error) {
    RCLCPP_ERROR(this->get_logger(), "Teacher permission check failed: %s", error.what());
  } catch (...) {
    RCLCPP_ERROR(this->get_logger(), "Teacher permission check failed with unknown exception");
  }
}

void ShotComponent::joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg) {
  // Record controller use of the launcher (fire button, tilt input) for the QUESTiX LAB quiet
  // rule before any early return: a held button blocks lab requests in every state.
  if (msg &&
      shot_lab::joyUsesLauncher(msg->buttons, msg->axes, fire_button_,
                                {tilt_up_axis_, tilt_up_axis_sign_, tilt_up_button_index_},
                                {tilt_down_axis_, tilt_down_axis_sign_, tilt_down_button_index_})) {
    joy_launcher_active_at_sec_ = steadyNowSec();
  }
  if (this->get_current_state().id() != lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE) {
    return;
  }
  if (!servo_controller_ || !servo_controller_->isConnected()) {
    return;
  }
  if (!msg || msg->buttons.empty()) {
    return;
  }
  // 非常停止（押下・途絶・未受信）または実行時許可なし: 射撃もチルトもしない。押されている
  // 入力は、動かせるようになってから一度離すまで使わない。
  if (estopBlocks() || teacherPermissionBlock() != actuation_gate::Block::kNone) {
    last_button_state_ = true;
    tilt_edges_.requireRelease();
    return;
  }

  // 射撃ボタンの処理
  if (!is_shooting_ && fire_button_ >= 0 && fire_button_ < static_cast<int>(msg->buttons.size())) {
    bool current_button_state = msg->buttons[fire_button_] == 1;

    // ボタンが押された瞬間を検出（立ち上がりエッジ）
    if (current_button_state && !last_button_state_) {
      executeShotSequence(shot_lab::FireSource::kJoy);
    }

    last_button_state_ = current_button_state;
  }

  const auto step_tilt = [this](double delta_deg, const char* direction) {
    moveTiltTo(current_tilt_angle_ + delta_deg, direction);
  };

  const bool up = tiltInputPressed(msg->axes, msg->buttons, tilt_up_axis_, tilt_up_axis_sign_,
                                   tilt_up_button_index_);
  const bool down = tiltInputPressed(msg->axes, msg->buttons, tilt_down_axis_, tilt_down_axis_sign_,
                                     tilt_down_button_index_);
  const int direction = tilt_edges_.update(up, down);
  if (direction != 0) {
    step_tilt(direction * tilt_step_angle_, direction > 0 ? "up" : "down");
  }
}

bool ShotComponent::moveTiltTo(double angle_deg, const char* label) {
  if (!servo_controller_) {
    return false;
  }
  if (!canSendCommand()) {
    RCLCPP_DEBUG(this->get_logger(), "Tilt command rate limited");
    return false;
  }
  current_tilt_angle_ = clampAngle(angle_deg);
  current_tilt_position_ = angleToServoPosition(current_tilt_angle_);
  if (servo_controller_->setPosition(tilt_servo_id_, current_tilt_position_, false)) {
    RCLCPP_INFO(this->get_logger(), "Tilt %s: angle=%.1f deg", label, current_tilt_angle_);
    last_command_time_ = this->now();
    publishShotStatus();
    return true;
  }
  RCLCPP_ERROR(this->get_logger(), "Failed to move tilt %s", label);
  triggerAutoRecovery();
  return false;
}

double ShotComponent::steadyNowSec() {
  return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

shot_lab::Conditions ShotComponent::labConditions() {
  shot_lab::Conditions conditions;
  conditions.accept = accept_lab_input_;
  // The latest /emergency_stop, its silence, and (require_emergency_stop) never having heard it.
  conditions.estop = estopBlocks();
  conditions.authority = teacherPermissionBlock() == actuation_gate::Block::kNone;
  conditions.active =
      this->get_current_state().id() == lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE &&
      servo_controller_ && servo_controller_->isConnected();
  conditions.shooting = is_shooting_;
  conditions.now_sec = steadyNowSec();
  conditions.joy_active_at_sec = joy_launcher_active_at_sec_;
  conditions.joy_quiet_sec = lab_joy_quiet_sec_;
  return conditions;
}

void ShotComponent::recordLabRefusal(shot_lab::Refusal refusal, const char* request) {
  RCLCPP_INFO_THROTTLE(this->get_logger(), *this->get_clock(), 2000, "QUESTiX LAB %s refused: %s",
                       request, shot_lab::refusalName(refusal));
  if (last_lab_refusal_ != refusal) {
    last_lab_refusal_ = refusal;
    publishShotStatus();
  }
}

void ShotComponent::labTiltCallback(const std_msgs::msg::Float32::SharedPtr msg) {
  if (!msg) {
    return;
  }
  const auto decision =
      shot_lab::decideTilt(labConditions(), msg->data, tilt_min_angle_, tilt_max_angle_);
  if (decision.refusal != shot_lab::Refusal::kNone) {
    recordLabRefusal(decision.refusal, "tilt");
    return;
  }
  if (!canSendCommand()) {
    recordLabRefusal(shot_lab::Refusal::kRateLimited, "tilt");
    return;
  }
  last_lab_refusal_ = shot_lab::Refusal::kNone;
  moveTiltTo(decision.target_deg, "lab");
}

void ShotComponent::labFireCallback(const std_msgs::msg::Empty::SharedPtr msg) {
  if (!msg) {
    return;
  }
  const auto refusal =
      shot_lab::decideFire(labConditions(), last_fire_sec_, lab_min_fire_interval_sec_);
  if (refusal != shot_lab::Refusal::kNone) {
    recordLabRefusal(refusal, "fire");
    return;
  }
  last_lab_refusal_ = shot_lab::Refusal::kNone;
  RCLCPP_INFO(this->get_logger(), "QUESTiX LAB fire request accepted");
  executeShotSequence(shot_lab::FireSource::kLab);
}

void ShotComponent::publishShotStatus() {
  if (!shot_status_pub_) {
    return;
  }
  shot_lab::Status status;
  status.tilt_deg = current_tilt_angle_;
  status.shooting = is_shooting_;
  status.fired_count = fired_count_;
  status.last_fire_source = last_fire_source_;
  status.lab_accepted = accept_lab_input_;
  status.estop = estopBlocks();
  status.authority = teacherPermissionBlock() == actuation_gate::Block::kNone;
  status.active =
      this->get_current_state().id() == lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE;
  status.tilt_min_deg = tilt_min_angle_;
  status.tilt_max_deg = tilt_max_angle_;
  status.next_fire_in_sec =
      shot_lab::nextFireInSec(steadyNowSec(), last_fire_sec_, lab_min_fire_interval_sec_);
  status.lab_refused = last_lab_refusal_;
  std_msgs::msg::String msg;
  msg.data = shot_lab::statusJson(status);
  shot_status_pub_->publish(msg);
}

void ShotComponent::executeShotSequence(shot_lab::FireSource source) {
  if (is_shooting_) {
    return;  // 既に射撃中の場合は無視
  }

  RCLCPP_INFO(this->get_logger(), "Starting shot sequence...");

  // 1. 射撃位置に移動
  int fire_position = angleToServoPosition(fire_angle_);
  if (!servo_controller_->setPosition(trigger_servo_id_, fire_position, false)) {
    RCLCPP_ERROR(this->get_logger(), "Failed to move to fire position");
    triggerAutoRecovery();
    return;
  }
  RCLCPP_INFO(this->get_logger(), "Moved to fire position (%.1f deg)", fire_angle_);

  // 2. sleep で executor をブロックせず、ワンショットタイマーで home 復帰する。
  //    is_shooting_ は home 復帰完了（fireTimerCallback）まで保持して多重発射を防ぐ。
  is_shooting_ = true;
  last_fire_sec_ = steadyNowSec();
  ++fired_count_;
  last_fire_source_ = source;
  fire_timer_ = this->create_wall_timer(std::chrono::milliseconds(fire_duration_ms_),
                                        std::bind(&ShotComponent::fireTimerCallback, this));
  publishShotStatus();
}

void ShotComponent::fireTimerCallback() {
  // ワンショット動作: 初回発火で止めて破棄する
  if (fire_timer_) {
    fire_timer_->cancel();
    fire_timer_.reset();
  }

  // ホーム位置に戻る
  int home_position = angleToServoPosition(home_angle_);
  if (servo_controller_ &&
      servo_controller_->setPosition(trigger_servo_id_, home_position, false)) {
    RCLCPP_INFO(this->get_logger(), "Returned to home position (%.1f deg)", home_angle_);
  } else {
    RCLCPP_ERROR(this->get_logger(), "Failed to return to home position");
    triggerAutoRecovery();
  }

  is_shooting_ = false;
  RCLCPP_INFO(this->get_logger(), "Shot sequence completed");
  publishShotStatus();
}

void ShotComponent::cancelShotSequence() {
  // deactivate/解体経路でシーケンス中だった場合の後始末。タイマーを止め、
  // サーボが生きていれば best-effort で home に戻す（失敗してもログのみ。
  // on_deactivate は runtime_fault_ をクリアするため復帰トリガは出さない）。
  if (fire_timer_) {
    fire_timer_->cancel();
    fire_timer_.reset();
  }
  if (is_shooting_) {
    int home_position = angleToServoPosition(home_angle_);
    if (servo_controller_ && servo_controller_->isConnected() &&
        servo_controller_->setPosition(trigger_servo_id_, home_position, false)) {
      RCLCPP_INFO(this->get_logger(), "Shot sequence cancelled, returned to home position");
    } else {
      RCLCPP_WARN(this->get_logger(),
                  "Shot sequence cancelled, home return skipped or failed（通電断の可能性）");
    }
    is_shooting_ = false;
  }
}

// 角度制限関数
double ShotComponent::clampAngle(double angle_deg) {
  return shot_angle::clampAngle(angle_deg, tilt_min_angle_, tilt_max_angle_);
}

// コマンド送信レート制限チェック
bool ShotComponent::canSendCommand() {
  auto now = this->now();
  auto elapsed = (now - last_command_time_).nanoseconds() / 1000000;  // ミリ秒に変換
  return elapsed >= command_rate_limit_ms_;
}

// 角度からサーボ位置への変換（角度 -> 0-4095）
int ShotComponent::angleToServoPosition(double angle_deg) {
  return shot_angle::angleToServoPosition(angle_deg);
}

// サーボ位置から角度への変換（0-4095 -> 角度）
double ShotComponent::servoPositionToAngle(int position) {
  return shot_angle::servoPositionToAngle(position);
}

}  // namespace motor_control_app
