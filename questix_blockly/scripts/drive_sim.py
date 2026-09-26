#!/usr/bin/env python3
"""Ideal planar QUESTiX motion; no serial/GPIO access or motor dynamics."""
import math
import time
from collections import deque

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, DurabilityPolicy
from geometry_msgs.msg import Twist, TransformStamped, PoseStamped
from nav_msgs.msg import Odometry, Path
from sensor_msgs.msg import Joy
from std_msgs.msg import Bool
from std_srvs.srv import SetBool, Trigger
from questix_msgs.msg import EmergencyStop, DriveStatus
from differential import DifferentialDrive
from tf2_ros import TransformBroadcaster


class DriveSimulation(Node):
    def __init__(self):
        super().__init__('questix_drive_simulation')
        self.demo_mode = self.declare_parameter('demo', False).value
        self.running = self.demo_mode
        self.drive = DifferentialDrive()
        self.estop = False
        self.blocked = True
        self.last_stop = 0.
        self.last_cmd = 0.
        self.target = (0., 0.)
        self.x = self.y = self.yaw = 0.
        self.history = deque(maxlen=1200)
        self.last_tick = time.monotonic()
        self.counter = 0
        self.gpio = self.create_publisher(Bool, '/gpio_5', 10)
        self.joy = self.create_publisher(Joy, '/joy', 10)
        self.wheels = self.create_publisher(DriveStatus, '/simulation/drive_status', 10)
        self.odom = self.create_publisher(Odometry, '/odom', 10)
        self.path = self.create_publisher(Path, '/simulation/path', 10)
        self.tf = TransformBroadcaster(self)
        qos = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)
        self.create_subscription(EmergencyStop, '/emergency_stop', self.on_stop, qos)
        self.create_subscription(Twist, '/target_twist', self.on_command, 10)
        if not self.demo_mode:
            self.create_subscription(Joy, '/joy', self.on_joy, 10)
        self.create_service(SetBool, '/simulation/run', self.on_run)
        self.create_service(SetBool, '/simulation/emergency_stop', self.on_estop)
        self.create_service(Trigger, '/simulation/reset', self.on_reset)
        self.create_timer(0.02, self.tick)
        self.get_logger().info('Differential drive: production control core, radius 0.1 m, track 0.5 m; ideal wheel response')

    def on_joy(self, msg):
        # SDL standard layout: B latches stop; A releases it. B takes priority.
        if len(msg.buttons) > 1:
            if msg.buttons[1]:
                self.estop = True
            elif msg.buttons[0]:
                self.estop = False

    def on_command(self, msg):
        if math.isfinite(msg.linear.x) and math.isfinite(msg.angular.z):
            self.target = (msg.linear.x, msg.angular.z)
            self.last_cmd = time.monotonic()

    def on_stop(self, msg):
        self.blocked = msg.active
        self.last_stop = time.monotonic()

    def on_run(self, request, response):
        if request.data and not self.demo_mode:
            response.success = False
            response.message = 'Controller mode: restart with demo:=true for automatic driving'
            return response
        self.running = request.data
        self.target = (0., 0.)
        self.last_cmd = 0.
        # Clear the upstream command when stopping automatic Joy input.
        if not self.running:
            self.joy.publish(Joy(axes=[0.] * 8, buttons=[0] * 8))
        response.success = True
        response.message = 'Demo running' if self.running else 'Demo stopped; manual Joy available'
        return response

    def on_estop(self, request, response):
        self.estop = request.data
        self.target = (0., 0.)
        self.last_cmd = 0.
        response.success = True
        response.message = 'Simulation emergency stop ' + str(self.estop)
        return response

    def on_reset(self, request, response):
        self.x = self.y = self.yaw = 0.
        self.drive.reset()
        self.history.clear()
        response.success = True
        response.message = 'Pose and trail reset'
        return response

    def tick(self):
        now = time.monotonic()
        dt = min(now - self.last_tick, 0.1)
        self.last_tick = now
        self.gpio.publish(Bool(data=self.estop))
        if self.running:
            self.joy.publish(Joy(axes=[0., 0.3, 0., 0.4 / 6., 0., 0., 0., 0.],
                                 buttons=[0] * 8))
        v, w = self.target
        if self.estop or self.blocked or now-self.last_stop > 1. or now-self.last_cmd > 1.:
            self.drive.reset()
            left = right = v = w = 0.
        else:
            left, right, v, w = self.drive.step(v, w, dt)
        if abs(w) > 1e-9:
            self.x += v / w * (math.sin(self.yaw+w*dt)-math.sin(self.yaw))
            self.y -= v / w * (math.cos(self.yaw+w*dt)-math.cos(self.yaw))
        else:
            self.x += v * math.cos(self.yaw) * dt
            self.y += v * math.sin(self.yaw) * dt
        self.yaw = math.remainder(self.yaw+w*dt, 2*math.pi)
        msg = Odometry()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = 'odom'
        msg.child_frame_id = 'base_link'
        msg.pose.pose.position.x, msg.pose.pose.position.y = self.x, self.y
        msg.pose.pose.orientation.z = math.sin(self.yaw/2)
        msg.pose.pose.orientation.w = math.cos(self.yaw/2)
        msg.twist.twist.linear.x, msg.twist.twist.angular.z = v, w
        self.odom.publish(msg)
        status = DriveStatus(header=msg.header)
        status.left.motor_id = self.drive.config['left_motor_id']
        status.right.motor_id = self.drive.config['right_motor_id']
        for wheel, rpm in ((status.left, left), (status.right, right)):
            wheel.header = msg.header
            wheel.mode = 2
            wheel.target_rpm = wheel.velocity_rpm = int(rpm)
        status.linear_velocity, status.angular_velocity = v, w
        status.emergency_stop = self.estop or self.blocked
        self.wheels.publish(status)
        tf = TransformStamped()
        tf.header = msg.header
        tf.child_frame_id = msg.child_frame_id
        tf.transform.translation.x, tf.transform.translation.y = self.x, self.y
        tf.transform.rotation = msg.pose.pose.orientation
        self.tf.sendTransform(tf)
        self.counter += 1
        if self.counter % 5 == 0:
            pose = PoseStamped(header=msg.header, pose=msg.pose.pose)
            self.history.append(pose)
            self.path.publish(Path(header=msg.header, poses=list(self.history)))


def main():
    rclpy.init()
    node = DriveSimulation()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.drive.close()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
