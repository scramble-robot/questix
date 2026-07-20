// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "motor_control_app/shot_component.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <exception>
#include <functional>
#include <lifecycle_msgs/msg/state.hpp>
#include <string>
#include <thread>

#include "motor_control_app/shot_angle.hpp"
#include "motor_control_app/shot_auto_start.hpp"

namespace motor_control_app {

ShotComponent::ShotComponent(const rclcpp::NodeOptions& options)
    : rclcpp_lifecycle::LifecycleNode("shot_component", options),
      tilt_servo_id_(1),
      trigger_servo_id_(3),
      fire_button_(5),
      tilt_axis_(-1),
      tilt_up_button_index_(4),
      tilt_down_button_index_(6),
      tilt_step_angle_(5.0),
      tilt_min_angle_(0.0),
      tilt_max_angle_(70.0),
      fire_angle_(130.0),
      home_angle_(100.0),
      fire_duration_ms_(300),
      command_rate_limit_ms_(50),
      auto_start_(true),
      connect_retry_period_sec_(3.0),
      controllable_timeout_sec_(1.0),
      controllable_topic_("/gpio/controllable"),
      have_controllable_(false),
      controllable_(false),
      controllable_timed_out_(false),
      runtime_fault_(false),
      teardown_pending_(false),
      is_shooting_(false),
      last_button_state_(false),
      last_tilt_value_(0.0F),
      last_tilt_up_state_(false),
      last_tilt_down_state_(false),
      current_tilt_position_(2048),
      current_tilt_angle_(0.0),
      last_command_time_(0, 0, RCL_ROS_TIME) {
  // パラメーター宣言（取得は on_configure で行い、cleanup→configure で再読込できるようにする）
  this->declare_parameter("port", "/dev/servo");
  this->declare_parameter("baudrate", 115200);
  this->declare_parameter("tilt_servo_id", 1);
  this->declare_parameter("trigger_servo_id", 3);
  this->declare_parameter("fire_button", 5);  // R button (Switch2 native index)
  // Tilt input mode / チルト入力モード
  // - If tilt_axis >= 0: use the analog axis (D-pad / stick).
  // - Otherwise: use tilt_up_button_index / tilt_down_button_index (button edge).
  // tilt_axis が 0 以上なら軸モード、それ以外はボタンモードで動いて上下します。
  this->declare_parameter("tilt_axis", -1);              // -1 = disabled (button mode)
  this->declare_parameter("tilt_up_button_index", 4);    // L button (Switch2 native index)
  this->declare_parameter("tilt_down_button_index", 6);  // ZL button (Switch2 native index)
  this->declare_parameter("tilt_step_angle", 5.0);       // チルトステップサイズ（度）
  this->declare_parameter("tilt_min_angle", 0.0);        // チルト最小角度（度）
  this->declare_parameter("tilt_max_angle", 70.0);       // チルト最大角度（度）
  this->declare_parameter("fire_angle", 130.0);          // 射撃角度（度）
  this->declare_parameter("home_angle", 100.0);          // ホーム角度（度）
  this->declare_parameter("fire_duration_ms", 300);      // 射撃持続時間（ミリ秒）
  this->declare_parameter("command_rate_limit_ms", 50);  // コマンド間隔制限（ミリ秒）
  this->declare_parameter("joy_topic", "/joy");          // joyトピック名
  // Lifecycle 自動遷移。非常停止解除でサーボが通電するまで configure を再試行する。
  this->declare_parameter("auto_start", true);
  this->declare_parameter("connect_retry_period_sec", 3.0);
  // 非常停止連動トピック（auto_start=true のときのみ有効、空文字で連動無効）
  this->declare_parameter("controllable_topic", "/gpio/controllable");
  this->declare_parameter("controllable_timeout_sec", 1.0);

  auto_start_ = this->get_parameter("auto_start").as_bool();
  const double requested_retry_period = this->get_parameter("connect_retry_period_sec").as_double();
  connect_retry_period_sec_ = shot_auto_start::normalizePositivePeriod(requested_retry_period, 3.0);
  if (!shot_auto_start::isValidPositivePeriod(requested_retry_period)) {
    RCLCPP_WARN(this->get_logger(),
                "Invalid connect_retry_period_sec=%g; using the default 3.0 seconds",
                requested_retry_period);
  }
  controllable_topic_ = this->get_parameter("controllable_topic").as_string();
  const double requested_controllable_timeout =
      this->get_parameter("controllable_timeout_sec").as_double();
  controllable_timeout_sec_ =
      shot_auto_start::normalizeControllableTimeout(requested_controllable_timeout, 1.0);
  if (!std::isfinite(requested_controllable_timeout)) {
    RCLCPP_WARN(this->get_logger(),
                "Invalid controllable_timeout_sec=%g; using the default 1.0 seconds",
                requested_controllable_timeout);
  }

  if (auto_start_) {
    const auto period = std::chrono::duration<double>(std::max(0.5, connect_retry_period_sec_));
    auto_start_timer_ =
        this->create_wall_timer(std::chrono::duration_cast<std::chrono::nanoseconds>(period),
                                std::bind(&ShotComponent::autoStartTimerCallback, this));
    if (!controllable_topic_.empty()) {
      controllable_sub_ = this->create_subscription<std_msgs::msg::Bool>(
          controllable_topic_, 1,
          std::bind(&ShotComponent::controllableCallback, this, std::placeholders::_1));
      if (controllable_timeout_sec_ > 0.0) {
        controllable_timeout_timer_ =
            this->create_wall_timer(std::chrono::milliseconds(100),
                                    std::bind(&ShotComponent::controllableTimeoutCallback, this));
      }
    }
    RCLCPP_INFO(this->get_logger(),
                "Shot component created (auto_start=true, retry=%.1fs, estop_topic=%s). "
                "サーボ通電（非常停止解除）を待って自動起動します",
                connect_retry_period_sec_,
                controllable_topic_.empty() ? "<disabled>" : controllable_topic_.c_str());
  } else {
    RCLCPP_INFO(this->get_logger(),
                "Shot component created (auto_start=false). "
                "外部から lifecycle configure/activate してください");
  }
}

ShotComponent::~ShotComponent() {
  stopAutoStartTimers();
  if (fire_timer_) {
    fire_timer_->cancel();
  }
  try {
    disconnectServo();
  } catch (...) {
    // Destructors must not propagate hardware cleanup failures.
  }
}

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
  uint8_t state_id = this->get_current_state().id();
  auto action = decideAutoStartAction(state_id, have_controllable_, controllable_);
  if (action == AutoStartAction::kWaitEstopRelease) {
    RCLCPP_INFO_THROTTLE(this->get_logger(), *this->get_clock(), 30000,
                         "非常停止中のため接続試行を保留しています（解除で自動再開します）");
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
    action = decideAutoStartAction(state_id, have_controllable_, controllable_);
  }
  if (action == AutoStartAction::kActivate) {
    state_id = this->activate().id();
    action = decideAutoStartAction(state_id, have_controllable_, controllable_);
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
  if (controllable_timeout_timer_) {
    controllable_timeout_timer_->cancel();
  }
}

void ShotComponent::controllableCallback(const std_msgs::msg::Bool::SharedPtr msg) {
  if (!msg) {
    return;
  }
  const bool first = !have_controllable_;
  const bool prev = controllable_;
  const bool recovered = controllable_timed_out_;
  have_controllable_ = true;
  controllable_ = msg->data;
  controllable_timed_out_ = false;
  last_controllable_time_ = std::chrono::steady_clock::now();
  if (recovered) {
    RCLCPP_INFO(this->get_logger(), "%s reception recovered", controllable_topic_.c_str());
  }
  if (!first && controllable_ == prev) {
    return;  // 値に変化なし（~20Hz で配信されるため、エッジのみ処理する）
  }

  if (!controllable_) {
    // 非常停止押下。サーボバスが断たれるため、ACTIVE / 自動起動途中の INACTIVE は
    // 解体してサーボ接続を解放し、unconfigured で解除を待つ。
    // 手動 deactivate 済み（タイマー停止中）のノードは操作者の制御を尊重して触らない。
    const uint8_t state_id = this->get_current_state().id();
    if (state_id == lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE) {
      RCLCPP_WARN(this->get_logger(),
                  "非常停止押下を検出（%s=false）。deactivate→cleanup してサーボ接続を解放します",
                  controllable_topic_.c_str());
      transitionToUnconfiguredForAutoRecovery("controllable=false");
    } else if (state_id == lifecycle_msgs::msg::State::PRIMARY_STATE_INACTIVE &&
               auto_start_timer_ && !auto_start_timer_->is_canceled()) {
      RCLCPP_WARN(this->get_logger(),
                  "非常停止押下を検出（%s=false）。cleanup してサーボ接続を解放します",
                  controllable_topic_.c_str());
      transitionToUnconfiguredForAutoRecovery("controllable=false");
    }
    return;
  }

  // 非常停止解除（または初回受信が解除状態）。タイマー停止中は手動運用
  // （手動 deactivate 済み or 正常 ACTIVE）なので自動遷移しない。
  if (!auto_start_timer_ || auto_start_timer_->is_canceled()) {
    return;
  }
  if (!first) {
    RCLCPP_INFO(this->get_logger(), "非常停止解除を検出（%s=true）。起動シーケンスを開始します",
                controllable_topic_.c_str());
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

void ShotComponent::controllableTimeoutCallback() {
  try {
    if (controllable_timed_out_ || controllable_timeout_sec_ <= 0.0 || !have_controllable_) {
      return;
    }
    const double elapsed =
        std::chrono::duration<double>(std::chrono::steady_clock::now() - last_controllable_time_)
            .count();
    if (!shot_auto_start::isControllableSignalStale(controllable_timeout_sec_, controllable_,
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
    controllable_timed_out_ = true;
    controllable_ = false;
    RCLCPP_WARN(this->get_logger(),
                "%s reception timed out after %.2fs; applying fail-safe teardown",
                controllable_topic_.c_str(), elapsed);
    transitionToUnconfiguredForAutoRecovery("controllable timeout");
  } catch (const std::exception& error) {
    RCLCPP_ERROR(this->get_logger(), "Controllable timeout callback failed: %s", error.what());
  } catch (...) {
    RCLCPP_ERROR(this->get_logger(), "Controllable timeout callback failed with unknown exception");
  }
}

ShotComponent::CallbackReturn ShotComponent::on_configure(const rclcpp_lifecycle::State&) {
  std::string port = this->get_parameter("port").as_string();
  int baudrate = this->get_parameter("baudrate").as_int();
  tilt_servo_id_ = this->get_parameter("tilt_servo_id").as_int();
  trigger_servo_id_ = this->get_parameter("trigger_servo_id").as_int();
  fire_button_ = this->get_parameter("fire_button").as_int();
  tilt_axis_ = this->get_parameter("tilt_axis").as_int();
  tilt_up_button_index_ = this->get_parameter("tilt_up_button_index").as_int();
  tilt_down_button_index_ = this->get_parameter("tilt_down_button_index").as_int();
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
  last_button_state_ = false;
  last_tilt_value_ = 0.0F;
  last_tilt_up_state_ = false;
  last_tilt_down_state_ = false;
  last_command_time_ = this->now();

  RCLCPP_INFO(this->get_logger(), "Shot component activated");
  if (tilt_axis_ >= 0) {
    RCLCPP_INFO(this->get_logger(), "Fire button: %d, Tilt mode: axis=%d, Tilt step: %.1f degrees",
                fire_button_, tilt_axis_, tilt_step_angle_);
  } else {
    RCLCPP_INFO(this->get_logger(),
                "Fire button: %d, Tilt mode: buttons up=%d down=%d, Tilt step: %.1f degrees",
                fire_button_, tilt_up_button_index_, tilt_down_button_index_, tilt_step_angle_);
  }
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
  fire_timer_.reset();
  teardown_pending_ = false;
  joy_subscription_.reset();
  disconnectServo();
  RCLCPP_INFO(this->get_logger(), "Shot component cleaned up");
  return CallbackReturn::SUCCESS;
}

ShotComponent::CallbackReturn ShotComponent::on_shutdown(const rclcpp_lifecycle::State&) {
  fire_timer_.reset();
  runtime_fault_ = false;
  teardown_pending_ = false;
  stopAutoStartTimers();
  controllable_sub_.reset();
  joy_subscription_.reset();
  disconnectServo();
  RCLCPP_INFO(this->get_logger(), "Shot component shut down");
  return CallbackReturn::SUCCESS;
}

ShotComponent::CallbackReturn ShotComponent::on_error(const rclcpp_lifecycle::State&) {
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

void ShotComponent::joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg) {
  if (this->get_current_state().id() != lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE) {
    return;
  }
  if (!servo_controller_ || !servo_controller_->isConnected()) {
    return;
  }
  if (!msg || msg->buttons.empty()) {
    return;
  }

  // 射撃ボタンの処理
  if (!is_shooting_ && fire_button_ >= 0 && fire_button_ < static_cast<int>(msg->buttons.size())) {
    bool current_button_state = msg->buttons[fire_button_] == 1;

    // ボタンが押された瞬間を検出（立ち上がりエッジ）
    if (current_button_state && !last_button_state_) {
      executeShotSequence();
    }

    last_button_state_ = current_button_state;
  }

  // axesが存在するかチェック
  if (msg->axes.empty()) {
    return;
  }

  // Tilt input: axis mode if tilt_axis >= 0, otherwise button mode (L / ZL).
  // tilt_axis が 0 以上なら軸モード、それ以外はボタンモード。
  const auto step_tilt = [this](double delta_deg, const char* direction) {
    if (!canSendCommand()) {
      RCLCPP_DEBUG(this->get_logger(), "Tilt command rate limited");
      return;
    }
    double new_angle = current_tilt_angle_ + delta_deg;
    current_tilt_angle_ = clampAngle(new_angle);
    current_tilt_position_ = angleToServoPosition(current_tilt_angle_);
    if (servo_controller_->setPosition(tilt_servo_id_, current_tilt_position_, false)) {
      RCLCPP_INFO(this->get_logger(), "Tilt %s: angle=%.1f deg", direction, current_tilt_angle_);
      last_command_time_ = this->now();
    } else {
      RCLCPP_ERROR(this->get_logger(), "Failed to move tilt %s", direction);
      triggerAutoRecovery();
    }
  };

  if (tilt_axis_ >= 0 && tilt_axis_ < static_cast<int>(msg->axes.size())) {
    // Axis mode: rising edge detection at ±0.5
    const float current_tilt_value = msg->axes[tilt_axis_];
    if (current_tilt_value > 0.5F && last_tilt_value_ <= 0.5F) {
      step_tilt(tilt_step_angle_, "up");
    } else if (current_tilt_value < -0.5F && last_tilt_value_ >= -0.5F) {
      step_tilt(-tilt_step_angle_, "down");
    }
    last_tilt_value_ = current_tilt_value;
  } else {
    // Button mode: L = up, ZL = down (rising edge)
    const auto button_pressed = [&msg](int index) {
      return index >= 0 && static_cast<size_t>(index) < msg->buttons.size() &&
             msg->buttons[static_cast<size_t>(index)] == 1;
    };
    const bool tilt_up_pressed = button_pressed(tilt_up_button_index_);
    const bool tilt_down_pressed = button_pressed(tilt_down_button_index_);

    if (tilt_up_pressed && !last_tilt_up_state_) {
      step_tilt(tilt_step_angle_, "up");
    } else if (tilt_down_pressed && !last_tilt_down_state_) {
      step_tilt(-tilt_step_angle_, "down");
    }
    last_tilt_up_state_ = tilt_up_pressed;
    last_tilt_down_state_ = tilt_down_pressed;
  }
}

void ShotComponent::executeShotSequence() {
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
  fire_timer_ = this->create_wall_timer(std::chrono::milliseconds(fire_duration_ms_),
                                        std::bind(&ShotComponent::fireTimerCallback, this));
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

#include <rclcpp_components/register_node_macro.hpp>
RCLCPP_COMPONENTS_REGISTER_NODE(motor_control_app::ShotComponent)
