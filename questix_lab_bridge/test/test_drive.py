import math
import types

from questix_lab_bridge import drive
from questix_lab_bridge.drive import DriveSession

ARBITER = '/drive_arbiter'


def status(**fields):
    """command_arbiter's drive status as the bridge feeds it (drive.arbiter_status)."""
    base = {'mechanism': 'drive', 'active_source': 'joy', 'switch_reason': '',
            'lab_permitted': True, 'lab_locked': False, 'lab_refusal': '', 'lab_count': 0,
            'max_linear': 0.15, 'max_angular': 0.5}
    base.update(fields)
    return base


def ready_session(**options):
    session = DriveSession(deadman_sec=0.5, max_run_sec=30.0, stop_hold_sec=0.3, **options)
    session.set_graph([], [ARBITER], 0.0)
    session.set_arbiter(status(), 0.0)
    session.set_estop_known(True, 0.0)  # /emergency_stop heard: released
    session.set_motion_permission(True, 0.0)
    return session


def codes(session):
    return [b['code'] for b in session.state()['blockers']]


def test_nothing_is_known_at_start():
    session = DriveSession()
    assert codes(session) == [drive.NO_DRIVE_NODE, drive.ESTOP_UNKNOWN]
    assert not session.allowed
    assert session.state()['limits']['linear'] is None


def test_the_arbiter_must_be_on_the_topic_and_reporting():
    session = ready_session()
    session.set_arbiter(None, 0.1)  # its status went stale
    assert session.request(1, 0.1, 0.0, 0.1) == drive.NO_DRIVE_NODE
    session.set_arbiter(status(), 0.2)
    session.set_graph([], [], 0.2)  # nothing subscribes to the drive topic
    assert session.request(1, 0.1, 0.0, 0.2) == drive.NO_DRIVE_NODE
    session.set_graph([], [ARBITER], 0.3)
    assert session.request(1, 0.1, 0.0, 0.3) is None


def test_not_permitted_by_the_arbiter_refuses_and_publishes_nothing():
    session = ready_session()
    session.set_arbiter(status(lab_permitted=False), 0.1)
    assert not session.allowed
    assert session.request(1, 0.1, 0.0, 0.1) == drive.NOT_ALLOWED
    assert session.tick(0.2) is None
    assert codes(session) == [drive.NOT_ALLOWED]


def test_the_teacher_switching_off_ends_the_run():
    session = ready_session()
    session.request(1, 0.1, 0.0, 0.0)
    session.set_arbiter(status(lab_permitted=False), 0.1)
    assert not session.active and session.last_stop['reason'] == drive.NOT_ALLOWED
    assert session.tick(0.15) == (0.0, 0.0)


def test_no_motion_permission_blocks_and_ends_the_run():
    session = ready_session()
    session.set_motion_permission(False, 0.0)
    assert session.request(1, 0.1, 0.0, 0.0) == drive.NO_MOTION_PERMISSION
    session.set_motion_permission(True, 0.1)
    assert session.request(1, 0.1, 0.0, 0.1) is None
    session.set_motion_permission(False, 0.2)
    assert not session.active and session.last_stop['reason'] == drive.NO_MOTION_PERMISSION


def test_other_publisher_blocks_and_names_the_node():
    session = ready_session()
    session.set_graph(['/joy_controller'], [ARBITER], 0.0)
    assert session.request(1, 0.1, 0.0, 0.0) == drive.OTHER_PUBLISHER
    assert session.state()['blockers'] == [
        {'code': drive.OTHER_PUBLISHER, 'nodes': ['/joy_controller']}]


def test_the_arbiter_caps_are_shown_and_the_command_is_repeated_as_asked():
    session = ready_session()
    assert session.state()['limits']['linear'] == 0.15
    assert session.state()['limits']['angular'] == 0.5
    # The arbiter clamps; the bridge passes the page's command on unchanged.
    assert session.request(1, 2.0, -5.0, 0.0) is None
    assert session.owner == 1
    assert session.tick(0.05) == (2.0, -5.0)
    assert session.tick(0.10) == (2.0, -5.0)


def test_non_finite_values_stop_the_owner():
    session = ready_session()
    session.request(1, 0.1, 0.0, 0.0)
    assert session.request(1, float('nan'), 0.0, 0.1) == drive.INVALID
    assert not session.active
    assert session.request(2, 'fast', 0.0, 0.1) == drive.INVALID
    assert session.request(2, True, 0.0, 0.1) == drive.INVALID


def test_one_owner_at_a_time_but_anyone_can_stop():
    session = ready_session()
    session.request(1, 0.1, 0.0, 0.0)
    assert session.request(2, 0.2, 0.0, 0.1) == drive.BUSY
    assert session.stop(2, 0.2)
    assert not session.active
    assert session.last_stop == {'reason': drive.STOPPED, 'by': 2}
    # Once stopped, another page may take over.
    assert session.request(2, 0.2, 0.0, 0.3) is None


def test_stop_only_own_ends_only_the_senders_run():
    session = ready_session()
    session.request(1, 0.1, 0.0, 0.0)
    # Page 2 was refused (busy) and ends "its" experiment: page 1 keeps driving.
    assert session.request(2, 0.1, 0.0, 0.1) == drive.BUSY
    assert not session.stop(2, 0.2, only_own=True)
    assert session.active and session.owner == 1
    assert session.tick(0.25) == (0.1, 0.0)
    # The owner itself may end it that way.
    assert session.stop(1, 0.3, only_own=True)
    assert session.last_stop == {'reason': drive.STOPPED, 'by': 1}
    # Nothing runs: nothing to stop, whatever the scope.
    assert not session.stop(1, 0.4, only_own=True)
    assert not session.stop(2, 0.4)


def test_silence_stops_the_robot_then_zero_is_held_briefly():
    session = ready_session()
    session.request(1, 0.2, 0.0, 0.0)
    assert session.tick(0.4) == (0.2, 0.0)
    assert session.tick(0.6) == (0.0, 0.0)  # deadman 0.5 s exceeded
    assert session.last_stop['reason'] == drive.TIMEOUT
    assert session.tick(0.8) == (0.0, 0.0)
    assert session.tick(1.0) is None  # idle: no competing publisher


def test_run_time_limit():
    session = ready_session()
    session.request(1, 0.1, 0.0, 0.0)
    now = 0.0
    while now < 30.0:
        now += 0.25
        session.request(1, 0.1, 0.0, now)
        session.tick(now)
    assert session.tick(30.3) == (0.0, 0.0)
    assert session.last_stop['reason'] == drive.TIME_LIMIT


def test_owner_disconnect_stops():
    session = ready_session()
    session.request(1, 0.1, 0.0, 0.0)
    session.disconnect(2, 0.1)
    assert session.active
    session.disconnect(1, 0.1)
    assert session.last_stop['reason'] == drive.DISCONNECTED


def test_blocker_during_a_run_stops_it():
    session = ready_session()
    session.request(1, 0.1, 0.0, 0.0)
    session.set_emergency_stop(True, 0.1)
    assert not session.active
    assert session.last_stop['reason'] == drive.EMERGENCY_STOP
    assert session.request(2, 0.1, 0.0, 0.2) == drive.EMERGENCY_STOP
    session.set_emergency_stop(False, 0.3)
    session.request(1, 0.1, 0.0, 1.2)
    session.set_graph(['/joy_controller'], [ARBITER], 1.3)
    assert session.last_stop['reason'] == drive.OTHER_PUBLISHER


def test_version_changes_only_on_news():
    session = ready_session()
    version = session.version
    session.set_graph([], [ARBITER], 0.1)
    session.set_arbiter(status(lab_count=0), 0.1)  # the same status again
    assert session.version == version
    session.request(1, 0.1, 0.0, 0.2)
    started = session.version
    assert started > version
    session.request(1, 0.1, 0.0, 0.3)  # heartbeat with the same command
    assert session.version == started
    session.set_arbiter(status(max_linear=0.1), 0.35)  # new caps: the pages hear about them
    assert session.version > started


# --- the arbiter's status ends a run it refused ----------------------------------------------

def test_a_controller_refusal_after_the_run_started_ends_it():
    session = ready_session()
    session.set_arbiter(status(lab_count=4), 0.0)
    session.request(1, 0.1, 0.0, 0.0)
    assert session.run_seconds(0.4) == 0.4
    # An earlier refusal (before this run's first command reached the arbiter) is not this run's.
    session.set_arbiter(status(lab_count=4, lab_refusal='controller'), 0.1)
    assert session.active
    session.set_arbiter(status(lab_count=5, active_source='joy', lab_refusal='controller',
                               lab_locked=True), 0.5)
    assert session.last_stop == {'reason': drive.CONTROLLER, 'by': None}
    assert session.run_seconds(0.6) == 0.0
    assert session.tick(0.6) == (0.0, 0.0)


def test_a_locked_lab_ends_the_run():
    session = ready_session()
    session.request(1, 0.1, 0.0, 0.0)
    session.set_arbiter(status(lab_count=1, lab_refusal='locked', lab_locked=True), 0.1)
    assert session.last_stop['reason'] == drive.CONTROLLER


def test_a_controller_takeover_after_the_lab_drove_ends_the_run():
    session = ready_session()
    session.request(1, 0.1, 0.0, 0.0)
    session.set_arbiter(status(lab_count=2, active_source='lab', switch_reason='lab'), 0.1)
    assert session.active
    session.set_arbiter(status(lab_count=3, active_source='joy',
                               switch_reason='controller'), 0.2)
    assert not session.active and session.last_stop['reason'] == drive.CONTROLLER


def test_the_lab_run_ending_at_the_arbiter_is_not_a_takeover():
    session = ready_session()
    session.request(1, 0.1, 0.0, 0.0)
    session.set_arbiter(status(lab_count=2, active_source='lab', switch_reason='lab'), 0.1)
    # The arbiter handed the robot back after this run's own neutral: the run goes on.
    session.set_arbiter(status(lab_count=3, active_source='joy', switch_reason='lab_ended'),
                        0.2)
    assert session.active


def test_other_refusals_do_not_end_the_run():
    session = ready_session()
    session.request(1, 0.1, 0.0, 0.0)
    session.set_arbiter(status(lab_count=1, lab_refusal='invalid'), 0.1)
    assert session.active


def test_arbiter_status_converts_the_message():
    nan = float('nan')
    msg = types.SimpleNamespace(
        mechanism='drive', active_source='lab', switch_reason='lab', lab_permitted=True,
        lab_locked=False, lab_refusal='', lab_count=7, max_linear=0.15, max_angular=0.5,
        max_power=nan, tilt_min_deg=nan, tilt_max_deg=nan, min_fire_power=nan, spin_up_sec=nan,
        fire_interval_sec=nan, next_fire_in_sec=nan, spin_ready_in_sec=math.inf)
    converted = drive.arbiter_status(msg)
    assert converted['lab_count'] == 7 and converted['active_source'] == 'lab'
    assert converted['max_linear'] == 0.15
    assert converted['max_power'] is None and converted['spin_ready_in_sec'] is None


# --- E-stop unknown until /emergency_stop is heard (S3) ------------------------------------------

def test_driving_is_refused_until_the_estop_topic_is_heard():
    session = DriveSession()
    session.set_graph([], [ARBITER], 0.0)
    session.set_arbiter(status(), 0.0)
    session.set_motion_permission(True, 0.0)
    assert session.request(1, 0.1, 0.0, 0.0) == drive.ESTOP_UNKNOWN
    assert session.tick(0.1) is None
    assert session.state()['blockers'] == [{'code': drive.ESTOP_UNKNOWN, 'nodes': None}]
    session.set_emergency_stop(False, 0.1)  # a derived "released" (/drive_status): no change
    assert session.request(1, 0.1, 0.0, 0.1) == drive.ESTOP_UNKNOWN
    session.set_estop_known(True, 0.2)
    assert session.request(1, 0.1, 0.0, 0.2) is None


def test_a_heard_pressed_estop_blocks_and_a_derived_one_blocks_before_it():
    session = DriveSession()
    session.set_graph([], [ARBITER], 0.0)
    session.set_arbiter(status(), 0.0)
    session.set_motion_permission(True, 0.0)
    session.set_emergency_stop(True, 0.0)  # derived pressed, before the topic
    assert codes(session) == [drive.ESTOP_UNKNOWN, drive.EMERGENCY_STOP]
    session.set_estop_known(True, 0.1)
    assert session.request(1, 0.1, 0.0, 0.1) == drive.EMERGENCY_STOP
    session.set_emergency_stop(False, 0.2)
    assert session.request(1, 0.1, 0.0, 0.2) is None
    session.set_emergency_stop(True, 0.3)  # pressed during the run: it ends at once
    assert not session.active and session.last_stop['reason'] == drive.EMERGENCY_STOP
    assert session.tick(0.35) == (0.0, 0.0)  # the usual stop hold


def test_not_allowed_is_not_also_no_drive_node():
    session = DriveSession()
    session.set_graph([], [ARBITER], 0.0)
    session.set_arbiter(status(lab_permitted=False), 0.0)
    session.set_estop_known(True, 0.0)
    session.set_motion_permission(True, 0.0)
    assert codes(session) == [drive.NOT_ALLOWED]


# --- a run the bridge ended is not restarted by commands still on their way ------------------

def test_the_owners_commands_after_a_run_the_bridge_ended_are_stale():
    session = ready_session()
    session.request(1, 0.1, 0.0, 0.0)
    session.set_emergency_stop(True, 0.1)
    session.set_emergency_stop(False, 0.15)  # released at once
    assert session.request(1, 0.1, 0.0, 0.2) == drive.STALE  # its heartbeat was on its way
    assert not session.active
    assert session.request(2, 0.1, 0.0, 0.3) is None  # another page may start
    session.stop(2, 0.4)
    assert session.request(1, 0.1, 0.0, 1.2) is None  # the page asks again later


def test_another_pages_stop_guards_the_owner_but_its_own_stop_does_not():
    session = ready_session()
    session.request(1, 0.1, 0.0, 0.0)
    session.stop(2, 0.1)  # the stop bar on another page
    assert session.request(1, 0.1, 0.0, 0.2) == drive.STALE
    session = ready_session()
    session.request(1, 0.1, 0.0, 0.0)
    session.stop(1, 0.1, only_own=True)  # the page ended its own run
    assert session.request(1, 0.1, 0.0, 0.2) is None
