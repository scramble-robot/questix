// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// ShotComponent: auto start, auto recovery, safety teardown and lifecycle transitions
// (see shot_component.cpp for how the class is split).
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

void ShotComponent::autoStartTimerCallback() {
  try {
    const uint8_t state_id = this->get_current_state().id();
    const bool runtime_fault = runtime_fault_.load();
    const bool teardown_pending = teardown_pending_.load();
    if ((runtime_fault || teardown_pending) &&
        (state_id == lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE ||
         state_id == lifecycle_msgs::msg::State::PRIMARY_STATE_INACTIVE)) {
      if (runtime_fault) {
        RCLCPP_WARN(this->get_logger(),
                    "サーボ通信故障を検出。deactivate→cleanup して再接続を試みます");
      } else {
        RCLCPP_WARN(this->get_logger(),
                    "未完了の安全teardownを検出。deactivate/cleanupを再試行します");
      }
      transitionToUnconfiguredForAutoRecovery(runtime_fault ? "runtime fault"
                                                            : "pending safety teardown");
      return;
    }
    if (teardown_pending && (state_id == lifecycle_msgs::msg::State::PRIMARY_STATE_UNCONFIGURED ||
                             state_id == lifecycle_msgs::msg::State::PRIMARY_STATE_FINALIZED)) {
      handleSafetyTeardownState("pending safety teardown", state_id);
      if (state_id == lifecycle_msgs::msg::State::PRIMARY_STATE_FINALIZED) {
        return;
      }
    }
    tryAutoStart();
  } catch (const std::exception& error) {
    RCLCPP_ERROR(this->get_logger(), "Shot auto-start callback failed: %s", error.what());
  } catch (...) {
    RCLCPP_ERROR(this->get_logger(), "Shot auto-start callback failed with unknown exception");
  }
}

void ShotComponent::tryAutoStart() {
  using shot_auto_start::AutoStartAction;
  using shot_auto_start::decideAutoStartAction;

  if (!auto_start_timer_) {
    return;
  }
  // 非常停止（押下・途絶・未受信）または実行時許可なしの間は configure/activate しない。
  const auto hold = [this]() {
    return estopBlocks() || teacherPermissionBlock() != actuation_gate::Block::kNone;
  };
  uint8_t state_id = this->get_current_state().id();
  auto action = decideAutoStartAction(state_id, true, !hold());
  if (action == AutoStartAction::kWaitEstopRelease) {
    if (estopBlocks()) {
      RCLCPP_INFO_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                           "非常停止中（または状態不明）のため接続試行を保留しています"
                           "（解除で自動再開します）");
    } else {
      RCLCPP_INFO_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                           "発射機構の操作が許可されていないため接続試行を保留しています (%s)",
                           actuation_gate::blockName(teacherPermissionBlock()));
    }
    return;
  }
  if (action == AutoStartAction::kStopTimer) {
    auto_start_timer_->cancel();
    return;
  }
  if (action == AutoStartAction::kNone) {
    if (!shot_auto_start::isTransitionState(state_id)) {
      RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                           "Unexpected lifecycle state during shot auto-start: %u",
                           static_cast<unsigned int>(state_id));
    }
    return;
  }
  if (action == AutoStartAction::kConfigure) {
    RCLCPP_INFO_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                         "サーボ接続を試行します（非常停止中は失敗し、解除後に自動復帰します）");
    state_id = this->configure().id();
    // 接続に成功したら同一周期内で activate まで進める（非常停止解除エッジからの
    // 即時起動と、タイマー経路の起動を同じ動きにする）
    action = decideAutoStartAction(state_id, true, !hold());
  }
  if (action == AutoStartAction::kActivate) {
    state_id = this->activate().id();
    action = decideAutoStartAction(state_id, true, !hold());
  }
  if (action == AutoStartAction::kStopTimer) {
    auto_start_timer_->cancel();
  } else if (action == AutoStartAction::kNone && !shot_auto_start::isTransitionState(state_id) &&
             state_id != lifecycle_msgs::msg::State::PRIMARY_STATE_UNCONFIGURED) {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                         "Shot auto-start transition ended in unexpected state: %u",
                         static_cast<unsigned int>(state_id));
  }
}

void ShotComponent::transitionToUnconfiguredForAutoRecovery(const char* reason) noexcept {
  if (!auto_start_timer_) {
    return;
  }
  uint8_t state_id = lifecycle_msgs::msg::State::PRIMARY_STATE_UNKNOWN;
  try {
    state_id = this->get_current_state().id();
    if (state_id == lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE) {
      state_id = this->deactivate().id();
    }
    if (state_id == lifecycle_msgs::msg::State::PRIMARY_STATE_INACTIVE) {
      state_id = this->cleanup().id();
    }
  } catch (const std::exception& error) {
    RCLCPP_ERROR(this->get_logger(), "%s teardown transition failed: %s", reason, error.what());
    state_id = currentStateIdOrUnknown(reason);
  } catch (...) {
    RCLCPP_ERROR(this->get_logger(), "%s teardown transition failed with unknown exception",
                 reason);
    state_id = currentStateIdOrUnknown(reason);
  }
  handleSafetyTeardownState(reason, state_id);
}

uint8_t ShotComponent::currentStateIdOrUnknown(const char* reason) noexcept {
  try {
    return this->get_current_state().id();
  } catch (...) {
    RCLCPP_ERROR(this->get_logger(), "%s teardown state inspection failed", reason);
    return lifecycle_msgs::msg::State::PRIMARY_STATE_UNKNOWN;
  }
}

void ShotComponent::handleSafetyTeardownState(const char* reason, uint8_t state_id) noexcept {
  using shot_auto_start::SafetyTeardownAction;
  // noexcept でも null deref は catch できないため、呼び出し規約に頼らずここで守る。
  if (!auto_start_timer_) {
    return;
  }
  try {
    switch (shot_auto_start::decideSafetyTeardownAction(state_id)) {
      case SafetyTeardownAction::kResetRetry:
        runtime_fault_ = false;
        teardown_pending_ = false;
        auto_start_timer_->reset();
        return;
      case SafetyTeardownAction::kRetryDeactivate:
        teardown_pending_ = true;
        auto_start_timer_->reset();
        RCLCPP_WARN(this->get_logger(),
                    "%s teardown left ShotComponent ACTIVE; deactivate retry armed", reason);
        return;
      case SafetyTeardownAction::kRetryCleanup:
        teardown_pending_ = true;
        auto_start_timer_->reset();
        RCLCPP_WARN(this->get_logger(),
                    "%s teardown left ShotComponent INACTIVE; cleanup retry armed", reason);
        return;
      case SafetyTeardownAction::kStopTimers:
        runtime_fault_ = false;
        teardown_pending_ = false;
        stopAutoStartTimers();
        return;
      case SafetyTeardownAction::kNone:
        if (!shot_auto_start::isTransitionState(state_id)) {
          RCLCPP_WARN(this->get_logger(), "%s teardown ended in unexpected state: %u", reason,
                      static_cast<unsigned int>(state_id));
        }
        return;
    }
  } catch (const std::exception& error) {
    RCLCPP_ERROR(this->get_logger(), "%s teardown follow-up failed: %s", reason, error.what());
  } catch (...) {
    RCLCPP_ERROR(this->get_logger(), "%s teardown follow-up failed with unknown exception", reason);
  }
}

void ShotComponent::stopAutoStartTimers() {
  if (auto_start_timer_) {
    auto_start_timer_->cancel();
  }
  if (emergency_stop_timeout_timer_) {
    emergency_stop_timeout_timer_->cancel();
  }
}

ShotComponent::CallbackReturn ShotComponent::on_configure(const rclcpp_lifecycle::State&) {
  std::string port = this->get_parameter("port").as_string();
  int baudrate = this->get_parameter("baudrate").as_int();
  tilt_servo_id_ = this->get_parameter("tilt_servo_id").as_int();
  trigger_servo_id_ = this->get_parameter("trigger_servo_id").as_int();
  fire_button_ = this->get_parameter("fire_button").as_int();
  const int legacy_tilt_axis = this->get_parameter("tilt_axis").as_int();
  tilt_up_axis_ = this->get_parameter("tilt_up_axis").as_int();
  tilt_down_axis_ = this->get_parameter("tilt_down_axis").as_int();
  if (tilt_up_axis_ == -2) tilt_up_axis_ = legacy_tilt_axis;
  if (tilt_down_axis_ == -2) tilt_down_axis_ = legacy_tilt_axis;
  tilt_up_axis_sign_ = this->get_parameter("tilt_up_axis_sign").as_int();
  tilt_down_axis_sign_ = this->get_parameter("tilt_down_axis_sign").as_int();
  tilt_up_button_index_ = this->get_parameter("tilt_up_button_index").as_int();
  tilt_down_button_index_ = this->get_parameter("tilt_down_button_index").as_int();
  if (tilt_up_axis_ < -1 || tilt_down_axis_ < -1 ||
      (tilt_up_axis_sign_ != 1 && tilt_up_axis_sign_ != -1) ||
      (tilt_down_axis_sign_ != 1 && tilt_down_axis_sign_ != -1) || tilt_up_button_index_ < 0 ||
      tilt_down_button_index_ < 0 ||
      (tilt_up_axis_ == tilt_down_axis_ &&
       (tilt_up_axis_ == -1 ? tilt_up_button_index_ == tilt_down_button_index_
                            : tilt_up_axis_sign_ == tilt_down_axis_sign_))) {
    RCLCPP_ERROR(this->get_logger(), "Invalid or duplicate tilt direction inputs");
    return CallbackReturn::FAILURE;
  }
  for (const auto& direction : {std::string("up"), std::string("down")}) {
    const int axis = direction == "up" ? tilt_up_axis_ : tilt_down_axis_;
    RCLCPP_INFO(this->get_logger(), "Tilt %s: %s ignored in %s mode", direction.c_str(),
                axis == -1 ? "axis_sign" : "button_index", axis == -1 ? "button" : "axis");
  }
  tilt_step_angle_ = this->get_parameter("tilt_step_angle").as_double();
  tilt_min_angle_ = this->get_parameter("tilt_min_angle").as_double();
  tilt_max_angle_ = this->get_parameter("tilt_max_angle").as_double();
  fire_angle_ = this->get_parameter("fire_angle").as_double();
  home_angle_ = this->get_parameter("home_angle").as_double();
  fire_duration_ms_ = this->get_parameter("fire_duration_ms").as_int();
  command_rate_limit_ms_ = this->get_parameter("command_rate_limit_ms").as_int();
  std::string joy_topic = this->get_parameter("joy_topic").as_string();

  // サーボコントローラー接続（非常停止中はポートが無い / 開けない場合がある）
  servo_controller_ = std::make_shared<motor_control_lib::FeetechServoController>(port, baudrate);
  if (!servo_controller_->connect()) {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                         "サーボ接続に失敗しました (port=%s)。通電を待って再試行します",
                         port.c_str());
    servo_controller_.reset();
    return CallbackReturn::FAILURE;
  }

  // ポートが開けても未通電ならサーボは応答しないため、実際に1レジスタ読んで確認する
  std::this_thread::sleep_for(std::chrono::milliseconds(500));  // 初期化待機
  int32_t current_pos = servo_controller_->getCurrentPosition(tilt_servo_id_);
  if (current_pos == -1) {
    RCLCPP_WARN_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                         "サーボ %d が応答しません（非常停止による未通電の可能性）。再試行します",
                         tilt_servo_id_);
    disconnectServo();
    return CallbackReturn::FAILURE;
  }
  current_tilt_position_ = current_pos;
  current_tilt_angle_ = clampAngle(servoPositionToAngle(current_pos));

  // joyサブスクライバー作成（コールバックは ACTIVE のときのみ処理する）
  joy_subscription_ = this->create_subscription<sensor_msgs::msg::Joy>(
      joy_topic, 1, std::bind(&ShotComponent::joyCallback, this, std::placeholders::_1));

  RCLCPP_INFO(this->get_logger(), "Shot component configured (current tilt: %.1f deg)",
              current_tilt_angle_);
  return CallbackReturn::SUCCESS;
}

ShotComponent::CallbackReturn ShotComponent::on_activate(const rclcpp_lifecycle::State&) {
  if (!servo_controller_ || !servo_controller_->isConnected()) {
    RCLCPP_ERROR(this->get_logger(), "Servo controller not connected, cannot activate");
    return CallbackReturn::FAILURE;
  }

  // ホーム位置に移動
  int home_position = angleToServoPosition(home_angle_);
  if (!servo_controller_->setPosition(trigger_servo_id_, home_position, false)) {
    RCLCPP_ERROR(this->get_logger(),
                 "Failed to move to initial home position（通電断の可能性）。再初期化します");
    return CallbackReturn::FAILURE;
  }

  // エッジ検出状態をリセット（inactive 中に押されたボタンで誤発射しないため）
  if (fire_timer_) {
    fire_timer_->cancel();
    fire_timer_.reset();
  }
  is_shooting_ = false;
  // 押しっぱなしのボタン・チルト入力は、一度離すまで射撃にもチルトにも使わない
  // （inactive 中や非常停止・許可なしの間から押され続けている入力で動かさないため）。
  last_button_state_ = true;
  tilt_edges_.requireRelease();
  last_command_time_ = this->now();

  RCLCPP_INFO(this->get_logger(), "Shot component activated");
  RCLCPP_INFO(this->get_logger(),
              "Tilt up: axis=%d sign=%d button=%d; down: axis=%d sign=%d button=%d", tilt_up_axis_,
              tilt_up_axis_sign_, tilt_up_button_index_, tilt_down_axis_, tilt_down_axis_sign_,
              tilt_down_button_index_);
  RCLCPP_INFO(this->get_logger(), "Tilt range: %.1f - %.1f degrees", tilt_min_angle_,
              tilt_max_angle_);
  RCLCPP_INFO(this->get_logger(),
              "Fire angle: %.1f deg, Home angle: %.1f deg, Current tilt: %.1f deg", fire_angle_,
              home_angle_, current_tilt_angle_);
  // 稼働状態に到達。以降は自動再遷移を止めて手動 deactivate/cleanup を尊重する。
  if (auto_start_timer_) {
    auto_start_timer_->cancel();
  }
  return CallbackReturn::SUCCESS;
}

ShotComponent::CallbackReturn ShotComponent::on_deactivate(const rclcpp_lifecycle::State&) {
  tilt_edges_.reset();
  // 射撃シーケンス中なら止めて best-effort で home に戻す（タイマーを残さない）
  cancelShotSequence();
  // 手動 deactivate を含め、deactivate では自動再遷移を必ず止める。故障検出から
  // タイマー発火までの間に手動 deactivate されても再 activate しないための処置で、
  // 自動復帰経路（autoStartTimerCallback）は cleanup 後にタイマーを明示的に再開する。
  runtime_fault_ = false;
  teardown_pending_ = false;
  if (auto_start_timer_) {
    auto_start_timer_->cancel();
  }
  RCLCPP_INFO(this->get_logger(), "Shot component deactivated (joy input ignored)");
  return CallbackReturn::SUCCESS;
}

ShotComponent::CallbackReturn ShotComponent::on_cleanup(const rclcpp_lifecycle::State&) {
  tilt_edges_.reset();
  fire_timer_.reset();
  teardown_pending_ = false;
  joy_subscription_.reset();
  disconnectServo();
  RCLCPP_INFO(this->get_logger(), "Shot component cleaned up");
  return CallbackReturn::SUCCESS;
}

ShotComponent::CallbackReturn ShotComponent::on_shutdown(const rclcpp_lifecycle::State&) {
  tilt_edges_.reset();
  fire_timer_.reset();
  runtime_fault_ = false;
  teardown_pending_ = false;
  stopAutoStartTimers();
  if (teacher_permission_timer_) {
    teacher_permission_timer_->cancel();
  }
  teacher_permission_sub_.reset();
  estop_monitor_->unsubscribe();
  joy_subscription_.reset();
  lab_tilt_sub_.reset();
  lab_fire_sub_.reset();
  disconnectServo();
  RCLCPP_INFO(this->get_logger(), "Shot component shut down");
  return CallbackReturn::SUCCESS;
}

ShotComponent::CallbackReturn ShotComponent::on_error(const rclcpp_lifecycle::State&) {
  tilt_edges_.reset();
  // 遷移中に ERROR / 例外が発生したときの後始末。リソースを解放して unconfigured
  // に戻し、auto_start 有効時はタイマーを再開して自動復帰に委ねる。
  fire_timer_.reset();
  is_shooting_ = false;
  joy_subscription_.reset();
  disconnectServo();
  runtime_fault_ = false;
  teardown_pending_ = false;
  if (auto_start_ && auto_start_timer_) {
    auto_start_timer_->reset();
  }
  RCLCPP_WARN(this->get_logger(), "Shot component error handled, returning to unconfigured");
  return CallbackReturn::SUCCESS;
}

void ShotComponent::triggerAutoRecovery() {
  // ACTIVE 中にサーボ通信が失敗したときの復帰トリガ。実際の lifecycle 遷移は
  // autoStartTimerCallback 側で行い、サブスクリプション/射撃処理内からの
  // 再帰的な状態遷移を避ける。
  if (!auto_start_) {
    return;  // 手動運用時は operator の lifecycle 制御に委ねる
  }
  if (this->get_current_state().id() != lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE) {
    return;
  }
  if (!runtime_fault_.exchange(true)) {
    RCLCPP_WARN(this->get_logger(), "サーボ通信エラーを検出。自動復帰シーケンスを開始します");
  }
  if (auto_start_timer_) {
    auto_start_timer_->reset();
  }
}

void ShotComponent::disconnectServo() {
  if (servo_controller_) {
    servo_controller_->disconnect();
    servo_controller_.reset();
  }
}

}  // namespace motor_control_app
