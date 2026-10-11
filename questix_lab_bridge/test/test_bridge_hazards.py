"""LabBridgeNode's own paths for a coalesced tilt and the E-stop authority (S3).

The node's methods run for real on a stand-in object (no ROS graph, no WebSocket) with a clock
the test moves; they need rclpy and questix_msgs, so this file runs where the node can be built
(colcon test) and is skipped elsewhere. The rules themselves are unit-tested ROS-free in
test_shoot.py (TiltCoalescer, ShootSession) and test_drive.py (DriveSession).
"""

import threading
import types

import pytest

bridge_node = pytest.importorskip(
    'questix_lab_bridge.bridge_node', reason='needs ROS 2 (rclpy, questix_msgs)')

from questix_lab_bridge import drive, shoot  # noqa: E402

ROLLER_OK = {'command': 0.0, 'source': 'idle', 'estop': False, 'permission': True,
             'max_power': 1.0}
SHOT_OK = {'tilt_deg': 30.0, 'shooting': False, 'fired_count': 0, 'last_fire_source': None,
           'estop': False, 'permission': True, 'active': True, 'tilt_min_deg': 0.0,
           'tilt_max_deg': 120.0, 'next_fire_in_sec': 0.0}
_METHODS = ('_after_shoot_change', '_send_tilt', '_drop_pending_tilt', '_on_shoot_request',
            '_on_shoot_tick', '_on_leave', '_stop_all', '_set_estop', '_on_drive', '_on_estop',
            '_state', '_send_drive_state', '_send_shoot_state', '_greeting', '_on_arbiter',
            '_on_motion_permission', '_motion_allows', '_after_drive_change', '_on_drive_tick',
            '_publish_launcher_stop')


class _Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class _Logger:
    def info(self, *_args, **_kwargs):
        pass

    warning = error = info


@pytest.fixture
def node(monkeypatch):
    clock = _Clock()
    monkeypatch.setattr(bridge_node.time, 'monotonic', clock)
    stub = types.SimpleNamespace()
    stub.clock = clock
    stub.published = []
    stub._drive_lock = threading.Lock()
    stub._closing = False
    stub._drive = drive.DriveSession()
    stub._drive.set_graph([], ['/drive_arbiter'], clock.now)
    stub._drive.set_arbiter(_arbiter_status(), clock.now)
    stub._drive.set_motion_permission(True, clock.now)
    stub._arbiter_at = clock.now
    # Fresh permissions (the tests that move the clock far renew them with _renew_permissions).
    stub._motion = {'drive': True, 'launcher': True}
    stub._motion_at = clock.now
    stub._shoot = shoot.ShootSession()
    stub._shoot.set_graph([], ['/launcher_arbiter'], clock.now)
    stub._shoot.set_roller_status(dict(ROLLER_OK), clock.now)
    stub._shoot.set_shot_status(dict(SHOT_OK), clock.now)
    stub._shoot.set_arbiter(_arbiter_status(mechanism='launcher'), clock.now)
    stub._shoot.set_motion_permission(True, clock.now)
    stub._shoot_enabled = True
    stub._drive_topic = '/target_twist/lab'
    stub._tilt = shoot.TiltCoalescer(bridge_node._TILT_GAP_SEC)
    stub._estop = {'topic': False, 'drive': False}
    stub._estop_known = False
    stub._latest_estop = None
    stub._latest_estop_at = float('-inf')
    stub._now = lambda: clock.now
    stub._drive_sent_version = stub._shoot_sent_version = -1
    stub._drive_sent_at = stub._shoot_sent_at = 0.0
    stub._server = types.SimpleNamespace(publish=lambda *a: None, publish_to=lambda *a: None)
    stub._records = types.SimpleNamespace(summary=lambda: {})
    stub._recorder = None
    stub._robot = {}
    stub._rates = {}
    stub.get_logger = _Logger
    stub._relay = lambda *a: None
    stub._drive_state_text = lambda: '{}'
    stub._shoot_state_text = lambda now: '{}'
    stub._publish_launcher = lambda command: stub.published.append(('launcher', command))
    stub._publish_twist = lambda linear, angular: stub.published.append(
        ('twist', (linear, angular)))
    for name in _METHODS:
        setattr(stub, name, types.MethodType(getattr(bridge_node.LabBridgeNode, name), stub))
    return stub


def _arbiter_status(**fields):
    """A status of command_arbiter as drive.arbiter_status returns it (drive by default)."""
    launcher = fields.get('mechanism') == 'launcher'
    base = {'mechanism': 'drive', 'active_source': 'joy', 'switch_reason': 'start',
            'lab_permitted': True, 'lab_locked': False, 'lab_refusal': '', 'lab_count': 0,
            'max_linear': None if launcher else 0.15, 'max_angular': None if launcher else 0.5,
            'max_power': 0.8 if launcher else None, 'tilt_min_deg': 0.0 if launcher else None,
            'tilt_max_deg': 120.0 if launcher else None,
            'min_fire_power': 0.2 if launcher else None,
            'spin_up_sec': 1.0 if launcher else None,
            'fire_interval_sec': 2.0 if launcher else None,
            'next_fire_in_sec': 0.0 if launcher else None, 'spin_ready_in_sec': None}
    base.update(fields)
    return base


def _arbiter_message(**fields):
    nan = float('nan')
    status = _arbiter_status(**fields)
    return types.SimpleNamespace(**{key: nan if value is None else value
                                    for key, value in status.items()})


def _permission(drive_allowed, launcher_allowed):
    return types.SimpleNamespace(drive_allowed=drive_allowed, launcher_allowed=launcher_allowed)


def _renew_permissions(node):
    node._on_motion_permission(_permission(True, True))
    node._on_arbiter(_arbiter_message())
    node._on_arbiter(_arbiter_message(mechanism='launcher'))


def _estop_message(active):
    stamp = types.SimpleNamespace(sec=1000, nanosec=0)
    return types.SimpleNamespace(active=active, header=types.SimpleNamespace(stamp=stamp),
                                 source='operation_manager',
                                 reason='pressed' if active else 'released')


def _drive_status(pressed):
    return types.SimpleNamespace(emergency_stop=pressed)


def _tilts(node):
    """The tilt targets the commands carried, each once (they repeat it until it changes)."""
    targets = []
    for name, command in node.published:
        if name == 'launcher' and command[1] is not None and (
                not targets or targets[-1] != command[1]):
            targets.append(command[1])
    return targets


def _rollers(node):
    return [command[0] for name, command in node.published if name == 'launcher']


def _keep_a_tilt(node):
    """Heard /emergency_stop, a session of page 1, one tilt sent and a second one kept."""
    node._on_estop(_estop_message(False))
    node._on_shoot_request(1, ('roller', 0.0))
    node._on_shoot_request(1, ('tilt', 30.0))
    node.clock.now += 0.01
    node._on_shoot_request(1, ('tilt', 40.0))
    assert _tilts(node) == [30.0] and node._tilt.pending is not None


def _after_the_gap(node):
    node.clock.now += 0.2
    node._on_shoot_tick()
    return _tilts(node)


def test_the_kept_tilt_is_sent_once_while_the_session_runs(node):
    _keep_a_tilt(node)
    node._on_shoot_request(1, ('roller', 0.0))  # heartbeat: the session goes on
    node.clock.now += 0.1
    node._on_shoot_tick()
    node.clock.now += 0.1
    node._on_shoot_tick()
    assert _tilts(node) == [30.0, 40.0]


@pytest.mark.parametrize('end', [
    lambda node: node._on_leave(1),  # the page left
    lambda node: node._on_shoot_request(1, ('roller_stop',)),  # its own stop
    lambda node: node._on_shoot_request(2, ('roller_stop',)),  # another page's stop bar
    lambda node: node._stop_all(),  # Robot Manager 「すべて止める」 / destroy_node
    lambda node: node._on_shoot_request(1, ('roller', float('nan'))),  # invalid: ends it
    lambda node: node._on_estop(_estop_message(True)),  # E-stop pressed
    lambda node: node._on_drive(_drive_status(True)),  # a derived E-stop, pressed
], ids=['disconnect', 'own-stop', 'other-stop', 'stop-all', 'invalid', 'estop', 'drive-estop'])
def test_a_kept_tilt_is_never_sent_after_its_session_ended(node, end):
    _keep_a_tilt(node)
    end(node)
    assert not node._shoot.active
    assert node._tilt.pending is None  # dropped on the way out
    assert _after_the_gap(node) == [30.0]


def test_a_kept_tilt_dies_with_the_deadman(node):
    _keep_a_tilt(node)
    # No roller heartbeat for longer than deadman_sec (0.5 s), statuses still fresh (1.0 s).
    node.clock.now += 0.4
    _renew_permissions(node)
    node.clock.now += 0.3
    node._on_shoot_tick()
    assert not node._shoot.active and node._shoot.last_stop['reason'] == shoot.TIMEOUT
    assert _after_the_gap(node) == [30.0]


def test_a_new_session_does_not_inherit_the_kept_tilt(node):
    _keep_a_tilt(node)
    node._on_shoot_request(1, ('roller_stop',))
    node._on_shoot_request(1, ('roller', 0.0))  # the same page, a new session, within the gap
    assert node._shoot.active
    assert _after_the_gap(node) == [30.0]


def test_nothing_moves_and_the_state_is_unknown_until_the_estop_topic(node):
    node._on_drive(_drive_status(False))  # /drive_status says released: derived, not enough
    node._on_shoot_request(1, ('roller', 0.5))
    assert not node._shoot.active
    assert drive.ESTOP_UNKNOWN in [code for code, _ in node._drive.blockers()]
    assert node._state([], 24)['emergency_stop'] is None
    node._on_estop(_estop_message(False))
    assert node._state([], 24)['emergency_stop'] is False
    assert node._drive.blockers() == []
    node._on_shoot_request(1, ('roller', 0.5))
    assert node._shoot.active


def test_a_heard_pressed_estop_ends_driving_and_the_launcher(node):
    node._on_estop(_estop_message(False))
    assert node._drive.request(1, 0.1, 0.0, node.clock.now) is None
    node._on_shoot_request(2, ('roller', 0.5))
    node._on_estop(_estop_message(True))
    assert not node._drive.active and not node._shoot.active
    assert ('twist', (0.0, 0.0)) in node.published
    assert ('launcher', (0.0, None, 0)) in node.published  # the lab's stop
    assert node._state([], 24)['emergency_stop'] is True


def test_the_estop_topic_is_relayed_as_its_own_stream(node):
    relayed = []
    node._relay = lambda name, build: relayed.append((name, build()))
    node._on_estop(_estop_message(True))
    ((name, payload),) = relayed
    assert name == 'estop'
    assert payload['active'] is True and payload['source'] == 'operation_manager'
    assert payload['stamp'] == 1000.0 and payload['bridge_stamp'] == node.clock.now


def test_a_new_page_gets_the_last_estop_only_while_it_is_fresh(node):
    assert not any('"estop"' in text for text in node._greeting(1))
    node._on_estop(_estop_message(False))
    assert any('"type":"estop"' in text for text in node._greeting(2))
    node.clock.now += 1.5  # operation_manager went silent
    assert not any('"estop"' in text for text in node._greeting(3))


# --- the permissions and the arbiter's status (design 4.5) ----------------------------------

def _drive_a_run(node):
    node._on_estop(_estop_message(False))
    assert node._drive.request(1, 0.1, 0.0, node.clock.now) is None
    node.published.clear()


def test_the_arbiter_giving_the_robot_to_the_controller_stops_the_run_at_once(node):
    _drive_a_run(node)
    node._on_arbiter(_arbiter_message(lab_count=1, lab_refusal='controller', lab_locked=True))
    assert not node._drive.active
    assert node._drive.last_stop['reason'] == drive.CONTROLLER
    assert node.published == [('twist', (0.0, 0.0))]


def test_the_launcher_status_of_the_arbiter_is_not_the_drives(node):
    _drive_a_run(node)
    node._on_arbiter(_arbiter_message(mechanism='launcher', lab_count=1, lab_permitted=False,
                                      lab_refusal='controller'))
    assert node._drive.active


def test_a_silent_arbiter_ends_the_run(node):
    _drive_a_run(node)
    node.clock.now += 0.4
    node._drive.request(1, 0.1, 0.0, node.clock.now)  # the page's heartbeat
    node._on_motion_permission(_permission(True, True))
    node._on_drive_tick()
    assert node._drive.active
    node.clock.now += 0.3
    node._drive.request(1, 0.1, 0.0, node.clock.now)
    node._on_motion_permission(_permission(True, True))
    node.clock.now += 0.3
    node._drive.request(1, 0.1, 0.0, node.clock.now)
    node._on_motion_permission(_permission(True, True))
    node.clock.now += 0.6  # 1.6 s since the arbiter's last status
    node._drive.request(1, 0.1, 0.0, node.clock.now)
    node._on_motion_permission(_permission(True, True))
    node._on_drive_tick()
    assert not node._drive.active
    assert node._drive.last_stop['reason'] == drive.NO_DRIVE_NODE
    assert ('twist', (0.0, 0.0)) in node.published


def test_the_motion_permission_withdrawn_ends_the_run(node):
    _drive_a_run(node)
    node._on_motion_permission(_permission(False, True))  # the referee or the teacher: no drive
    node._on_drive_tick()
    assert not node._drive.active
    assert node._drive.last_stop['reason'] == drive.NO_MOTION_PERMISSION
    assert ('twist', (0.0, 0.0)) in node.published


def test_a_silent_motion_permission_ends_the_run(node):
    _drive_a_run(node)
    node.clock.now += 0.3
    node._drive.request(1, 0.1, 0.0, node.clock.now)
    node._on_arbiter(_arbiter_message())
    node.clock.now += 0.3  # 0.6 s since /motion_permission: older than its 0.5 s lease
    node._drive.request(1, 0.1, 0.0, node.clock.now)
    node._on_drive_tick()
    assert node._drive.last_stop['reason'] == drive.NO_MOTION_PERMISSION


@pytest.mark.parametrize('withdraw', [
    # The teacher switched the lesson permission off: the arbiter reports it.
    lambda node: node._on_arbiter(_arbiter_message(mechanism='launcher', lab_permitted=False)),
    lambda node: node._on_motion_permission(_permission(True, False)),  # no motion permission
], ids=['lab-permission', 'motion-permission'])
def test_a_withdrawn_permission_ends_the_launcher_session(node, withdraw):
    node._on_estop(_estop_message(False))
    node._on_shoot_request(1, ('roller', 0.5))
    assert node._shoot.active
    withdraw(node)
    node._on_shoot_tick()
    assert not node._shoot.active
    assert node._shoot.last_stop['reason'] in (shoot.NOT_ALLOWED, shoot.NO_MOTION_PERMISSION)
    assert node.published[-1] == ('launcher', (0.0, None, 0))
    node._on_shoot_request(1, ('roller', 0.5))
    assert not node._shoot.active  # refused while it stays off


def test_a_silent_launcher_arbiter_ends_the_launcher_session(node):
    node._on_estop(_estop_message(False))
    for _ in range(4):
        node._on_shoot_request(1, ('roller', 0.5))
        node._on_motion_permission(_permission(True, True))
        node._shoot.set_roller_status(dict(ROLLER_OK), node.clock.now)
        node._shoot.set_shot_status(dict(SHOT_OK), node.clock.now)
        node._on_shoot_tick()
        node.clock.now += 0.4
    # 1.6 s since the launcher arbiter's last status: it is gone
    node._on_shoot_request(1, ('roller', 0.5))
    node._on_motion_permission(_permission(True, True))
    node._on_shoot_tick()
    assert not node._shoot.active
    assert node._shoot.last_stop['reason'] == shoot.NO_LAUNCHER


def test_the_launcher_arbiter_locking_the_lab_out_ends_the_session(node):
    node._on_estop(_estop_message(False))
    node._on_shoot_request(1, ('roller', 0.5))
    node.published.clear()
    node._on_arbiter(_arbiter_message(mechanism='launcher', lab_count=1, lab_locked=True))
    assert not node._shoot.active
    assert node._shoot.last_stop['reason'] == shoot.CONTROLLER
    assert node.published == [('launcher', (0.0, None, 0))]


def test_a_shot_goes_out_with_the_command(node):
    node._on_estop(_estop_message(False))
    for _ in range(12):  # 1.2 s at 0.5: the spin-up is over
        node._on_shoot_request(1, ('roller', 0.5))
        node._on_motion_permission(_permission(True, True))
        node._shoot.set_roller_status(dict(ROLLER_OK), node.clock.now)
        node._shoot.set_shot_status(dict(SHOT_OK), node.clock.now)
        node._on_arbiter(_arbiter_message(mechanism='launcher'))
        node.clock.now += 0.1
    node._on_shoot_request(1, ('fire', True))
    assert node.published[-1] == ('launcher', (0.5, None, 1))
