#!/usr/bin/env python3
"""Local Blockly plan runner for the isolated QUESTiX simulation (domain 75)."""
import argparse
import json
import math
import os
from pathlib import Path
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import rclpy
from rclpy.node import Node
from ament_index_python.packages import get_package_share_directory
from nav_msgs.msg import Odometry
from sensor_msgs.msg import Joy

PORT = 5174
DOMAIN = 75
LINEAR_SCALE = 2.0
ANGULAR_SCALE = 6.0

def web_root():
    return Path(get_package_share_directory('questix_blockly')) / 'web'


def validate_plan(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 200:
        raise ValueError('動作は1〜200個にしてください')
    result = []
    for step in value:
        if not isinstance(step, dict) or set(step) != {'v', 'w', 'seconds'}:
            raise ValueError('動作の形式が不正です')
        for field, limit in [('v', 0.8), ('w', 1.5), ('seconds', 10)]:
            x = step[field]
            if type(x) not in (float, int) or not math.isfinite(x) or abs(x) > limit:
                raise ValueError(f'{field} が範囲外です')
        if step['seconds'] < 0.1:
            raise ValueError('時間は0.1〜10秒にしてください')
        result.append(dict(step))
    if sum(s['seconds'] for s in result) > 120:
        raise ValueError('合計時間は120秒以内にしてください')
    return result


class Bridge(Node):
    def __init__(self):
        super().__init__('blockly_plan_runner')
        self.lock = threading.RLock()
        self.mode = 'blockly'
        self.controller_armed = False
        self.controller_neutral = False
        self.last_controller = 0.
        self.controller_msg = None
        self.create_subscription(Joy, '/blockly/controller_joy', self.on_controller, 10)
        self.pub = self.create_publisher(Joy, '/joy', 10)
        self.create_subscription(Odometry, '/odom', self.on_odom, 10)
        self.pose = dict(x=0., y=0., yaw=0., v=0., w=0.)
        self.last_odom = 0.
        self.plan = []
        self.run_id = ''
        self.cancelled = set()
        self.index = 0
        self.deadline = 0.
        self.heartbeat = 0.
        self.reason = '待機中'
        self.create_timer(0.02, self.tick)

    def on_controller(self, msg):
        with self.lock:
            if self.mode != 'controller':
                return
            self.last_controller = time.monotonic()
            if len(msg.axes) < 3 or len(msg.buttons) < 2 or not all(
                    math.isfinite(x) and abs(x) <= 1 for x in msg.axes):
                self.controller_armed = False
                self.controller_msg = None
                return
            if msg.buttons[1]:
                self.controller_armed = False
                self.controller_neutral = False
            neutral = all(abs(x) < 0.05 for x in msg.axes[:3])
            if neutral:
                self.controller_neutral = True
            if self.controller_neutral and neutral and msg.buttons[0] and not msg.buttons[1]:
                self.controller_armed = True
            self.controller_msg = msg

    def on_odom(self, msg):
        q = msg.pose.pose.orientation
        with self.lock:
            self.pose = dict(x=msg.pose.pose.position.x, y=msg.pose.pose.position.y,
                             yaw=math.atan2(2*q.w*q.z, 1-2*q.z*q.z),
                             v=msg.twist.twist.linear.x, w=msg.twist.twist.angular.z)
            self.last_odom = time.monotonic()

    def ready(self):
        return time.monotonic() - self.last_odom < 0.7

    def stop(self, reason):
        self.plan = []
        self.controller_armed = False
        self.controller_neutral = False
        self.reason = reason
        self.publish(0., 0., False)

    def publish(self, v, w, active):
        # Axis layout matches simulation.launch.py; scales come from joy_controller config.
        self.pub.publish(Joy(axes=[0., v/LINEAR_SCALE, w/ANGULAR_SCALE, 0., 0., 0.],
                             buttons=[int(active), int(not active)] + [0]*19))

    def tick(self):
        with self.lock:
            now = time.monotonic()
            if self.mode == 'controller':
                if now-self.last_controller > 0.5 or not self.ready():
                    self.controller_armed = False
                    self.controller_neutral = False
                if self.controller_armed and self.controller_msg is not None:
                    self.pub.publish(self.controller_msg)
                else:
                    self.publish(0., 0., False)
                return
            if self.plan and (now-self.heartbeat > 1.2 or not self.ready()):
                self.stop('通信が途切れたため停止しました')
            if not self.plan:
                self.publish(0., 0., False)
                return
            if self.index == -1:
                # Allow the operation_manager/joy_gate chain to release its stop gate.
                if now < self.deadline:
                    self.publish(0., 0., True)
                    return
                self.index = 0
                self.deadline = now + self.plan[0]['seconds']
            elif now >= self.deadline:
                self.index += 1
                if self.index >= len(self.plan):
                    self.stop('実行完了')
                    return
                self.deadline = now + self.plan[self.index]['seconds']
            step = self.plan[self.index]
            self.publish(float(step['v']), float(step['w']), True)

    def status(self):
        with self.lock:
            return dict(mode=self.mode, controller_armed=self.controller_armed, connected=self.ready(), running=bool(self.plan), id=self.run_id,
                        step=max(0, self.index+1), total=len(self.plan),
                        reason=self.reason, pose=self.pose, domain=DOMAIN)

    def command(self, path, data):
        with self.lock:
            if path == '/api/mode':
                mode = data.get('mode')
                if mode not in ('blockly', 'controller'):
                    raise ValueError('不明な操作元です')
                if self.run_id:
                    self.cancelled.add(self.run_id)
                self.stop('操作元を切り替えました')
                self.mode = mode
                self.last_controller = 0.
                self.controller_msg = None
                return self.status()
            run_id = data.get('id')
            if not isinstance(run_id, str) or not 1 <= len(run_id) <= 80:
                raise ValueError('実行IDが不正です')
            if path == '/api/stop':
                # Remember cancelled requests so a delayed /run cannot restart motion.
                if len(self.cancelled) > 10000:
                    raise ValueError('サーバーを再起動してください')
                self.cancelled.add(run_id)
                if run_id == self.run_id:
                    self.stop('停止しました')
            elif path == '/api/heartbeat':
                if run_id == self.run_id and self.plan:
                    self.heartbeat = time.monotonic()
            elif path == '/api/run':
                if self.mode != 'blockly':
                    raise ValueError('操作元をBlocklyに切り替えてください')
                plan = validate_plan(data.get('plan'))
                if run_id in self.cancelled or run_id == self.run_id:
                    raise ValueError('この実行は停止済み、または開始済みです')
                if self.plan:
                    raise ValueError('実行中です。先に停止してください')
                if not self.ready():
                    raise ValueError('ROSシミュレーションが未接続です')
                self.run_id, self.plan, self.index = run_id, plan, -1
                self.heartbeat = time.monotonic()
                self.deadline = self.heartbeat + 0.4
                self.reason = '実行中'
            else:
                raise ValueError('不明な操作です')
            return self.status()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(web_root()), **kwargs)

    def log_message(self, *args):
        pass

    def allowed(self):
        host = self.headers.get('Host', '')
        if host not in (f'127.0.0.1:{PORT}', f'localhost:{PORT}'):
            return False
        origin = self.headers.get('Origin')
        return not origin or origin == 'http://' + host

    def reply(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.allowed():
            return self.reply(403, {'error': 'localhost only'})
        if urlparse(self.path).path == '/api/status':
            return self.reply(200, self.server.node.status())
        super().do_GET()

    def do_POST(self):
        if not self.allowed() or self.headers.get('Content-Type') != 'application/json':
            return self.reply(403, {'error': 'same-origin JSON only'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 65536:
                raise ValueError('リクエストが大きすぎます')
            self.connection.settimeout(2)
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError('JSON object required')
            result = self.server.node.command(self.path, data)
            self.reply(200, result)
        except (ValueError, TypeError, TimeoutError) as exc:
            self.reply(400, {'error': str(exc)})


def main():
    global PORT, DOMAIN, LINEAR_SCALE, ANGULAR_SCALE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=5174)
    parser.add_argument('--domain', type=int, default=75)
    parser.add_argument('--linear-scale', type=float, default=2.0)
    parser.add_argument('--angular-scale', type=float, default=6.0)
    options, ros_args = parser.parse_known_args()
    PORT, DOMAIN = options.port, options.domain
    LINEAR_SCALE, ANGULAR_SCALE = options.linear_scale, options.angular_scale
    if not all(math.isfinite(x) and x > 0 for x in (LINEAR_SCALE, ANGULAR_SCALE)):
        raise ValueError("Invalid Joy scaling")
    if os.environ.get('ROS_DOMAIN_ID') != str(DOMAIN):
        raise RuntimeError('ROS_DOMAIN_ID must match the simulation domain')
    if not (web_root() / 'index.html').is_file():
        raise RuntimeError('Build web assets with npm ci && npm run build in questix_blockly/web, '
                           'then rebuild the ROS package with colcon build.')
    rclpy.init(args=ros_args)
    node = Bridge()
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    server.node = node
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f'QUESTiX Blockly: http://127.0.0.1:{PORT} (ROS domain {DOMAIN})', flush=True)
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        with node.lock:
            if rclpy.ok():
                node.stop('終了')
        server.shutdown()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
