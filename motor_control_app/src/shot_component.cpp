#include "motor_control_app/shot_component.hpp"

#include <chrono>
#include <thread>

namespace motor_control_app {

ShotComponent::ShotComponent(const rclcpp::NodeOptions& options)
    : Node("shot_component", options),
      is_shooting_(false),
      last_button_state_(false),
      last_pan_value_(0.0F),
      last_pan_up_state_(false),
      last_pan_down_state_(false),
      current_pan_position_(2048) {
  // パラメーター宣言
  this->declare_parameter("port", "/dev/servo");
  this->declare_parameter("baudrate", 115200);
  this->declare_parameter("pan_servo_id", 1);
  this->declare_parameter("trigger_servo_id", 3);
  this->declare_parameter("fire_button", 5);             // R button (Switch2 native index)
  // Pan input mode / パン入力モード
  // - If pan_axis >= 0: use the analog axis (D-pad / stick).
  // - Otherwise: use pan_up_button_index / pan_down_button_index (button edge).
  // pan_axis が 0 以上なら軸モード、それ以外はボタンモードで動いて上下します。
  this->declare_parameter("pan_axis", -1);               // -1 = disabled (button mode)
  this->declare_parameter("pan_up_button_index", 4);     // L button (Switch2 native index)
  this->declare_parameter("pan_down_button_index", 6);   // ZL button (Switch2 native index)
  this->declare_parameter("pan_step_angle", 5.0);        // パンステップサイズ（度）
  this->declare_parameter("pan_min_angle", 0.0);         // パン最小角度（度）
  this->declare_parameter("pan_max_angle", 70.0);       // パン最大角度（度）
  this->declare_parameter("fire_angle", 130.0);          // 射撃角度（度）
  this->declare_parameter("home_angle", 100.0);          // ホーム角度（度）
  this->declare_parameter("fire_duration_ms", 300);      // 射撃持続時間（ミリ秒）
  this->declare_parameter("command_rate_limit_ms", 50);  // コマンド間隔制限（ミリ秒）
  this->declare_parameter("joy_topic", "/joy");           // joyトピック名

  // パラメーター取得
  std::string port = this->get_parameter("port").as_string();
  int baudrate = this->get_parameter("baudrate").as_int();
  pan_servo_id_ = this->get_parameter("pan_servo_id").as_int();
  trigger_servo_id_ = this->get_parameter("trigger_servo_id").as_int();
  fire_button_ = this->get_parameter("fire_button").as_int();
  pan_axis_ = this->get_parameter("pan_axis").as_int();
  pan_up_button_index_ = this->get_parameter("pan_up_button_index").as_int();
  pan_down_button_index_ = this->get_parameter("pan_down_button_index").as_int();
  pan_step_angle_ = this->get_parameter("pan_step_angle").as_double();
  pan_min_angle_ = this->get_parameter("pan_min_angle").as_double();
  pan_max_angle_ = this->get_parameter("pan_max_angle").as_double();
  fire_angle_ = this->get_parameter("fire_angle").as_double();
  home_angle_ = this->get_parameter("home_angle").as_double();
  fire_duration_ms_ = this->get_parameter("fire_duration_ms").as_int();
  command_rate_limit_ms_ = this->get_parameter("command_rate_limit_ms").as_int();
  std::string joy_topic = this->get_parameter("joy_topic").as_string();

  // 最後のコマンド時刻を初期化
  last_command_time_ = this->now();

  // サーボコントローラー初期化
  servo_controller_ = std::make_shared<motor_control_lib::FeetechServoController>(port, baudrate);
  if (!servo_controller_->connect()) {
    RCLCPP_ERROR(this->get_logger(), "Failed to connect to servo controller");
    return;
  }

  // 射撃コントローラー初期化
  shot_controller_ = std::make_unique<motor_control_lib::ShotController>(servo_controller_);

  // joyサブスクライバー作成
  joy_subscription_ = this->create_subscription<sensor_msgs::msg::Joy>(
      joy_topic, 1, std::bind(&ShotComponent::joyCallback, this, std::placeholders::_1));

  // 既存のサブスクライバー（互換性のため）
  aim_subscription_ = this->create_subscription<geometry_msgs::msg::Point>(
      "aim_target", 1, std::bind(&ShotComponent::aimCallback, this, std::placeholders::_1));

  fire_subscription_ = this->create_subscription<std_msgs::msg::Bool>(
      "fire_trigger", 1, std::bind(&ShotComponent::fireCallback, this, std::placeholders::_1));

  home_subscription_ = this->create_subscription<std_msgs::msg::Bool>(
      "return_home", 1, std::bind(&ShotComponent::homeCallback, this, std::placeholders::_1));

  // パブリッシャー作成
  current_aim_publisher_ = this->create_publisher<geometry_msgs::msg::Point>("current_aim", 1);

  // 現在位置を定期的に公開（一時的に無効化）
  // timer_ = this->create_wall_timer(std::chrono::milliseconds(100),
  //                                  std::bind(&ShotComponent::publishCurrentAim, this));

  // 最初にホーム位置に移動
  std::this_thread::sleep_for(std::chrono::milliseconds(500));  // 初期化待機
  int home_position = angleToServoPosition(home_angle_);
  if (!servo_controller_->setPosition(trigger_servo_id_, home_position, false)) {
    RCLCPP_WARN(this->get_logger(), "Failed to move to initial home position");
  }

  // 現在のパン位置を取得して初期化
  int32_t current_pos = servo_controller_->getCurrentPosition(pan_servo_id_);
  if (current_pos != -1) {
    current_pan_position_ = current_pos;
    current_pan_angle_ = clampAngle(servoPositionToAngle(current_pos));
  } else {
    RCLCPP_WARN(this->get_logger(), "Failed to get current pan position, using default");
    current_pan_angle_ = clampAngle(180.0);  // デフォルト角度
    current_pan_position_ = angleToServoPosition(current_pan_angle_);
  }

  RCLCPP_INFO(this->get_logger(), "Shot component started");
  if (pan_axis_ >= 0) {
    RCLCPP_INFO(this->get_logger(),
                "Fire button: %d, Pan mode: axis=%d, Pan step: %.1f degrees",
                fire_button_, pan_axis_, pan_step_angle_);
  } else {
    RCLCPP_INFO(this->get_logger(),
                "Fire button: %d, Pan mode: buttons up=%d down=%d, Pan step: %.1f degrees",
                fire_button_, pan_up_button_index_, pan_down_button_index_, pan_step_angle_);
  }
  RCLCPP_INFO(this->get_logger(), "Pan range: %.1f - %.1f degrees", pan_min_angle_, pan_max_angle_);
  RCLCPP_INFO(this->get_logger(),
              "Fire angle: %.1f deg, Home angle: %.1f deg, Current pan: %.1f deg", fire_angle_,
              home_angle_, current_pan_angle_);
}

ShotComponent::~ShotComponent() {
  if (servo_controller_) {
    servo_controller_->disconnect();
  }
}

void ShotComponent::joyCallback(const sensor_msgs::msg::Joy::SharedPtr msg) {
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

  // Pan input: axis mode if pan_axis >= 0, otherwise button mode (L / ZL).
  // pan_axis が 0 以上なら軸モード、それ以外はボタンモード。
  const auto step_pan = [this](double delta_deg, const char* direction) {
    if (!canSendCommand()) {
      RCLCPP_DEBUG(this->get_logger(), "Pan command rate limited");
      return;
    }
    double new_angle = current_pan_angle_ + delta_deg;
    current_pan_angle_ = clampAngle(new_angle);
    current_pan_position_ = angleToServoPosition(current_pan_angle_);
    if (servo_controller_->setPosition(pan_servo_id_, current_pan_position_, false)) {
      RCLCPP_INFO(this->get_logger(), "Pan %s: angle=%.1f deg", direction, current_pan_angle_);
      last_command_time_ = this->now();
    } else {
      RCLCPP_ERROR(this->get_logger(), "Failed to move pan %s", direction);
    }
  };

  if (pan_axis_ >= 0 && pan_axis_ < static_cast<int>(msg->axes.size())) {
    // Axis mode: rising edge detection at ±0.5
    const float current_pan_value = msg->axes[pan_axis_];
    if (current_pan_value > 0.5F && last_pan_value_ <= 0.5F) {
      step_pan(pan_step_angle_, "up");
    } else if (current_pan_value < -0.5F && last_pan_value_ >= -0.5F) {
      step_pan(-pan_step_angle_, "down");
    }
    last_pan_value_ = current_pan_value;
  } else {
    // Button mode: L = up, ZL = down (rising edge)
    const auto button_pressed = [&msg](int index) {
      return index >= 0 && static_cast<size_t>(index) < msg->buttons.size() &&
             msg->buttons[static_cast<size_t>(index)] == 1;
    };
    const bool pan_up_pressed = button_pressed(pan_up_button_index_);
    const bool pan_down_pressed = button_pressed(pan_down_button_index_);

    if (pan_up_pressed && !last_pan_up_state_) {
      step_pan(pan_step_angle_, "up");
    } else if (pan_down_pressed && !last_pan_down_state_) {
      step_pan(-pan_step_angle_, "down");
    }
    last_pan_up_state_ = pan_up_pressed;
    last_pan_down_state_ = pan_down_pressed;
  }
}

void ShotComponent::executeShotSequence() {
  if (is_shooting_) {
    return;  // 既に射撃中の場合は無視
  }

  is_shooting_ = true;
  RCLCPP_INFO(this->get_logger(), "Starting shot sequence...");

  // 1. 射撃位置に移動
  int fire_position = angleToServoPosition(fire_angle_);
  if (servo_controller_->setPosition(trigger_servo_id_, fire_position, false)) {
    RCLCPP_INFO(this->get_logger(), "Moved to fire position (%.1f deg)", fire_angle_);

    // 射撃持続時間待機
    std::this_thread::sleep_for(std::chrono::milliseconds(fire_duration_ms_));

    // 2. すべてのサーボをホーム位置に戻る
    int home_position = angleToServoPosition(home_angle_);
    if (servo_controller_->setPosition(trigger_servo_id_, home_position, false)) {
      RCLCPP_INFO(this->get_logger(), "Returned to home position (%.1f deg)", home_angle_);
    } else {
      RCLCPP_ERROR(this->get_logger(), "Failed to return to home position");
    }
  } else {
    RCLCPP_ERROR(this->get_logger(), "Failed to move to fire position");
  }

  is_shooting_ = false;
  RCLCPP_INFO(this->get_logger(), "Shot sequence completed");
}

void ShotComponent::aimCallback(const geometry_msgs::msg::Point::SharedPtr msg) {
  // Point.x = pan角度 (制限範囲内)
  double pan_angle = clampAngle(msg->x);
  int pan_position = angleToServoPosition(pan_angle);

  if (servo_controller_->setPosition(pan_servo_id_, pan_position, false)) {
    current_pan_angle_ = pan_angle;
    current_pan_position_ = pan_position;  // 内部状態も更新
    RCLCPP_INFO(this->get_logger(), "Aiming at pan=%.1f deg", pan_angle);
  } else {
    RCLCPP_ERROR(this->get_logger(), "Failed to aim at target position");
  }
}

void ShotComponent::fireCallback(const std_msgs::msg::Bool::SharedPtr msg) {
  if (msg->data) {
    executeShotSequence();
  }
}

void ShotComponent::homeCallback(const std_msgs::msg::Bool::SharedPtr msg) {
  if (msg->data) {
    // ホーム位置に戻る
    int home_position = angleToServoPosition(home_angle_);
    if (servo_controller_->setPosition(trigger_servo_id_, home_position, false)) {
      RCLCPP_INFO(this->get_logger(), "Returned to home position (%.1f deg)", home_angle_);
    } else {
      RCLCPP_ERROR(this->get_logger(), "Failed to return home");
    }
  }
}

void ShotComponent::publishCurrentAim() {
  auto msg = std::make_unique<geometry_msgs::msg::Point>();
  msg->x = current_pan_angle_;  // 角度で公開
  msg->y = 0.0;                 // tilt機構なし
  msg->z = 0.0;
  current_aim_publisher_->publish(std::move(msg));
}

// 角度制限関数
double ShotComponent::clampAngle(double angle_deg) {
  return std::max(pan_min_angle_, std::min(pan_max_angle_, angle_deg));
}

// コマンド送信レート制限チェック
bool ShotComponent::canSendCommand() {
  auto now = this->now();
  auto elapsed = (now - last_command_time_).nanoseconds() / 1000000;  // ミリ秒に変換
  return elapsed >= command_rate_limit_ms_;
}

// 角度からサーボ位置への変換（角度 -> 0-4095）
int ShotComponent::angleToServoPosition(double angle_deg) {
  // 角度を直接サーボ位置に変換（0度=0, 360度=4095）
  // 角度を0-360度の範囲で正規化
  while (angle_deg < 0) angle_deg += 360.0;
  while (angle_deg >= 360.0) angle_deg -= 360.0;
  
  // サーボ位置に変換
  double normalized = angle_deg / 360.0;
  int position = static_cast<int>(normalized * 4096.0);
  return std::max(0, std::min(4095, position));
}

// サーボ位置から角度への変換（0-4095 -> 角度）
double ShotComponent::servoPositionToAngle(int position) {
  // 位置を0-4095の範囲にクランプ
  position = std::max(0, std::min(4095, position));
  // 角度に変換（0-4095 -> 0-360度）
  double normalized = static_cast<double>(position) / 4096.0;
  return normalized * 360.0;
}

}  // namespace motor_control_app

#include <rclcpp_components/register_node_macro.hpp>
RCLCPP_COMPONENTS_REGISTER_NODE(motor_control_app::ShotComponent)
