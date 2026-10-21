import math
import struct

from questix_lab_bridge import shoot
from questix_lab_bridge.shoot import ShootSession

ROLLER_OK = {'command': 0.0, 'source': 'idle', 'estop': False, 'permission': True,
             'max_power': 1.0}
SHOT_OK = {'tilt_deg': 30.0, 'shooting': False, 'fired_count': 0, 'last_fire_source': None,
           'estop': False, 'permission': True, 'active': True, 'tilt_min_deg': 0.0,
           'tilt_max_deg': 120.0, 'next_fire_in_sec': 0.0}
ARBITER = '/launcher_arbiter'


def status(**fields):
    """command_arbiter's launcher status as the bridge feeds it (drive.arbiter_status)."""
    base = {'mechanism': 'launcher', 'active_source': 'joy', 'switch_reason': 'start',
            'lab_permitted': True, 'lab_locked': False, 'lab_refusal': '', 'lab_count': 0,
            'max_linear': None, 'max_angular': None, 'max_power': 0.8, 'tilt_min_deg': 0.0,
            'tilt_max_deg': 120.0, 'min_fire_power': 0.2, 'spin_up_sec': 1.0,
            'fire_interval_sec': 2.0, 'next_fire_in_sec': 0.0, 'spin_ready_in_sec': None}
    base.update(fields)
    return base


def feed(session, now, roller=None, shot=None, arbiter=None):
    """Both statuses as the launcher nodes send them (5 Hz) and the arbiter's, with overrides."""
    session.set_roller_status(dict(ROLLER_OK, **(roller or {})), now)
    session.set_shot_status(dict(SHOT_OK, **(shot or {})), now)
    session.set_arbiter(status(**(arbiter or {})), now)


def ready_session(**options):
    session = ShootSession(**options)
    session.set_graph([], [ARBITER], 0.0)
    feed(session, 0.0)
    session.set_estop_known(True, 0.0)  # /emergency_stop heard: released
    session.set_motion_permission(True, 0.0)
    return session


def spin_up(session, client=1, power=0.5, start=0.0, until=1.2, shot=None):
    """Heartbeat the roller every 0.1 s (the statuses show it turning) and return the time reached."""
    now = start
    while now <= until + 1e-9:
        assert session.roller(client, power, now) is None
        feed(session, now, shot=shot, roller={'command': power, 'source': 'lab'})
        session.tick(now)
        now = round(now + 0.1, 3)
    return round(now - 0.1, 3)


def codes(session):
    return [code for code, _ in session.blockers()]


def f32(value):
    """Round-trip a message field without ROS."""
    return struct.unpack('!f', struct.pack('!f', value))[0]


def wire_spin(session, requested, minimum, maximum=0.8, reported=None):
    """Keep every status fresh while exercising the command and confirmation comparisons."""
    for step in range(16):
        now = step / 10
        session.set_arbiter(status(min_fire_power=f32(minimum), max_power=f32(maximum)), now)
        assert session.roller(1, requested, now) is None
        feed(session, now,
             arbiter={'min_fire_power': f32(minimum), 'max_power': f32(maximum)},
             roller={'command': f32(requested) if reported is None else reported,
                     'source': 'lab'})
        session.tick(now)


def test_float32_nominal_thresholds_start_and_confirm_the_roller():
    for percent in (20, 21, 70, 80):
        for reported in (percent / 100, f32(percent / 100)):
            session = ready_session()
            wire_spin(session, percent / 100, percent / 100, reported=reported)
            assert session.spin_ready_in(1.5) == 0.0
            assert session.fire(1, True, 1.5) is None


def test_float32_limits_sent_to_pages_restore_only_whole_percent():
    session = ready_session()
    session.set_arbiter(status(min_fire_power=f32(0.2), max_power=f32(0.8)), 0.0)
    assert session.limits()['min_fire_power'] == 0.2
    assert session.limits()['max_power'] == 0.8
    session.set_arbiter(status(min_fire_power=f32(0.20001), max_power=f32(0.69999)), 0.0)
    assert session.limits()['min_fire_power'] == f32(0.20001)
    assert session.limits()['max_power'] == f32(0.69999)


def test_float32_caps_still_clamp_and_below_threshold_still_refuses():
    session = ready_session()
    wire_spin(session, 0.19, 0.2)
    assert session.fire(1, True, 1.5) == shoot.NOT_SPINNING
    session = ready_session()
    wire_spin(session, 0.8, 0.2, maximum=0.7, reported=f32(0.7))
    assert session.power == 0.7
    assert session.command()[0] == 0.7
    session = ready_session()
    wire_spin(session, 0.8, 0.7, maximum=0.69, reported=f32(0.69))
    assert session.fire(1, True, 1.5) == shoot.NOT_SPINNING


def test_fractional_thresholds_keep_their_wire_precision():
    for requested, minimum, reported, accepted in (
            (0.2, 0.20001, f32(0.2), False),
            (0.20001, 0.20001, f32(0.20001), True),
            (0.21, 0.2004, f32(0.20049), True),
            (0.21, 0.2006, f32(0.20051), False)):
        session = ready_session()
        wire_spin(session, requested, minimum, reported=reported)
        result = session.fire(1, True, 1.5)
        assert result == (None if accepted else shoot.NOT_SPINNING)


def test_non_finite_reported_power_does_not_confirm_the_roller():
    for reported in (0.0, math.nan, math.inf, -math.inf):
        session = ready_session()
        wire_spin(session, 0.2, 0.2, reported=reported)
        assert session.fire(1, True, 1.5) == shoot.NOT_SPINNING


def test_nothing_heard_yet_means_no_launcher():
    session = ShootSession()
    assert codes(session) == [shoot.ESTOP_UNKNOWN, shoot.NO_LAUNCHER, shoot.NO_MOTION_PERMISSION]
    assert session.roller(1, 0.5, 0.0) == shoot.ESTOP_UNKNOWN
    assert session.state(0.0)['blockers'][1]['parts'] == ['arbiter', 'roller', 'shot']
    assert not session.allowed


def test_not_permitted_by_the_arbiter_refuses_and_publishes_nothing():
    session = ready_session()
    session.set_arbiter(status(lab_permitted=False), 0.1)
    assert not session.allowed
    assert session.roller(1, 0.5, 0.1) == shoot.NOT_ALLOWED
    assert session.tilt_to(1, 30.0, 0.1) == (shoot.NOT_ALLOWED, None)
    assert session.fire(1, True, 0.1) == shoot.NOT_ALLOWED
    assert session.state(0.1)['allowed'] is False
    assert session.tick(0.5) is None  # after the brief stop hold: nothing


def test_the_teacher_switching_off_ends_the_session():
    session = ready_session()
    assert session.roller(1, 0.5, 0.0) is None
    session.set_arbiter(status(lab_permitted=False), 0.1)
    assert not session.active and session.last_stop['reason'] == shoot.NOT_ALLOWED
    assert session.tick(0.15) == (0.0, None, 0)


def test_no_launcher_without_the_arbiter_or_a_status():
    session = ready_session()
    assert codes(session) == []
    session.set_graph([], [], 0.1)  # nothing subscribes: no arbiter
    assert session.state(0.1)['blockers'] == [
        {'code': shoot.NO_LAUNCHER, 'nodes': None, 'parts': ['arbiter']}]
    session.set_graph([], [ARBITER], 0.2)
    session.set_arbiter(None, 0.2)  # its status went stale
    assert codes(session) == [shoot.NO_LAUNCHER]
    feed(session, 0.3, shot={'active': False})  # shot_component not active (E-stop teardown)
    assert session.state(0.3)['blockers'][0]['parts'] == ['shot']


def test_estop_teardown_is_not_a_missing_shot_node_and_still_refuses_every_command():
    for source in ('topic', 'shot', 'roller'):
        session = ready_session()
        assert session.roller(1, 0.5, 0.0) is None
        if source == 'topic':
            session.set_emergency_stop(True, 0.1)
        feed(session, 0.1, shot={'active': False, 'estop': source == 'shot'},
             roller={'estop': source == 'roller'})
        assert codes(session) == [shoot.EMERGENCY_STOP]
        assert not session.active and session.last_stop['reason'] == shoot.EMERGENCY_STOP
        assert session.roller(2, 0.5, 0.1) == shoot.EMERGENCY_STOP
        assert session.tilt_to(2, 30.0, 0.1) == (shoot.EMERGENCY_STOP, None)
        assert session.fire(2, True, 0.1) == shoot.EMERGENCY_STOP
        assert session.tick(0.15) == (0.0, None, 0)
        session.set_emergency_stop(False, 0.2)
        feed(session, 0.2, shot={'active': False})
        assert codes(session) == [shoot.NO_LAUNCHER], 'still inactive after release'
        feed(session, 0.3)
        assert codes(session) == []


def test_estop_does_not_hide_a_stale_shot_or_missing_arbiter_and_roller():
    session = ready_session()
    session.set_emergency_stop(True, 0.1)
    session.set_roller_status(ROLLER_OK, 1.1)
    session.set_arbiter(status(), 1.1)
    session.tick(1.1)
    assert session.state(1.1)['blockers'] == [
        {'code': shoot.EMERGENCY_STOP, 'nodes': None, 'parts': ['topic']},
        {'code': shoot.NO_LAUNCHER, 'nodes': None, 'parts': ['shot']}]
    session.set_graph([], [], 1.2)
    session.set_shot_status(dict(SHOT_OK, active=False), 2.2)
    session.tick(2.2)
    assert session.state(2.2)['blockers'][1]['parts'] == ['arbiter', 'roller']


def test_unknown_estop_precedes_missing_launcher_and_confirmed_estop():
    session = ShootSession()
    session.set_emergency_stop(True, 0.0)
    assert codes(session)[:3] == [shoot.ESTOP_UNKNOWN, shoot.EMERGENCY_STOP, shoot.NO_LAUNCHER]


def test_a_silent_status_means_no_launcher_and_ends_the_session():
    session = ready_session()
    assert session.roller(1, 0.5, 0.0) is None
    for now in (0.5, 0.8, 1.1):
        session.roller(1, 0.5, now)
        session.set_roller_status(ROLLER_OK, now)  # the shot node went quiet at 0.0
        session.set_arbiter(status(), now)
        session.tick(now)
    assert not session.active and session.last_stop['reason'] == shoot.NO_LAUNCHER


def test_a_silent_arbiter_is_forgotten_by_the_tick():
    session = ready_session()
    session.set_roller_status(ROLLER_OK, 1.0)
    session.set_shot_status(SHOT_OK, 1.0)
    session.tick(1.0, arbiter_timeout_sec=1.5)
    assert codes(session) == []
    session.set_roller_status(ROLLER_OK, 1.6)
    session.set_shot_status(SHOT_OK, 1.6)
    session.tick(1.6, arbiter_timeout_sec=1.5)  # the last status was at 0.0
    assert codes(session) == [shoot.NO_LAUNCHER]


def test_other_publisher_blocks_and_names_the_node():
    session = ready_session()
    session.set_graph(['/rogue'], [ARBITER], 0.0)
    assert session.roller(1, 0.5, 0.0) == shoot.OTHER_PUBLISHER
    assert session.state(0.0)['blockers'] == [
        {'code': shoot.OTHER_PUBLISHER, 'nodes': ['/rogue'], 'parts': None}]


def test_no_motion_permission_blocks_and_ends_the_session():
    session = ready_session()
    session.set_motion_permission(False, 0.0)
    assert session.roller(1, 0.5, 0.0) == shoot.NO_MOTION_PERMISSION
    session.set_motion_permission(True, 0.1)
    assert session.roller(1, 0.5, 0.1) is None
    session.set_motion_permission(False, 0.2)
    assert not session.active and session.last_stop['reason'] == shoot.NO_MOTION_PERMISSION


def test_power_is_clamped_to_the_arbiters_cap_and_repeated():
    session = ready_session()
    assert session.roller(1, 2.0, 0.0) is None
    assert session.power == 0.8
    assert session.tick(0.05) == (0.8, None, 0)
    session.set_arbiter(status(max_power=0.5), 0.1)  # a narrower cap: the power follows
    assert session.power == 0.5


def test_non_finite_values_end_the_owners_session():
    session = ready_session()
    session.roller(1, 0.5, 0.0)
    assert session.roller(1, float('nan'), 0.1) == shoot.INVALID
    assert not session.active and session.last_stop['reason'] == shoot.INVALID
    assert session.roller(2, 'fast', 0.2) == shoot.INVALID


def test_one_owner_but_anyone_can_stop():
    session = ready_session()
    session.roller(1, 0.5, 0.0)
    assert session.roller(2, 0.5, 0.1) == shoot.BUSY
    assert session.stop(2, 0.2)
    assert session.last_stop == {'reason': shoot.STOPPED, 'by': 2}
    assert session.roller(2, 0.5, 0.3) is None


def test_heartbeat_loss_and_the_time_limit_stop_the_roller():
    session = ready_session()
    session.roller(1, 0.5, 0.0)
    assert session.tick(0.4) == (0.5, None, 0)
    assert session.tick(0.6) == (0.0, None, 0)  # deadman 0.5 s exceeded: the stop hold
    assert session.last_stop['reason'] == shoot.TIMEOUT
    assert session.tick(1.0) is None
    session = ready_session(max_spin_sec=1.0)
    spin_up(session, until=0.9)
    session.roller(1, 0.5, 1.05)
    feed(session, 1.05)
    session.tick(1.05)
    assert session.last_stop['reason'] == shoot.TIME_LIMIT


def test_owner_leaving_stops_the_roller():
    session = ready_session()
    session.roller(1, 0.5, 0.0)
    assert not session.disconnect(2, 0.1)
    assert session.disconnect(1, 0.1)
    assert session.last_stop['reason'] == shoot.DISCONNECTED


def test_tilt_is_clamped_to_the_caps_and_the_shot_nodes_range():
    session = ready_session()
    feed(session, 0.0, shot={'tilt_max_deg': 70.0})
    refused, deg = session.tilt_to(1, 200.0, 0.0)
    assert refused is None and deg == 70.0  # the narrower of 120 (arbiter) and 70 (node)
    assert session.active  # a tilt starts a session
    session.set_tilt(deg)
    assert session.tick(0.05) == (0.0, 70.0, 0)  # the target goes with every command
    feed(session, 0.1, shot={'shooting': True})
    assert session.tilt_to(1, 30.0, 0.1) == (shoot.SHOOTING, None)


def test_fire_rules():
    session = ready_session()
    assert session.fire(1, True, 0.0) == shoot.NOT_SPINNING  # no session
    session.roller(1, 0.5, 0.0)
    assert session.fire(1, False, 0.1) == shoot.NO_CONFIRM
    assert session.fire(1, 'yes', 0.1) == shoot.NO_CONFIRM  # only a JSON true confirms
    assert session.fire(1, True, 0.5) == shoot.NOT_SPINNING
    now = spin_up(session, start=0.1, until=1.1)
    assert session.ready_to_fire(now)
    assert session.fire(2, True, now) == shoot.BUSY
    assert session.fire(1, True, now) is None
    assert session.fire_seq == 1 and session.lab_fired == 1
    assert session.tick(now) == (0.5, None, 1)  # the request goes with the command
    assert session.fire(1, True, now + 0.5) == shoot.INTERVAL  # 2 s since this bridge's shot
    feed(session, now + 0.6, shot={'shooting': True}, roller={'command': 0.5, 'source': 'lab'})
    session.roller(1, 0.5, now + 0.6)
    assert session.fire(1, True, now + 0.6) == shoot.SHOOTING


def test_a_slow_roller_never_spins_up():
    session = ready_session()
    now = spin_up(session, power=0.1, until=2.0)  # below min_fire_power (0.2)
    assert session.fire(1, True, now) == shoot.NOT_SPINNING
    assert session.state(now)['spin_ready_in_sec'] is None


def test_the_arbiters_and_the_shot_nodes_intervals_count():
    session = ready_session()
    now = spin_up(session, until=1.2)
    session.set_arbiter(status(next_fire_in_sec=1.5), now)  # a controller shot just now
    assert session.fire(1, True, now) == shoot.INTERVAL
    assert math.isclose(session.next_fire_in(now + 1.0), 0.5)
    session = ready_session()
    now = spin_up(session, until=1.2)
    session.set_shot_status(dict(SHOT_OK, next_fire_in_sec=0.4), now)
    assert session.fire(1, True, now) == shoot.INTERVAL


def test_the_arbiter_giving_the_launcher_to_the_controller_ends_the_session():
    session = ready_session()
    session.set_arbiter(status(lab_count=4), 0.0)
    session.roller(1, 0.5, 0.0)
    # An earlier refusal (before this session's first command reached the arbiter) is not its.
    session.set_arbiter(status(lab_count=4, lab_refusal='controller'), 0.05)
    assert session.active
    session.set_arbiter(status(lab_count=6, lab_refusal='controller'), 0.1)
    assert not session.active and session.last_stop['reason'] == shoot.CONTROLLER


def test_a_locked_lab_is_the_controller_blocker():
    session = ready_session()
    session.roller(1, 0.5, 0.0)
    session.set_arbiter(status(lab_count=1, lab_locked=True, active_source='joy'), 0.1)
    assert not session.active and session.last_stop['reason'] == shoot.CONTROLLER
    assert session.state(0.1)['blockers'] == [
        {'code': shoot.CONTROLLER, 'nodes': None, 'parts': ['arbiter']}]
    assert session.roller(2, 0.5, 0.2) == shoot.CONTROLLER
    session.set_arbiter(status(lab_count=2, lab_locked=False), 0.5)  # the lab's run ended
    feed(session, 1.2)
    assert session.roller(1, 0.5, 1.2) is None


def test_other_refusals_do_not_end_the_session():
    session = ready_session()
    session.roller(1, 0.5, 0.0)
    session.set_arbiter(status(lab_count=3, lab_refusal='not_spinning'), 0.1)
    assert session.active


def test_a_new_blocker_publishes_zero_without_a_session():
    session = ready_session()
    assert session.tick(0.5) is None  # the start's own stop hold is over
    session.set_emergency_stop(True, 0.6)
    assert session.tick(0.7) == (0.0, None, 0)
    assert session.tick(1.0) is None


def test_emergency_stop_from_any_source():
    session = ready_session()
    session.roller(1, 0.5, 0.0)
    feed(session, 0.1, roller={'estop': True})
    assert not session.active and session.last_stop['reason'] == shoot.EMERGENCY_STOP
    assert session.state(0.1)['blockers'][0]['parts'] == ['roller']
    feed(session, 0.2)
    session.set_emergency_stop(True, 0.2)
    assert session.state(0.2)['blockers'][0]['parts'] == ['topic']


def test_version_changes_only_on_news():
    session = ready_session()
    version = session.version
    feed(session, 0.1)
    assert session.version == version
    session.roller(1, 0.5, 0.2)
    started = session.version
    assert started > version
    session.roller(1, 0.5, 0.3)  # heartbeat, same power
    assert session.version == started


def test_state_shape():
    session = ready_session()
    session.roller(1, 0.5, 0.0)
    session.set_roller_status(dict(ROLLER_OK, command=0.5, source='lab'), 0.0)
    state = session.state(0.4)
    assert state['owner'] == 1 and state['active'] and state['allowed']
    assert state['roller'] == {'power': 0.5, 'since_sec': 0.4}
    assert state['spin_ready_in_sec'] == 0.6
    assert state['limits'] == {'max_power': 0.8, 'min_fire_power': 0.2, 'spin_up_sec': 1.0,
                               'fire_interval_sec': 2.0, 'tilt_min': 0.0, 'tilt_max': 120.0,
                               'deadman': 0.5, 'seconds': 30.0}


def test_the_launcher_is_refused_until_the_estop_topic_is_heard():
    session = ShootSession()
    session.set_graph([], [ARBITER], 0.0)
    feed(session, 0.0)
    session.set_motion_permission(True, 0.0)
    assert codes(session) == [shoot.ESTOP_UNKNOWN]
    session.set_emergency_stop(False, 0.1)  # a derived "released" (/drive_status): no change
    assert session.roller(1, 0.5, 0.1) == shoot.ESTOP_UNKNOWN
    session.set_estop_known(True, 0.2)
    assert session.roller(1, 0.5, 0.2) is None


# --- a coalesced tilt belongs to its session (S3) -----------------------------------------------

def _tilt_session(gap=0.06):
    session = ready_session()
    tilt = shoot.TiltCoalescer(gap)
    assert session.roller(1, 0.0, 0.0) is None  # a session without spinning
    refused, deg = session.tilt_to(1, 30.0, 0.0)
    assert refused is None and tilt.request(deg, session.session_token(), 0.0) == 30.0
    refused, deg = session.tilt_to(1, 40.0, 0.02)  # inside the gap: kept
    assert refused is None and tilt.request(deg, session.session_token(), 0.02) is None
    assert tilt.pending == (40.0, (1, session.session))
    return session, tilt


def _due(session, tilt, now):
    return tilt.due(session.session_token(), bool(session.blockers()), now)


def test_a_kept_tilt_is_sent_once_while_its_session_runs():
    session, tilt = _tilt_session()
    assert _due(session, tilt, 0.05) is None  # still inside the gap
    assert _due(session, tilt, 0.1) == 40.0
    assert _due(session, tilt, 0.2) is None  # once


def _ended_by(end):
    session, tilt = _tilt_session()
    end(session)
    assert not session.active
    # Even without tilt.drop(): the token no longer matches anything that runs.
    assert _due(session, tilt, 0.1) is None
    assert tilt.pending is None


def test_a_kept_tilt_dies_with_a_disconnect():
    _ended_by(lambda session: session.disconnect(1, 0.03))


def test_a_kept_tilt_dies_with_an_explicit_stop():
    _ended_by(lambda session: session.stop(2, 0.03))  # any page's roller_stop / stop-all


def test_a_kept_tilt_dies_with_the_deadman():
    _ended_by(lambda session: session.tick(0.6))  # no roller heartbeat for deadman_sec


def test_a_kept_tilt_dies_with_a_blocker():
    _ended_by(lambda session: session.set_arbiter(status(lab_locked=True), 0.03))  # controller


def test_a_kept_tilt_dies_with_the_estop():
    _ended_by(lambda session: session.set_emergency_stop(True, 0.03))


def test_a_kept_tilt_dies_with_an_invalid_request():
    _ended_by(lambda session: session.roller(1, float('nan'), 0.03))


def test_a_kept_tilt_is_never_inherited_by_the_next_session():
    session, tilt = _tilt_session()
    session.stop(1, 0.03)
    assert session.roller(1, 0.0, 0.04) is None  # the same page starts a new session at once
    assert session.active and session.owner == 1
    assert _due(session, tilt, 0.1) is None  # the old session's tilt is void


def test_a_kept_tilt_is_void_while_blocked_even_if_the_session_survived():
    session, tilt = _tilt_session()
    assert tilt.due(session.session_token(), True, 0.1) is None
    assert tilt.pending is None


def test_drop_forgets_a_kept_tilt():
    session, tilt = _tilt_session()
    tilt.drop()
    assert _due(session, tilt, 0.1) is None


def test_no_tilt_is_kept_without_a_session():
    tilt = shoot.TiltCoalescer(0.06)
    assert tilt.request(30.0, None, 0.0) is None and tilt.pending is None


def test_an_ended_session_forgets_its_tilt_target():
    session = ready_session()
    session.roller(1, 0.0, 0.0)
    session.set_tilt(30.0)
    session.stop(1, 0.1)
    assert session.tilt is None
    assert session.tick(0.15) == (0.0, None, 0)  # the stop carries no target


# --- the spin-up counts only while the roller is seen turning (review: a stopped roller) -------

def test_the_spin_up_waits_for_the_roller_status():
    session = ready_session()
    now = 0.0
    while now <= 1.5:  # commanded for 1.5 s, but /roller/status keeps saying it stands still
        session.roller(1, 0.5, now)
        feed(session, now)
        now = round(now + 0.1, 3)
    assert session.spin_ready_in(now) == 1.0  # the whole spin-up is still ahead
    assert session.fire(1, True, now) == shoot.NOT_SPINNING
    session.roller(1, 0.5, now)
    feed(session, now, roller={'command': 0.5, 'source': 'lab'})  # now it turns for the lab
    assert session.fire(1, True, now + 0.5) == shoot.NOT_SPINNING
    session.roller(1, 0.5, now + 0.5)
    feed(session, now + 0.5, roller={'command': 0.5, 'source': 'lab'})
    session.roller(1, 0.5, now + 1.0)
    feed(session, now + 1.0, roller={'command': 0.5, 'source': 'lab'})
    assert session.fire(1, True, now + 1.0) is None


def test_a_roller_turning_for_the_controller_does_not_count():
    session = ready_session()
    now = 0.0
    while now <= 1.5:
        session.roller(1, 0.5, now)
        feed(session, now, roller={'command': 1.0, 'source': 'joy'})
        now = round(now + 0.1, 3)
    assert session.fire(1, True, now) == shoot.NOT_SPINNING


# --- a session the bridge ended is not restarted by commands still on their way --------------

def test_the_owners_commands_after_a_session_the_bridge_ended_are_stale():
    session = ready_session()
    session.roller(1, 0.5, 0.0)
    feed(session, 0.1, roller={'estop': True})  # ended by the bridge
    feed(session, 0.15)                          # and the E-stop is released at once
    assert session.roller(1, 0.5, 0.2) == shoot.STALE  # its heartbeat was on its way
    assert session.tilt_to(1, 30.0, 0.2) == (shoot.STALE, None)
    assert session.fire(1, True, 0.2) == shoot.STALE
    assert not session.active
    feed(session, 1.2)
    assert session.roller(1, 0.5, 1.2) is None  # the page asks again later


def test_the_owners_own_stop_does_not_guard_it():
    session = ready_session()
    session.roller(1, 0.5, 0.0)
    session.stop(1, 0.1)
    assert session.roller(1, 0.5, 0.2) is None
