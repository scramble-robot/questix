// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// ShotComponent: motion permission and E-stop, launcher commands (/launcher_command) and the
// shot sequence (see shot_component.cpp for how the class is split).
#include <algorithm>
#include <chrono>
#include <cmath>
#include <exception>
#include <functional>
#include <lifecycle_msgs/msg/state.hpp>
#include <limits>
#include <string>

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
    endStartup();
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
  // ここでは待たない（サーボの接続・応答確認はこのコールバックの外、試行期間の短い周期で
  // 行う）。同期で configure すると、通電直後のサーボ無応答の間 /emergency_stop の受信処理が
  // 止まり、自分の途絶判定が発火していた（issue #175）。
  requestStartup();
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
    endStartup();
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

actuation_gate::Block ShotComponent::permissionBlock() const {
  // 走行許可（L2）だけを見る（非常停止は estopBlocks() が別の概念として扱う）。
  return actuation_gate::evaluatePermission(permission_monitor_->inputs());
}

void ShotComponent::onMotionPermission(const questix_msgs::msg::MotionPermission& msg,
                                       const questix_safety::PermissionMonitor::Change& change) {
  if (change.first || change.was_allowed != msg.launcher_allowed) {
    RCLCPP_INFO(this->get_logger(), "Motion permission (%s): launcher %s", msg.mode.c_str(),
                msg.launcher_allowed ? "allowed" : "not allowed");
  }
  applyPermission();  // a change is handled at once, not at the next 100 ms check
}

void ShotComponent::applyPermission() {
  try {
    const auto block = permissionBlock();
    const bool allowed = block == actuation_gate::Block::kNone;
    if (allowed == permission_was_allowed_) {
      return;
    }
    permission_was_allowed_ = allowed;
    if (!allowed) {
      // 以後の射撃・チルトは断る（その間に届いた指令は捨て、許可が戻っても後から動かさない）。
      pending_tilt_ = false;
      // 電源は入ったままなのでサーボバスは保持する（ACTIVE のまま。非常停止とは違い teardown
      // しない）。 射撃中ならシーケンスを止めて home
      // に戻す。起動途中なら試行期間を終える（許可で再開）。
      cancelShotSequence();
      endStartup();
      const auto blockers = permission_monitor_->lastBlockers();
      std::string reasons;
      for (const auto& reason : blockers) {
        reasons += (reasons.empty() ? "" : ", ") + reason;
      }
      RCLCPP_WARN(this->get_logger(),
                  "Launcher motion permission lost (%s%s%s): fire and tilt refused, servo bus "
                  "kept (not an emergency stop)",
                  actuation_gate::blockName(block), reasons.empty() ? "" : ": ", reasons.c_str());
      publishShotStatus();
      return;
    }
    RCLCPP_INFO(this->get_logger(),
                "Launcher motion permission granted (a new press or request is needed to move)");
    publishShotStatus();
    if (this->get_current_state().id() != lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE) {
      requestStartup();  // 待たずに戻る（接続・応答確認は試行期間の短い周期で行う）
    }
  } catch (const std::exception& error) {
    RCLCPP_ERROR(this->get_logger(), "Motion permission check failed: %s", error.what());
  } catch (...) {
    RCLCPP_ERROR(this->get_logger(), "Motion permission check failed with unknown exception");
  }
}

bool ShotComponent::readyToMove() {
  // 走行許可なし、または非常停止（押下・途絶・未受信）: 射撃もチルトもしない。
  return this->get_current_state().id() == lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE &&
         servo_controller_ && servo_controller_->isConnected() &&
         permissionBlock() == actuation_gate::Block::kNone && !estopBlocks();
}

void ShotComponent::commandCallback(const questix_msgs::msg::LauncherCommand::SharedPtr msg) {
  if (!msg) {
    return;
  }
  LauncherEvents::Command command;
  command.tilt_deg = msg->tilt_deg;
  command.tilt_steps = msg->tilt_steps;
  command.fire_seq = msg->fire_seq;
  // Every message advances the counters, also while the launcher may not move: what arrives then
  // is dropped here and never replayed later.
  const auto events = launcher_events_.onCommand(command, steadyNowSec());
  if (events.tilt_target) {
    pending_tilt_ = true;
    pending_tilt_deg_ = events.tilt_deg;
  }
  if (!readyToMove()) {
    pending_tilt_ = false;
    if (events.fire || events.tilt_steps != 0) {
      RCLCPP_INFO_THROTTLE(this->get_logger(), *this->get_clock(), 2000,
                           "Launcher command ignored: not active, no motion permission or "
                           "emergency stop");
    }
    return;
  }
  if (events.fire) {
    const double wait = nextFireInSec(steadyNowSec(), last_fire_sec_, min_fire_interval_sec_);
    if (is_shooting_) {
      RCLCPP_INFO(this->get_logger(), "Fire refused: a shot is still moving");
    } else if (wait > 0.0) {
      RCLCPP_INFO(this->get_logger(), "Fire refused: %.1f s until the next shot", wait);
    } else {
      executeShotSequence(fireSourceOf(msg->source));
    }
  }
  if (events.tilt_steps != 0) {
    moveTiltTo(current_tilt_angle_ + events.tilt_steps * tilt_step_angle_,
               events.tilt_steps > 0 ? "up" : "down");
  }
  applyPendingTilt();
}

void ShotComponent::applyPendingTilt() {
  if (!pending_tilt_ || !canSendCommand()) {
    return;  // kept for the next command (the publishers repeat them while in use)
  }
  pending_tilt_ = false;
  moveTiltTo(pending_tilt_deg_, "to target");
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
  RCLCPP_ERROR(
      this->get_logger(), "Failed to move tilt %s (%s)", label,
      motor_control_lib::FeetechServoController::resultName(servo_controller_->lastResult()));
  triggerAutoRecovery();
  return false;
}

double ShotComponent::steadyNowSec() {
  return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

void ShotComponent::publishShotStatus() {
  if (!shot_status_pub_) {
    return;
  }
  ShotStatus status;
  status.tilt_deg = current_tilt_angle_;
  status.shooting = is_shooting_;
  status.fired_count = fired_count_;
  status.last_fire_source = last_fire_source_;
  status.estop = estopBlocks();
  status.permission = permissionBlock() == actuation_gate::Block::kNone;
  status.active =
      this->get_current_state().id() == lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE;
  status.tilt_min_deg = tilt_min_angle_;
  status.tilt_max_deg = tilt_max_angle_;
  status.next_fire_in_sec = nextFireInSec(steadyNowSec(), last_fire_sec_, min_fire_interval_sec_);
  std_msgs::msg::String msg;
  msg.data = shotStatusJson(status);
  shot_status_pub_->publish(msg);
}

void ShotComponent::executeShotSequence(FireSource source) {
  if (is_shooting_) {
    return;  // 既に射撃中の場合は無視
  }

  RCLCPP_INFO(this->get_logger(), "Starting shot sequence...");

  // 1. 射撃位置に移動
  int fire_position = angleToServoPosition(fire_angle_);
  if (!servo_controller_->setPosition(trigger_servo_id_, fire_position, false)) {
    RCLCPP_ERROR(
        this->get_logger(), "Failed to move to fire position (%s)",
        motor_control_lib::FeetechServoController::resultName(servo_controller_->lastResult()));
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
