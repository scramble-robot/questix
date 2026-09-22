"""Validated, atomic persistence for QUESTiX operator control profiles."""

import fcntl
import hashlib
import math
import os
import tempfile
from pathlib import Path

import yaml
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict

# Defaults live exclusively in questix_control_config/config/controls.*.yaml.
# Limits here describe the editable operator interface, not hardware configuration.
GROUPS = {
    'joy_controller': ('走行の操作・速度', [
        ('linear_x_axis', '前後の軸番号', 'int', 0, 63),
        ('linear_y_axis', '左右の軸番号（全方向移動用）', 'int', -1, 63),
        ('angular_z_axis', '旋回の軸番号', 'int', 0, 63),
        ('longitudinal_input_ratio', '前後速度 [m/s]（負値で反転）', 'float', -10, 10),
        ('lateral_input_ratio', '左右速度 [m/s]（全方向移動用）', 'float', -10, 10),
        ('angular_input_ratio', '旋回速度 [rad/s]（負値で反転）', 'float', -20, 20),
    ]),
    'drive_component': ('走行モータ・加速度', [
        ('max_motor_rpm', '車輪の最大回転数 [RPM]', 'int', 1, 475),
        ('max_linear_accel', '前後の加速度 [m/s²]（0で制限なし）', 'float', 0, 50),
        ('max_angular_accel', '旋回の加速度 [rad/s²]（0で制限なし）', 'float', 0, 100),
        ('slew_taper_band_linear', '目標速度付近の緩和幅 [m/s]（0で無効）', 'float', 0, 10),
        ('slew_taper_band_angular', '目標旋回速度付近の緩和幅 [rad/s]（0で無効）', 'float', 0, 20),
        ('min_command_rpm', '低速不感帯 [RPM]（0で無効）', 'int', 0, 474),
    ]),
    'shot_component': ('射出・チルトのキー割り当て', [
        ('fire_button', '射出ボタン番号', 'int', 0, 63),
        ('tilt_up_axis', '上げる入力軸（-1でボタン）', 'int', -1, 63),
        ('tilt_up_axis_sign', '上げる軸の方向（+1 / -1）', 'int', -1, 1),
        ('tilt_down_axis', '下げる入力軸（-1でボタン）', 'int', -1, 63),
        ('tilt_down_axis_sign', '下げる軸の方向（+1 / -1）', 'int', -1, 1),
        ('tilt_up_button_index', 'チルト上ボタン番号（ボタン操作時のみ）', 'int', 0, 63),
        ('tilt_down_button_index', 'チルト下ボタン番号（ボタン操作時のみ）', 'int', 0, 63),
    ]),
    'esc_motor_control': ('ローラー', [
        ('full_speed_button', '回転ボタン番号', 'int', 0, 63),
        ('full_speed_value', '回転出力（0〜1）', 'float', 0, 1),
    ]),
    'joy_node': ('DualShock 入力', [('deadzone', 'スティック不感帯', 'float', 0, 0.99)]),
    'uart_joy_driver': ('UART 入力', [('deadzone', 'スティック不感帯', 'float', 0, 0.99)]),
    'joy_controller_dual_stick': ('左右独立スティック（単体起動時のみ）', [
        ('left_stick_vertical_axis', '左車輪の軸番号', 'int', 0, 63),
        ('right_stick_vertical_axis', '右車輪の軸番号', 'int', 0, 63),
        ('longitudinal_input_ratio', '車輪速度スケール', 'float', -10, 10),
        ('angular_input_ratio', '旋回スケール', 'float', -20, 20),
    ]),
    'joy_axis_drive': ('Joy 直接駆動（単体起動時のみ）', [
        ('left_axis_index', '左車輪の軸番号', 'int', 0, 63),
        ('right_axis_index', '右車輪の軸番号', 'int', 0, 63),
        ('invert_left_axis', '左軸を反転', 'bool', None, None),
        ('invert_right_axis', '右軸を反転', 'bool', None, None),
        ('max_motor_rpm', '最大回転数 [RPM]', 'int', 1, 475),
    ]),
}


class ControlUpdate(BaseModel):
    """Require the revision read by the editor to prevent lost updates."""

    model_config = ConfigDict(extra='forbid')
    revision: str
    values: dict[str, dict[str, object]]


def schema():
    """Describe the form without duplicating profile defaults in JavaScript."""
    return [
        {'node': node, 'label': label, 'fields': [
            dict(zip(('key', 'label', 'type', 'min', 'max'), field)) for field in fields
        ]} for node, (label, fields) in GROUPS.items()
    ]


def validate(values):
    """Reject unknown fields, wrong types, nonfinite numbers and unusable bounds."""
    if not isinstance(values, dict) or set(values) != set(GROUPS):
        raise ValueError('設定のノード一覧が一致しません。再読み込みしてください。')
    clean = {}
    for node, (_, fields) in GROUPS.items():
        params = values[node]
        if not isinstance(params, dict) or set(params) != {f[0] for f in fields}:
            raise ValueError(f'{node}: 設定項目が一致しません。再読み込みしてください。')
        clean[node] = {}
        for key, label, kind, low, high in fields:
            value = params[key]
            if kind == 'bool':
                valid = type(value) is bool
            elif kind == 'int':
                valid = type(value) is int and low <= value <= high
            else:
                valid = (type(value) in (int, float) and low <= value <= high
                         and math.isfinite(value))
            if not valid:
                raise ValueError(f'{label}: {kind} 型、範囲 {low}〜{high} で入力してください。')
            clean[node][key] = float(value) if kind == 'float' else value
    drive = clean['drive_component']
    if drive['min_command_rpm'] >= drive['max_motor_rpm']:
        raise ValueError('低速不感帯は車輪の最大回転数より小さくしてください。')
    shot = clean['shot_component']
    inputs = []
    for direction in ('up', 'down'):
        axis = shot[f'tilt_{direction}_axis']
        sign = shot[f'tilt_{direction}_axis_sign']
        if sign not in (-1, 1):
            raise ValueError('チルト軸の方向は +1 または -1 を選んでください。')
        inputs.append(('axis', axis, sign) if axis >= 0 else
                      ('button', shot[f'tilt_{direction}_button_index']))
    if inputs[0] == inputs[1]:
        raise ValueError('チルト上・下には異なる入力を割り当ててください。')
    return clean


def _default_file(controller, env):
    filename = f'controls.{controller}.yaml'
    workspace = env.get('ROBOT_WS') or os.environ.get('ROBOT_WS')
    if workspace:
        install = Path(workspace).expanduser() / 'install'
        candidates = [install / 'questix_control_config/share/questix_control_config/config' / filename,
                      install / 'share/questix_control_config/config' / filename]
    else:
        # Source checkout only, for python -m robot_manager development.
        candidates = [Path(__file__).resolve().parents[2]
                      / 'questix_control_config/config' / filename]
    for path in candidates:
        if path.is_file():
            return path
    raise HTTPException(503, '共通設定が見つかりません。ROBOT_WS と '
                        'questix_control_config のビルド・インストールを確認してください。')


def _decode(raw):
    document = yaml.safe_load(raw)
    if not isinstance(document, dict):
        raise ValueError('設定ファイルは ROS パラメータ YAML である必要があります。')
    values = {}
    for node, section in document.items():
        if not isinstance(section, dict) or set(section) != {'ros__parameters'}:
            raise ValueError(f'{node}: ros__parameters セクションが不正です。')
        values[node] = section['ros__parameters']
    # Upgrade only the complete legacy shape; partial/unknown fields remain errors.
    shot = values.get('shot_component')
    if isinstance(shot, dict) and set(shot) == {
            'fire_button', 'tilt_axis', 'tilt_up_button_index', 'tilt_down_button_index'}:
        axis = shot.pop('tilt_axis')
        if type(axis) is not int or not -1 <= axis <= 63:
            raise ValueError('旧チルト軸番号が不正です。')
        for direction, sign in (('up', 1), ('down', -1)):
            shot[f'tilt_{direction}_axis'] = axis
            shot[f'tilt_{direction}_axis_sign'] = sign
    return validate(values)


def read_profile(config_dir, controller, env):
    """Read persisted values, exposing defaults and an optimistic concurrency token."""
    default_file = _default_file(controller, env)
    saved_file = config_dir / f'controls.{controller}.yaml'
    try:
        default_raw = default_file.read_bytes()
        saved_raw = saved_file.read_bytes() if saved_file.exists() else None
        defaults = _decode(default_raw)
        values = _decode(saved_raw) if saved_raw is not None else defaults
    except (OSError, ValueError, yaml.YAMLError) as exc:
        raise HTTPException(503, f'操作設定を読み込めません: {exc}') from exc
    revision = hashlib.sha256(
        str(default_file.resolve()).encode() + b'\0' + default_raw + b'\0'
        + (saved_raw if saved_raw is not None else b'<defaults>')).hexdigest()
    return {'controller': controller, 'revision': revision, 'values': values,
            'defaults': defaults, 'groups': schema(), 'apply_on_restart': True,
            'source': str(saved_file if saved_raw is not None else default_file)}


def write_profile(config_dir, controller, env, update):
    """Validate and atomically replace a profile without modifying a running robot."""
    try:
        values = validate(update.values)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    temp_path = None
    try:
        config_dir.mkdir(parents=True, exist_ok=True)
        with (config_dir / '.controls.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            current = read_profile(config_dir, controller, env)
            if update.revision != current['revision']:
                raise HTTPException(409, '他の画面またはファイルで設定が変更されました。'
                                    '再読み込みして変更を確認してください。')
            document = {node: {'ros__parameters': params} for node, params in values.items()}
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=config_dir,
                                             prefix='.controls-', delete=False) as stream:
                temp_path = Path(stream.name)
                stream.write('# QUESTiX controls — applied on next robot start/restart.\n')
                yaml.safe_dump(document, stream, allow_unicode=True, sort_keys=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_path, config_dir / f'controls.{controller}.yaml')
            return read_profile(config_dir, controller, env)
    except PermissionError as exc:
        raise HTTPException(403, '操作設定ディレクトリに書き込み権限がありません。') from exc
    except OSError as exc:
        raise HTTPException(500, f'操作設定を保存できません: {exc}') from exc
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
