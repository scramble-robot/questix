"""Why the robot does not move: a one-shot read of /emergency_stop and /motion_permission.

The 操作 tab's 「なぜ動かないか確認」 asks ``GET /api/motion-state``: a short-lived ROS process
(read_motion_state.py, sourced like control_runtime.py: ROS, the robot workspace, the robot's
ROS_DOMAIN_ID) subscribes to both topics, waits at most a few seconds and exits. It publishes
nothing and changes nothing. The emergency stop (L1) is the physical E-stop; the motion permission
(L2) lists what blocks driving and the launcher (e.g. ``teacher:off``, ``referee:off``). Either may
be missing (``null``): the robot's ROS is not running, or runs an older version.
"""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import threading

from fastapi import HTTPException

from robot_manager import control_runtime, ros_domain

_lock = threading.Lock()
_PROCESS_TIMEOUT = 8
_STRING_LIMIT = 200


def _validate(state):
    """Return ``state`` when it has the worker's shape; raise ValueError otherwise."""
    if not isinstance(state, dict) or set(state) != {"emergency_stop", "motion_permission"}:
        raise ValueError("unexpected keys")
    estop = state["emergency_stop"]
    if estop is not None:
        if (set(estop) != {"active", "source", "reason"} or type(estop["active"]) is not bool
                or not all(isinstance(estop[k], str) and len(estop[k]) <= _STRING_LIMIT
                           for k in ("source", "reason"))):
            raise ValueError("unexpected emergency_stop")
    permission = state["motion_permission"]
    if permission is not None:
        if set(permission) != {"mode", "drive_allowed", "launcher_allowed", "drive_blockers",
                               "launcher_blockers"}:
            raise ValueError("unexpected motion_permission")
        if (not isinstance(permission["mode"], str) or len(permission["mode"]) > _STRING_LIMIT
                or type(permission["drive_allowed"]) is not bool
                or type(permission["launcher_allowed"]) is not bool):
            raise ValueError("unexpected motion_permission")
        for key in ("drive_blockers", "launcher_blockers"):
            items = permission[key]
            if (not isinstance(items, list) or len(items) > 32
                    or not all(isinstance(item, str) and len(item) <= _STRING_LIMIT
                               for item in items)):
                raise ValueError("unexpected blockers")
    return state


def read_state(config):
    """Read /emergency_stop and /motion_permission once (``config``: launch.env)."""
    domain = config.get('ROS_DOMAIN_ID', os.environ.get('ROS_DOMAIN_ID', '42'))
    parsed = ros_domain.parse(domain)
    if parsed is None:
        raise HTTPException(
            422, f'ROS_DOMAIN_ID が {domain!r} です。{ros_domain.ALLOWED_TEXT} で指定してください'
            '（管理設定で直せます）。')
    domain = str(parsed)
    ros_setup, workspace_setup = control_runtime._ros_paths(config)
    if not _lock.acquire(blocking=False):
        raise HTTPException(409, 'ロボットの状態を確認しています。少し待ってから再試行してください。')
    try:
        # Paths are positional arguments, never shell source code.
        command = [
            '/bin/bash', '--noprofile', '--norc', '-c',
            'set -e; source "$1" >/dev/null; source "$2" >/dev/null; '
            'export ROS_DOMAIN_ID="$4"; exec /usr/bin/python3 "$3"',
            'questix-motion-state', str(ros_setup), str(workspace_setup),
            str(Path(__file__).with_name('read_motion_state.py')), domain,
        ]
        environment = os.environ.copy()
        environment['ROS_DOMAIN_ID'] = domain
        try:
            result = subprocess.run(command, text=True, capture_output=True,
                                    timeout=_PROCESS_TIMEOUT, env=environment)
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(504, 'ロボットの状態の確認がタイムアウトしました。') from exc
        except OSError as exc:
            raise HTTPException(503, 'ROS の状態確認プロセスを起動できません。') from exc
        if result.returncode != 0:
            raise HTTPException(503, 'ロボットの状態を確認できません。ROS 環境を確認してください。')
        try:
            state = _validate(json.loads(result.stdout))
        except (TypeError, ValueError) as exc:
            raise HTTPException(502, 'ロボットの状態の応答形式が不正です。') from exc
        return dict(state, domain_id=int(domain),
                    captured_at=datetime.now(timezone.utc).isoformat())
    finally:
        _lock.release()
