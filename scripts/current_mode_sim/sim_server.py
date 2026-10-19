#!/usr/bin/env python3
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""Run drive_component against fake motors and stream it to a browser over WebSocket.

Simulation (default): fake M0602C motors on a pseudo terminal (fake_ddt_motor.py), the real
drive_component node from this workspace in current mode, and a monitor that publishes
/target_twist from the page and streams /drive_control_sample plus the fake wheels' true speed
to http://127.0.0.1:8765/. The ROS graph is kept on this machine (ROS_AUTOMATIC_DISCOVERY_RANGE
LOCALHOST and its own ROS_DOMAIN_ID), so the simulated /target_twist never reaches a robot.

Robot (--robot): read-only view of a running robot's /drive_control_sample in the current
ROS environment. Nothing is published and no parameter is changed.

Needs a sourced ROS 2 Jazzy and this workspace (source install/setup.bash) and the
`websockets` package. See README.md next to this file.
"""

import argparse
import asyncio
import json
import math
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http import HTTPStatus
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
# The integrated drive configuration of this checkout (--params-file overrides it).
DRIVE_YAML = REPO_ROOT / 'launcher' / 'config' / 'drive_component.yaml'

PARAM_KEYS = (
    'current_kp', 'current_ki', 'max_current_amp', 'integral_limit_amp',
    'current_ff_static_amp', 'current_ff_viscous_amp_per_rpm', 'current_invert_measured',
    'current_guard_overspeed_margin_rpm', 'current_guard_overspeed_time_sec',
)

# Twist profiles. 'rpm' steps are (linear wheel rpm, turning wheel rpm, hold s): a turning rpm
# drives the left wheel back and the right wheel forward. 'twist' steps are (m/s, rad/s, hold s).
# The node's own acceleration limit shapes every step.
_SQUARE_SIDE = [(0.4, 0.0, 2.0), (0.0, 0.0, 0.6), (0.0, 1.2, 1.31), (0.0, 0.0, 0.6)]
PROFILES = {
    'steps': ('段階（12 s）', 'rpm', [(100, 0, 1.5), (300, 0, 2.0), (-200, 0, 2.5), (0, 0, 1.5),
                                    (400, 0, 2.5), (0, 0, 2.0)]),
    'constant100': ('一定 100 rpm（4 s）', 'rpm', [(100, 0, 4.0), (0, 0, 1.5)]),
    'slow': ('低速 30→60 rpm', 'rpm', [(30, 0, 3.0), (60, 0, 3.0), (0, 0, 1.5)]),
    'spin': ('その場旋回 ±100 rpm', 'rpm', [(0, 100, 3.0), (0, 0, 1.5)]),
    'square': ('四角形（1 辺 約 0.8 m）', 'twist', _SQUARE_SIDE * 4 + [(0.0, 0.0, 1.0)]),
    'slalom': ('S 字', 'twist', [(0.4, 1.2, 2.0), (0.4, -1.2, 2.0)] * 2 + [(0.0, 0.0, 1.5)]),
    'circle': ('円（半径 0.5 m）', 'twist', [(0.3, 0.6, 10.5), (0.0, 0.0, 1.5)]),
}

GUARD_TEXT = {
    'against': 'ブレーキ方向の電流なのに加速した（current_invert_measured の符号が逆＝正帰還の可能性）',
    'overspeed': '目標より速いまま減速しない（摩擦補償の過補償・外力・符号）',
    'oscillation': '電流が上限で正負に振れている（負荷に対してゲインが高すぎる。浮かせた車輪に床用ゲイン、'
                   '走行中に持ち上げた等）',
    'stale': '応答が続けて無いため電流 0（ラッチしない）',
    'mode': 'モータが電流ループを報告していない（電流指令が速度目標として解釈されるため停止）',
    'none': '',
}

TICK_ACTIONS = {0: 'idle', 1: 'drive', 2: 'timeout_stop', 3: 'fault_stop'}
AMP_PER_RAW = 8.0 / 32767.0
ANSI = re.compile(r'\x1b\[[0-9;]*m')
TRIP_LIB = re.compile(r'モーター (\d+): 電流モード暴走ガード作動（(\w+)）')
CLEAR_LIB = re.compile(r'モーター (\d+) の電流モード暴走ガード')
TRIP_NODE = re.compile(r'Current guard tripped: (left|right) wheel \(motor (\d+)\), reason (\w+)')


def load_drive_yaml(path):
    """Return drive_component's ros__parameters from the given configuration file."""
    import yaml
    with open(path, encoding='utf-8') as f:
        return yaml.safe_load(f)['drive_component']['ros__parameters']


class Hub:
    """Thread-safe hand-off of messages to the asyncio side, which broadcasts them."""

    def __init__(self):
        self.loop = None
        self.queue = None

    def bind(self, loop):
        """Attach to the running event loop."""
        self.loop = loop
        self.queue = asyncio.Queue(maxsize=2000)

    def post(self, message):
        """Queue a message for every connected page (any thread)."""
        if self.loop is None or self.loop.is_closed():
            return

        def put():
            if self.queue.full():
                try:
                    self.queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            self.queue.put_nowait(message)

        try:
            self.loop.call_soon_threadsafe(put)
        except RuntimeError:
            pass  # the server is shutting down


class Monitor:
    """The ROS side: subscriptions, the twist source and the parameter/lifecycle clients."""

    def __init__(self, hub, bus, robot_mode, wheel_radius, wheel_separation, motor_ids):
        import rclpy
        from geometry_msgs.msg import Twist
        from lifecycle_msgs.srv import ChangeState, GetState
        from nav_msgs.msg import Odometry
        from questix_msgs.msg import DriveControlSample
        from rcl_interfaces.msg import Log
        from rcl_interfaces.srv import GetParameters, SetParametersAtomically
        from rclpy.qos import QoSProfile, ReliabilityPolicy

        self.rclpy = rclpy
        self.hub = hub
        self.bus = bus
        self.robot_mode = robot_mode
        self.wheel_radius = wheel_radius
        self.wheel_separation = wheel_separation
        self.left_id, self.right_id = motor_ids
        self.Twist = Twist
        self.node = rclpy.create_node('current_mode_sim_monitor')
        reliable = QoSProfile(depth=100, reliability=ReliabilityPolicy.RELIABLE)
        self.node.create_subscription(DriveControlSample, '/drive_control_sample',
                                      self._on_sample, reliable)
        if robot_mode:
            self.node.create_subscription(Log, '/rosout', self._on_rosout, reliable)
        self.node.create_subscription(Odometry, '/odom', self._on_odom, 10)
        self._odom = None  # (x, y, yaw, v, w) as published
        self._odom_origin = None  # pose the display treats as the origin (set by reset_pose)
        # The fake robot's pose when that /odom arrived: /odom is published every 20 ms by its own
        # timer, so comparing it with the pose at a later moment would count that delay as error.
        self._truth_at_odom = None
        self.t0 = None
        self._lock = threading.Lock()
        self._profile = None  # (steps, start time)
        self._manual = None  # (linear, angular, last time)
        self._neutral_until = 0.0
        self._twist_pub = None
        if not robot_mode:
            self._twist_pub = self.node.create_publisher(Twist, '/target_twist', 1)
            self.node.create_timer(0.02, self._publish_twist)
        self._get_params = self.node.create_client(GetParameters, '/drive_component/get_parameters')
        self._set_params = self.node.create_client(
            SetParametersAtomically, '/drive_component/set_parameters_atomically')
        self._change_state = self.node.create_client(ChangeState, '/drive_component/change_state')
        self._get_state = self.node.create_client(GetState, '/drive_component/get_state')
        self._srv = (GetParameters, SetParametersAtomically, ChangeState, GetState)
        from rclpy.executors import SingleThreadedExecutor
        self._executor = SingleThreadedExecutor()
        self._executor.add_node(self.node)
        self._thread = threading.Thread(target=self._spin, daemon=True)
        self._thread.start()

    def _spin(self):
        try:
            self._executor.spin()
        except Exception:  # noqa: BLE001 - the context was shut down while spinning
            pass

    def close(self):
        """Stop spinning and release the node (call after rclpy.shutdown())."""
        self._executor.shutdown(timeout_sec=1.0)
        self._thread.join(timeout=2.0)
        self.node.destroy_node()

    # ---- streaming ------------------------------------------------------------------------
    def _wheel(self, wheel, true_rpm):
        out = {
            'ref_rpm': wheel.ref_rpm,
            'command_rpm': wheel.command_rpm,
            'measured_rpm': wheel.velocity_rpm_raw,
            'mode': wheel.mode,
            'current_cmd_amp': round(wheel.command_current_raw * AMP_PER_RAW, 4),
            'current_meas_amp': round(wheel.current_raw * AMP_PER_RAW, 4),
            'feedback_new': bool(wheel.feedback_new),
        }
        if true_rpm is not None:
            out['true_rpm'] = round(true_rpm, 2)
        return out

    def _on_odom(self, msg):
        q = msg.pose.pose.orientation
        yaw = math.atan2(2.0 * (q.w * q.z + q.x * q.y), 1.0 - 2.0 * (q.y * q.y + q.z * q.z))
        truth = self.bus.robot_snapshot() if self.bus is not None else None
        with self._lock:
            self._odom = (msg.pose.pose.position.x, msg.pose.pose.position.y, yaw,
                          msg.twist.twist.linear.x, msg.twist.twist.angular.z)
            self._truth_at_odom = truth
            if self._odom_origin is None:
                self._odom_origin = self._odom[:3]

    def _odom_relative(self):
        """Return /odom as seen from the pose recorded at the last reset (or None)."""
        with self._lock:
            if self._odom is None or self._odom_origin is None:
                return None
            x, y, yaw, v, w = self._odom
            x0, y0, yaw0 = self._odom_origin
        dx, dy = x - x0, y - y0
        c, s = math.cos(yaw0), math.sin(yaw0)
        return {'x': round(c * dx + s * dy, 4), 'y': round(-s * dx + c * dy, 4),
                'theta': round(math.atan2(math.sin(yaw - yaw0), math.cos(yaw - yaw0)), 4),
                'v': round(v, 4), 'w': round(w, 4)}

    def reset_pose(self):
        """Treat the present /odom pose as the origin (the fake robot is reset separately)."""
        with self._lock:
            self._odom_origin = self._odom[:3] if self._odom else None

    def _on_sample(self, msg):
        stamp = msg.header.stamp.sec + msg.header.stamp.nanosec * 1e-9
        if self.t0 is None:
            self.t0 = stamp
        truth = self.bus.snapshot() if self.bus else {}
        left_true = truth.get(self.left_id, (None,))[0]
        right_true = truth.get(self.right_id, (None,))[0]
        message = {
            'type': 'sample',
            't': round(stamp - self.t0, 4),
            'wheels': {'left': self._wheel(msg.left, left_true),
                       'right': self._wheel(msg.right, right_true)},
            'tick_action': TICK_ACTIONS.get(msg.tick_action, str(msg.tick_action)),
            'shaped_linear': round(msg.shaped_linear, 4),
            'shaped_angular': round(msg.shaped_angular, 4),
            'command_sent': bool(msg.command_sent),
            'control_mode': msg.control_mode,
            'odom': self._odom_relative(),
        }
        if self.bus is not None:
            robot = self.bus.robot_snapshot()
            message['robot'] = {k: (round(v, 4) if isinstance(v, float) else v)
                                for k, v in robot.items()}
            with self._lock:
                truth = self._truth_at_odom
            if truth is not None and message['odom'] is not None:
                message['odom_truth'] = {k: round(truth[k], 4) for k in ('x', 'y', 'theta', 'v')}
        self.hub.post(message)

    def _on_rosout(self, msg):
        if msg.name != 'drive_component' or msg.level < 30:  # WARN and above
            return
        handle_log_line(self.hub, msg.msg, 'error' if msg.level >= 40 else 'warn',
                        self.left_id, self.right_id)

    # ---- twist source (simulation only) ------------------------------------------------------
    def _wheel_rpm_to_twist(self, linear_rpm, turn_rpm):
        meters_per_rev = 2.0 * math.pi * self.wheel_radius
        linear = linear_rpm * meters_per_rev / 60.0
        # turn_rpm on each wheel in opposite directions -> angular = 2 v / separation
        angular = 2.0 * (turn_rpm * meters_per_rev / 60.0) / self.wheel_separation
        return linear, angular

    def _publish_twist(self):
        if self._twist_pub is None:
            return  # --robot is strictly read-only
        now = time.monotonic()
        with self._lock:
            # An idle simulator continuously supplies neutral. A fresh operation
            # also prepares zero for five 20 ms ticks; depth 1 is not an ack.
            twist = (0.0, 0.0)
            if now < self._neutral_until:
                pass
            elif self._profile is not None:
                (_, unit, steps), start = self._profile
                elapsed = now - start
                for a, b, hold in steps:
                    if elapsed < hold:
                        twist = self._wheel_rpm_to_twist(a, b) if unit == 'rpm' else (a, b)
                        break
                    elapsed -= hold
                else:
                    self._profile = None
                    twist = (0.0, 0.0)
            elif self._manual is not None:
                linear, angular, last = self._manual
                if now - last < 0.5:
                    twist = (linear, angular)
                else:
                    self._manual = None
        if twist is not None:
            msg = self.Twist()
            msg.linear.x, msg.angular.z = twist
            self._twist_pub.publish(msg)

    def run_profile(self, name):
        """Start a twist profile from PROFILES."""
        with self._lock:
            self._manual = None
            self._neutral_until = time.monotonic() + 0.1
            self._profile = (PROFILES[name], self._neutral_until)

    def manual(self, linear, angular):
        """Keep publishing this twist while the page keeps sending it."""
        with self._lock:
            if self._manual is None:
                self._neutral_until = time.monotonic() + 0.1
            self._profile = None
            self._manual = (float(linear), float(angular), time.monotonic())

    def stop(self):
        """Stop the profile and the manual twist, and command zero now."""
        with self._lock:
            self._profile = None
            self._manual = None
        if self._twist_pub is not None:
            for _ in range(3):
                self._twist_pub.publish(self.Twist())

    # ---- services (blocking; call from a worker thread) --------------------------------------
    def _call(self, client, request, timeout=3.0):
        if not client.wait_for_service(timeout_sec=timeout):
            raise RuntimeError('drive_component のサービスに接続できません（ノードは起動していますか）')
        done = threading.Event()
        future = client.call_async(request)
        future.add_done_callback(lambda _: done.set())
        if not done.wait(timeout):
            raise RuntimeError('drive_component が応答しません')
        return future.result()

    def get_params(self):
        """Return the current-mode parameters of drive_component as a dict."""
        GetParameters = self._srv[0]
        request = GetParameters.Request(names=list(PARAM_KEYS))
        response = self._call(self._get_params, request)
        out = {}
        for name, value in zip(PARAM_KEYS, response.values):
            if value.type == 1:
                out[name] = bool(value.bool_value)
            elif value.type == 3:
                out[name] = value.double_value
            elif value.type == 2:
                out[name] = value.integer_value
        return out

    def set_params(self, params):
        """Set parameters atomically on drive_component; raise with the node's reason."""
        from rcl_interfaces.msg import Parameter, ParameterValue
        SetParametersAtomically = self._srv[1]
        request = SetParametersAtomically.Request()
        for name, value in params.items():
            if name not in PARAM_KEYS:
                raise RuntimeError(f'変更できないパラメータです: {name}')
            if isinstance(value, bool):
                pv = ParameterValue(type=1, bool_value=value)
            else:
                pv = ParameterValue(type=3, double_value=float(value))
            request.parameters.append(Parameter(name=name, value=pv))
        response = self._call(self._set_params, request)
        if not response.result.successful:
            raise RuntimeError(response.result.reason)

    def reset_node(self):
        """Re-run drive_component's lifecycle (deactivate, cleanup, configure, activate)."""
        ChangeState, GetState = self._srv[2], self._srv[3]
        from lifecycle_msgs.msg import Transition
        state = self._call(self._get_state, GetState.Request()).current_state.label
        sequence = {
            'active': [Transition.TRANSITION_DEACTIVATE, Transition.TRANSITION_CLEANUP,
                       Transition.TRANSITION_CONFIGURE, Transition.TRANSITION_ACTIVATE],
            'inactive': [Transition.TRANSITION_CLEANUP, Transition.TRANSITION_CONFIGURE,
                         Transition.TRANSITION_ACTIVATE],
            'unconfigured': [Transition.TRANSITION_CONFIGURE, Transition.TRANSITION_ACTIVATE],
        }.get(state)
        if sequence is None:
            raise RuntimeError(f'drive_component の状態 {state} からは再起動できません')
        for transition in sequence:
            request = ChangeState.Request()
            request.transition.id = transition
            if not self._call(self._change_state, request, timeout=10.0).success:
                raise RuntimeError(f'lifecycle の遷移 {transition} に失敗しました')


def handle_log_line(hub, text, level, left_id, right_id):
    """Forward one drive_component log line and turn guard lines into guard messages."""
    wheel_of = {left_id: 'left', right_id: 'right'}
    match = TRIP_NODE.search(text)
    if match:
        reason = match.group(3)
        hub.post({'type': 'guard', 'wheel': match.group(1), 'reason': reason,
                  'text': GUARD_TEXT.get(reason, reason), 't': time.time()})
    match = TRIP_LIB.search(text)
    if match and int(match.group(1)) in wheel_of:
        reason = match.group(2)
        hub.post({'type': 'guard', 'wheel': wheel_of[int(match.group(1))], 'reason': reason,
                  'text': GUARD_TEXT.get(reason, reason) + ' / ' + text, 't': time.time()})
    elif '解除しました' in text:
        match = CLEAR_LIB.search(text)
        if match and int(match.group(1)) in wheel_of:
            hub.post({'type': 'guard', 'wheel': wheel_of[int(match.group(1))], 'reason': 'none',
                      'text': '', 't': time.time()})
    hub.post({'type': 'log', 'level': level, 'text': text})


class NodeProcess:
    """drive_component as a child process, with its log lines forwarded to the page."""

    def __init__(self, hub, port, control_mode, left_id, right_id, params_file):
        self.hub = hub
        self.left_id, self.right_id = left_id, right_id
        cmd = ['ros2', 'run', 'motor_control_app', 'drive_component_node', '--ros-args',
               '--params-file', str(params_file),
               '-p', f'serial_port:={port}',
               '-p', f'control_mode:={control_mode}',
               # Standalone diagnostic without operation_manager: explicitly opt out of both
               # safety inputs only in this isolated simulator domain.
               '-p', 'require_emergency_stop:=false',
               '-p', 'require_motion_permission:=false']
        print('[sim] starting:', ' '.join(cmd), flush=True)
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, bufsize=1, start_new_session=True)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for raw in self.proc.stdout:
            line = ANSI.sub('', raw.rstrip())
            if 'PI motor=' in line:
                continue  # 5 Hz tuning log: in the terminal only when asked
            print('[drive]', line, flush=True)
            level = 'error' if '[ERROR]' in line else 'warn' if '[WARN]' in line else 'info'
            text = line.split(']: ', 1)[-1]
            handle_log_line(self.hub, text, level, self.left_id, self.right_id)
        self.hub.post({'type': 'log', 'level': 'error',
                       'text': f'drive_component が終了しました（code {self.proc.wait()}）'})

    def stop(self):
        """Stop the node (SIGINT, then SIGKILL after 5 s)."""
        if self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGINT)
            try:
                self.proc.wait(5.0)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)


async def serve(args, hub, monitor, bus, robot_mode):
    """Serve the page and the WebSocket until interrupted."""
    from websockets.asyncio.server import broadcast, serve as ws_serve
    from websockets.datastructures import Headers
    from websockets.http11 import Response

    from fake_ddt_motor import PLANTS

    hub.bind(asyncio.get_running_loop())
    clients = set()
    state = {'plant': args.plant, 'floor_plant': 'floor6' if PLANTS[args.plant].lifted
             else args.plant}

    def process_request(connection, request):
        if request.path.split('?')[0] == '/ws':
            return None
        if request.path.split('?')[0] in ('/', '/index.html'):
            body = (HERE / 'index.html').read_bytes()
            return Response(HTTPStatus.OK.value, 'OK', Headers([
                ('Content-Type', 'text/html; charset=utf-8'),
                ('Content-Length', str(len(body))), ('Cache-Control', 'no-store')]), body)
        return connection.respond(HTTPStatus.NOT_FOUND, 'not found\n')

    async def hello(ws):
        params = {}
        try:
            params = await asyncio.get_running_loop().run_in_executor(None, monitor.get_params)
        except RuntimeError as error:
            await ws.send(json.dumps({'type': 'error', 'text': str(error)}))
        await ws.send(json.dumps({
            'type': 'hello',
            'source': 'robot' if robot_mode else 'sim',
            'plants': [{'id': k, 'label': v.label, 'lifted': v.lifted} for k, v in PLANTS.items()],
            'profiles': [{'id': k, 'label': v[0]} for k, v in PROFILES.items()],
            'params': params,
            'geometry': {'wheel_radius': monitor.wheel_radius,
                         'wheel_separation': monitor.wheel_separation},
        }, ensure_ascii=False))
        if bus is not None:
            plant = PLANTS[state['plant']]
            await ws.send(json.dumps({'type': 'plant', 'plant': state['plant'],
                                      'label': plant.label, 'lifted': plant.lifted},
                                     ensure_ascii=False))

    async def command(ws, message):
        loop = asyncio.get_running_loop()
        kind = message.get('type')
        if kind == 'reset_pose':  # display only on a real robot: /odom is not touched
            if bus is not None:
                bus.reset_pose()
            monitor.reset_pose()
            broadcast(clients, json.dumps({'type': 'pose_reset'}))
            return
        if robot_mode:
            raise RuntimeError('実機の表示中は操作できません（読み取りのみ）')
        if kind in ('set_plant', 'pick_up', 'put_down'):
            if kind == 'set_plant':
                plant = message.get('plant')
                if plant not in PLANTS:
                    raise RuntimeError(f'不明な負荷です: {plant}')
            elif kind == 'pick_up':
                if not PLANTS[state['plant']].lifted:
                    state['floor_plant'] = state['plant']
                plant = 'lifted'
            else:
                plant = state['floor_plant']
            if not PLANTS[plant].lifted:
                state['floor_plant'] = plant
            state['plant'] = plant
            bus.set_plant(plant)
            broadcast(clients, json.dumps({'type': 'plant', 'plant': plant,
                                           'label': PLANTS[plant].label,
                                           'lifted': PLANTS[plant].lifted},
                                          ensure_ascii=False))
        elif kind == 'run_profile':
            if message.get('profile') not in PROFILES:
                raise RuntimeError('不明な走行パターンです')
            monitor.run_profile(message['profile'])
        elif kind == 'stop':
            monitor.stop()
        elif kind == 'twist':
            linear = max(-0.6, min(0.6, float(message.get('linear', 0.0))))
            angular = max(-3.0, min(3.0, float(message.get('angular', 0.0))))
            monitor.manual(linear, angular)
        elif kind == 'set_params':
            params = message.get('params') or {}
            await loop.run_in_executor(None, monitor.set_params, params)
            fresh = await loop.run_in_executor(None, monitor.get_params)
            broadcast(clients, json.dumps({'type': 'params', 'params': fresh}))
        elif kind == 'clear_guard':
            # Setting a current-mode parameter clears the latch (DdtMotorLib); set current_kp to
            # the value it already has, so nothing else changes.
            present = await loop.run_in_executor(None, monitor.get_params)
            await loop.run_in_executor(None, monitor.set_params,
                                       {'current_kp': present['current_kp']})
        elif kind == 'reset_node':
            monitor.stop()
            await loop.run_in_executor(None, monitor.reset_node)
            for wheel in ('left', 'right'):
                broadcast(clients, json.dumps({'type': 'guard', 'wheel': wheel, 'reason': 'none',
                                               'text': '', 't': time.time()}))
        elif kind == 'drop_answers':
            bus.drop_answers = bool(message.get('on'))
        else:
            raise RuntimeError(f'不明な操作です: {kind}')

    async def handler(ws):
        clients.add(ws)
        try:
            await hello(ws)
            async for raw in ws:
                try:
                    await command(ws, json.loads(raw))
                except (RuntimeError, ValueError, TypeError, KeyError) as error:
                    await ws.send(json.dumps({'type': 'error', 'text': str(error)},
                                             ensure_ascii=False))
        finally:
            clients.discard(ws)

    async def pump():
        while True:
            message = await hub.queue.get()
            if clients:
                broadcast(clients, json.dumps(message, ensure_ascii=False))

    async with ws_serve(handler, args.host, args.port, process_request=process_request,
                        compression=None):
        print(f'[sim] open http://{args.host}:{args.port}/', flush=True)
        await pump()


def main():
    """Parse arguments, start the pieces and serve until Ctrl-C."""
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--plant', default='lifted', help='lifted, lifted_light, lifted_heavy, '
                        'floor6, floor10')
    parser.add_argument('--control-mode', default='current', choices=('current', 'velocity'))
    parser.add_argument('--domain-id', type=int, default=87,
                        help='ROS_DOMAIN_ID of the simulation (kept on localhost)')
    parser.add_argument('--no-spawn', action='store_true',
                        help='do not start drive_component (start it yourself on the printed port)')
    parser.add_argument('--robot', action='store_true',
                        help='read-only view of a running robot in the current ROS environment')
    parser.add_argument('--noise-rpm', type=float, default=1.0)
    parser.add_argument('--report-dead-time-ms', type=float, default=0.0,
                        help='delay the reported speed by this dead time (Issue #222: about 40)')
    parser.add_argument('--report-tau-ms', type=float, default=0.0,
                        help='and by a first-order lag of this time constant (about 100)')
    parser.add_argument('--params-file', default=str(DRIVE_YAML),
                        help='drive_component.yaml to load (default: launcher/config/ of this '
                        'checkout)')
    parser.add_argument('--mode-frames', default='spec', choices=('spec', 'legacy', 'never'),
                        help='which Protocol 3 layout the fake motors accept (spec sheet: spec)')
    args = parser.parse_args()

    sys.path.insert(0, str(HERE))
    from fake_ddt_motor import FakeDdtBus, PLANTS
    if args.plant not in PLANTS:
        parser.error(f'--plant must be one of {", ".join(PLANTS)}')

    def on_term(*_):
        raise KeyboardInterrupt  # the same clean-up as Ctrl-C (zero twist, stop the node)

    signal.signal(signal.SIGTERM, on_term)

    if not Path(args.params_file).is_file():
        parser.error(f'{args.params_file} が見つかりません。QUESTiX のチェックアウトの '
                     'launcher/config/drive_component.yaml を --params-file で指定してください')
    params = load_drive_yaml(args.params_file)
    motor_ids = (int(params['left_motor_id']), int(params['right_motor_id']))
    bus = node = link = None
    if not args.robot:
        # Keep the simulated graph on this machine: its /target_twist must never reach a robot.
        os.environ['ROS_DOMAIN_ID'] = str(args.domain_id)
        os.environ['ROS_AUTOMATIC_DISCOVERY_RANGE'] = 'LOCALHOST'
        os.environ.pop('ROS_LOCALHOST_ONLY', None)
        link = Path(tempfile.mkdtemp(prefix='questix_sim_')) / 'ttyDDT'
        bus = FakeDdtBus(motor_ids, plant=args.plant, noise_rpm=args.noise_rpm,
                         link_path=str(link), mode_frames=args.mode_frames,
                         wheel_radius=float(params['wheel_radius']),
                         wheel_separation=float(params['wheel_separation']),
                         report_dead_time=args.report_dead_time_ms / 1000.0,
                         report_tau=args.report_tau_ms / 1000.0)
        bus.start()
        print(f'[sim] fake M0602C bus: {bus.port} (ROS_DOMAIN_ID={args.domain_id}, localhost)',
              flush=True)

    if not args.robot and not args.no_spawn:
        found = subprocess.run(['ros2', 'pkg', 'prefix', 'motor_control_app'],
                               capture_output=True, text=True)
        if found.returncode != 0:
            if bus is not None:
                bus.stop()
            sys.exit('motor_control_app が見つかりません。ワークスペースをビルドして '
                     '`source install/setup.bash` してから実行してください')

    import rclpy
    from rclpy.signals import SignalHandlerOptions
    # Ctrl-C は Python の KeyboardInterrupt として受け、後片付け（ゼロ指令・ノード停止）を行う
    rclpy.init(signal_handler_options=SignalHandlerOptions.NO)
    hub = Hub()
    if bus is not None and not args.no_spawn:
        node = NodeProcess(hub, bus.port, args.control_mode, *motor_ids, args.params_file)
    monitor = Monitor(hub, bus, args.robot, float(params['wheel_radius']),
                      float(params['wheel_separation']), motor_ids)
    try:
        asyncio.run(serve(args, hub, monitor, bus, args.robot))
    except KeyboardInterrupt:
        pass
    finally:
        monitor.stop()
        if node is not None:
            node.stop()
        if bus is not None:
            bus.stop()
        if link is not None:
            try:
                os.rmdir(link.parent)
            except OSError:
                pass
        try:
            rclpy.shutdown()
        except Exception:  # noqa: BLE001 - already shut down
            pass
        monitor.close()


if __name__ == '__main__':
    main()
