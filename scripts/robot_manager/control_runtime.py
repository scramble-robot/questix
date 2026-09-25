"""Bounded, read-only snapshots of running QUESTiX ROS parameters."""

from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import subprocess
import threading

from fastapi import HTTPException

from robot_manager.controls import GROUPS

_lock = threading.Lock()
_PROCESS_TIMEOUT = 8


def _ros_paths(config):
    distro = config.get('ROS_DISTRO', os.environ.get('ROS_DISTRO', 'jazzy'))
    if not re.fullmatch(r'[a-z0-9_]+', distro):
        raise HTTPException(422, 'ROS_DISTRO が不正です。')
    workspace = config.get('ROBOT_WS', os.environ.get('ROBOT_WS', '/home/ubuntu/robot_ws'))
    ros_setup = Path('/opt/ros') / distro / 'setup.bash'
    workspace_setup = Path(workspace).expanduser() / 'install/setup.bash'
    if not ros_setup.is_file() or not workspace_setup.is_file():
        raise HTTPException(503, 'ROS 環境が見つかりません。ROBOT_WS と ROS_DISTRO を確認してください。')
    return ros_setup, workspace_setup


def read_snapshot(config):
    """Launch a short-lived GetParameters client without setting any ROS parameters."""
    domain = config.get('ROS_DOMAIN_ID', os.environ.get('ROS_DOMAIN_ID', '42'))
    if not domain.isdigit() or not 0 <= int(domain) <= 232:
        raise HTTPException(422, 'ROS_DOMAIN_ID は 0〜232 で指定してください。')
    ros_setup, workspace_setup = _ros_paths(config)
    if not _lock.acquire(blocking=False):
        raise HTTPException(409, '実行中の設定を取得しています。少し待ってから再試行してください。')
    try:
        requested = {node: [field[0] for field in fields] for node, (_, fields) in GROUPS.items()}
        # Paths are positional arguments, never shell source code. ROS setup output
        # is suppressed so stdout contains only the worker's JSON response.
        command = [
            '/bin/bash', '--noprofile', '--norc', '-c',
            'set -e; source "$1" >/dev/null; source "$2" >/dev/null; '
            'export ROS_DOMAIN_ID="$4"; exec /usr/bin/python3 "$3"',
            'questix-parameter-read', str(ros_setup), str(workspace_setup),
            str(Path(__file__).with_name('read_control_parameters.py')), domain,
        ]
        environment = os.environ.copy()
        environment['ROS_DOMAIN_ID'] = domain
        try:
            result = subprocess.run(command, input=json.dumps(requested), text=True,
                                    capture_output=True, timeout=_PROCESS_TIMEOUT, env=environment)
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(504, '実行中の設定取得がタイムアウトしました。') from exc
        except OSError as exc:
            raise HTTPException(503, 'ROS 設定取得プロセスを起動できません。') from exc
        if result.returncode != 0:
            raise HTTPException(503, 'ROS 設定を取得できません。ROS 環境とノードの起動状態を確認してください。')
        try:
            nodes = json.loads(result.stdout)
            if not isinstance(nodes, dict) or set(nodes) != set(requested):
                raise ValueError('unexpected node list')
            for node, report in nodes.items():
                if report['status'] not in ('ok', 'unavailable', 'timeout', 'error'):
                    raise ValueError('unexpected status')
                values = report['values']
                if not isinstance(values, dict) or set(values) - set(requested[node]):
                    raise ValueError('unexpected parameters')
                for value in values.values():
                    if type(value) not in (int, float, bool) or not math.isfinite(value):
                        raise ValueError('unexpected value')
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            raise HTTPException(502, 'ROS 設定の応答形式が不正です。') from exc
        return {'nodes': nodes, 'domain_id': int(domain),
                'captured_at': datetime.now(timezone.utc).isoformat()}
    finally:
        _lock.release()
