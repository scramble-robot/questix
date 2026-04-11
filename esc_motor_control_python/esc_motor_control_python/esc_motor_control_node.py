#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
from std_msgs.msg import Float32, Bool
from geometry_msgs.msg import Twist
from sensor_msgs.msg import Joy
import time
import os
import threading
from typing import Optional

# GPIOzeroライブラリをインポート（安全にインポート）
try:
    from gpiozero import Servo
    try:
        from gpiozero.pins.pigpio import PiGPIOFactory
        from gpiozero import Device
        Device.pin_factory = PiGPIOFactory()
        GPIO_AVAILABLE = True
        PIGPIO_AVAILABLE = True
    except Exception as e:
        GPIO_AVAILABLE = True
        PIGPIO_AVAILABLE = False
        print(f"pigpioが利用できません。ソフトウェアPWMを使用します: {e}")
except ImportError:
    GPIO_AVAILABLE = False
    PIGPIO_AVAILABLE = False
    print("gpiozeroが利用できません。シミュレーションモードで動作します")


class ESCMotorControlNode(Node):
    """
    test_esc.pyをベースにしたROS2 ESCモーター制御ノード
    """
    
    def __init__(self):
        super().__init__('esc_motor_control_python')
        
        # パラメータの宣言
        self.declare_parameter('pwm_pin', 13)
        self.declare_parameter('max_speed', 1.0)
        self.declare_parameter('min_speed', -1.0) 
        self.declare_parameter('enable_safety_stop', True)
        self.declare_parameter('safety_timeout', 1.0)
        self.declare_parameter('full_speed_button', 3)
        self.declare_parameter('full_speed_value', 1.0)
        self.declare_parameter('test_mode', False)
        self.declare_parameter('joy_topic', '/joy')
        self.declare_parameter('cmd_vel_topic', 'cmd_vel')
        self.declare_parameter('min_pulse_width', 0)  # us
        self.declare_parameter('max_pulse_width', 2000)  # us
        self.declare_parameter('neutral_pulse_width', 0)  # us
        
        # パラメータの取得
        self.pwm_pin = self.get_parameter('pwm_pin').get_parameter_value().integer_value
        self.max_speed = self.get_parameter('max_speed').get_parameter_value().double_value
        self.min_speed = self.get_parameter('min_speed').get_parameter_value().double_value
        self.enable_safety_stop = self.get_parameter('enable_safety_stop').get_parameter_value().bool_value
        self.safety_timeout = self.get_parameter('safety_timeout').get_parameter_value().double_value
        self.full_speed_button = self.get_parameter('full_speed_button').get_parameter_value().integer_value
        self.full_speed_value = self.get_parameter('full_speed_value').get_parameter_value().double_value
        self.test_mode = self.get_parameter('test_mode').get_parameter_value().bool_value
        self.joy_topic = self.get_parameter('joy_topic').get_parameter_value().string_value
        self.cmd_vel_topic = self.get_parameter('cmd_vel_topic').get_parameter_value().string_value
        self.min_pulse_width = self.get_parameter('min_pulse_width').get_parameter_value().integer_value / 1000000.0
        self.max_pulse_width = self.get_parameter('max_pulse_width').get_parameter_value().integer_value / 1000000.0
        self.neutral_pulse_width = self.get_parameter('neutral_pulse_width').get_parameter_value().integer_value / 1000000.0
        
        # 内部状態
        self.current_speed = 0.0
        self.emergency_stop_active = False
        self.full_speed_active = False
        self.last_command_time = time.time()
        self.servo: Optional[Servo] = None
        self.lock = threading.Lock()
        
        # QoSプロファイル
        qos_profile = QoSProfile(
            reliability=ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.TRANSIENT_LOCAL,
            depth=10
        )
        
        # サブスクライバー
        self.joy_subscription = self.create_subscription(
            Joy,
            self.joy_topic,
            self.joy_callback,
            1
        )
        
        # self.cmd_vel_subscription = self.create_subscription(
        #     Twist,
        #     self.cmd_vel_topic,
        #     self.cmd_vel_callback,
        #     10
        # )
        
        # self.speed_subscription = self.create_subscription(
        #     Float32,
        #     'motor_speed',
        #     self.speed_callback,
        #     10
        # )
        
        # self.emergency_stop_subscription = self.create_subscription(
        #     Bool,
        #     'emergency_stop',
        #     self.emergency_stop_callback,
        #     qos_profile
        # )
        
        # パブリッシャー
        self.status_publisher = self.create_publisher(Float32, 'motor_status', 10)
        self.emergency_publisher = self.create_publisher(Bool, 'emergency_status', qos_profile)
        
        # タイマー
        self.status_timer = self.create_timer(0.1, self.publish_status)  # 10Hz
        if self.enable_safety_stop:
            self.safety_timer = self.create_timer(0.1, self.safety_check)
        
        # ESC初期化
        self.initialize_esc()
        
        self.get_logger().info(f'ESC Motor Control Node initialized on pin {self.pwm_pin}')
        self.get_logger().info(f'GPIO Available: {GPIO_AVAILABLE}, PiGPIO Available: {PIGPIO_AVAILABLE}')
        self.get_logger().info(f'Test Mode: {self.test_mode}')
        
        # 安全警告
        if not self.test_mode and GPIO_AVAILABLE:
            self.get_logger().warn('⚠️  実際のESCが接続されています。安全に注意してください！')
            self.get_logger().warn('⚠️  プロペラを取り外し、モーターを安全に固定してください')
    
    def initialize_esc(self):
        """ESCの初期化"""
        try:
            if GPIO_AVAILABLE and not self.test_mode:
                # 実際のGPIOを使用
                self.servo = Servo(
                    self.pwm_pin,
                    min_pulse_width=self.min_pulse_width,
                    max_pulse_width=self.max_pulse_width
                )
                
                self.get_logger().info('=== ESC初期化プロセス ===')
                self.get_logger().warn('⚠️  初期化中はモーターに触れないでください')
                
                # ESC初期化シーケンス：中立位置（1500us）から開始
                self.servo.value = 0.0  # 中立位置（1500us = (1000+2000)/2）
                time.sleep(2)  # ESCの初期化待機
                
                self.get_logger().info('✅ ESCが初期化されました。停止状態で待機中...')
                
            else:
                # テストモードまたはGPIO利用不可
                self.servo = None
                self.get_logger().info('シミュレーションモードで動作中')
                
        except Exception as e:
            self.get_logger().fatal(f'ESC初期化エラー: {str(e)}')
            self.get_logger().fatal('GPIO初期化に失敗しました。シミュレーションモードで動作します。')
            self.get_logger().fatal('systemd環境の場合: HOME環境変数、SupplementaryGroups=gpio の設定を確認してください')
            self.servo = None
    
    def set_motor_speed(self, speed: float):
        """モーター速度設定"""
        with self.lock:
            if self.emergency_stop_active:
                speed = 0.0
            
            # 速度制限
            speed = max(self.min_speed, min(self.max_speed, speed))
            
            self.current_speed = speed
            self.last_command_time = time.time()
            
            try:
                if self.servo is not None:
                    # 実際のESC制御
                    # ESCでは0.0が中立位置（1500us）、-1.0が最小（1000us）、1.0が最大（2000us）
                    self.servo.value = speed
                        
                    self.get_logger().debug(f'ESC速度設定: {speed:.3f}')
                    
                else:
                    # シミュレーション
                    self.get_logger().debug(f'シミュレーション速度: {speed:.3f}')
                    
            except Exception as e:
                self.get_logger().error(f'モーター制御エラー: {str(e)}')
    
    def joy_callback(self, msg: Joy):
        """ジョイスティックコールバック"""
        try:
            # フルスピードボタンチェック
            if len(msg.buttons) > self.full_speed_button:
                full_speed_pressed = msg.buttons[self.full_speed_button] == 1
                
                if full_speed_pressed and not self.full_speed_active:
                    self.get_logger().info('🟢 フルスピードボタンが押されました')
                    self.full_speed_active = True
                    self.set_motor_speed(self.full_speed_value)
                    
                elif not full_speed_pressed and self.full_speed_active:
                    self.get_logger().info('🔴 フルスピードボタンが離されました')
                    self.full_speed_active = False
                    self.set_motor_speed(0.0)
                
                elif full_speed_pressed and self.full_speed_active:
                    # ボタンが押し続けられている間は最後のコマンド時刻を更新
                    # 安全タイムアウトを防ぐため
                    with self.lock:
                        self.last_command_time = time.time()
                            
        except Exception as e:
            self.get_logger().error(f'ジョイスティック処理エラー: {str(e)}')
    
    # def cmd_vel_callback(self, msg: Twist):
    #     """cmd_velコールバック"""
    #     try:
    #         # 線形速度をモーター速度に変換
    #         speed = msg.linear.x
    #         self.set_motor_speed(speed)
            
    #     except Exception as e:
    #         self.get_logger().error(f'cmd_vel処理エラー: {str(e)}')
    
    # def speed_callback(self, msg: Float32):
    #     """直接速度指令コールバック"""
    #     try:
    #         self.set_motor_speed(msg.data)
            
    #     except Exception as e:
    #         self.get_logger().error(f'速度指令処理エラー: {str(e)}')
    
    # def emergency_stop_callback(self, msg: Bool):
    #     """緊急停止コールバック"""
    #     with self.lock:
    #         if msg.data and not self.emergency_stop_active:
    #             self.get_logger().warn('🚨 緊急停止が作動しました！')
    #             self.emergency_stop_active = True
    #             self.set_motor_speed(0.0)
                
    #         elif not msg.data and self.emergency_stop_active:
    #             self.get_logger().info('✅ 緊急停止が解除されました')
    #             self.emergency_stop_active = False
    
    def safety_check(self):
        """安全チェックタイマー"""
        if self.enable_safety_stop:
            current_time = time.time()
            if current_time - self.last_command_time > self.safety_timeout:
                if not self.emergency_stop_active:
                    self.get_logger().warn('⚠️  安全タイムアウト：モーターを停止します')
                    self.set_motor_speed(0.0)
    
    def publish_status(self):
        """ステータス配信"""
        # モーターステータス
        status_msg = Float32()
        status_msg.data = self.current_speed
        self.status_publisher.publish(status_msg)
        
        # 緊急停止ステータス
        emergency_msg = Bool()
        emergency_msg.data = self.emergency_stop_active
        self.emergency_publisher.publish(emergency_msg)
    
    def destroy_node(self):
        """ノード終了処理"""
        self.get_logger().info('ノードを終了中...')
        
        # モーター停止
        self.set_motor_speed(0.0)
        time.sleep(0.5)
        
        # GPIO清理
        if self.servo is not None:
            try:
                self.servo.close()
                self.get_logger().info('ESCリソースを解放しました')
            except Exception as e:
                self.get_logger().error(f'ESC解放エラー: {str(e)}')
        
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    
    node = ESCMotorControlNode()
    
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        node.get_logger().info('Ctrl+Cが押されました。安全に終了します。')
    finally:
        node.destroy_node()
        try:
            rclpy.shutdown()
        except Exception:
            pass


if __name__ == '__main__':
    main()
