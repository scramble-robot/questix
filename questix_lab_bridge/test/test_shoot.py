import math

from questix_lab_bridge import shoot
from questix_lab_bridge.shoot import ShootArbiter

ROLLER_OK = {'command': 0.0, 'source': 'idle', 'lab_accepted': True, 'lab_locked': False,
             'estop': False}
SHOT_OK = {'tilt_deg': 30.0, 'shooting': False, 'fired_count': 0, 'last_fire_source': None,
           'lab_accepted': True, 'estop': False, 'active': True}


def feed(arbiter, now, roller=None, shot=None):
    """Both statuses as the launcher nodes send them (5 Hz), with overrides."""
    arbiter.set_roller_status(dict(ROLLER_OK, **(roller or {})), now)
    arbiter.set_shot_status(dict(SHOT_OK, **(shot or {})), now)


def ready_arbiter(**options):
    arbiter = ShootArbiter(allowed=True, **options)
    arbiter.set_graph([], ['/esc_motor_control'], ['/shot_component'], 0.0)
    feed(arbiter, 0.0)
    return arbiter


def spin_up(arbiter, client=1, power=0.5, start=0.0, until=1.2, shot=None):
    """Heartbeat the roller every 0.1 s (statuses keep coming) and return the time reached."""
    now = start
    while now <= until + 1e-9:
        assert arbiter.roller(client, power, now) is None
        feed(arbiter, now, shot=shot)
        arbiter.tick(now)
        now = round(now + 0.1, 3)
    return round(now - 0.1, 3)


def codes(arbiter):
    return [code for code, _ in arbiter.blockers()]


def test_not_allowed_refuses_everything_and_publishes_nothing():
    arbiter = ShootArbiter(allowed=False)
    feed(arbiter, 0.0)
    assert arbiter.roller(1, 0.5, 0.0) == shoot.NOT_ALLOWED
    assert arbiter.tilt_to(1, 30.0, 0.0) == (shoot.NOT_ALLOWED, None)
    assert arbiter.fire(1, True, 0.0) == shoot.NOT_ALLOWED
    assert arbiter.tick(0.1) is None
    assert arbiter.state(0.1)['blockers'] == [
        {'code': shoot.NOT_ALLOWED, 'nodes': None, 'parts': None}]


def test_nothing_heard_yet_means_no_launcher():
    arbiter = ShootArbiter(allowed=True)
    assert codes(arbiter) == [shoot.NO_LAUNCHER]
    assert arbiter.roller(1, 0.5, 0.0) == shoot.NO_LAUNCHER
    assert arbiter.state(0.0)['blockers'][0]['parts'] == ['roller', 'shot']


def test_no_launcher_without_subscribers_or_lab_input():
    arbiter = ready_arbiter()
    assert codes(arbiter) == []
    arbiter.set_graph([], ['/esc_motor_control'], [], 0.1)
    assert arbiter.state(0.1)['blockers'] == [
        {'code': shoot.NO_LAUNCHER, 'nodes': None, 'parts': ['shot']}]
    arbiter.set_graph([], ['/esc_motor_control'], ['/shot_component'], 0.2)
    # A competition launch: the node runs but does not take lab input.
    feed(arbiter, 0.2, roller={'lab_accepted': False})
    assert arbiter.roller(1, 0.5, 0.2) == shoot.NO_LAUNCHER
    feed(arbiter, 0.3, shot={'active': False})  # shot_component not active (E-stop teardown)
    assert arbiter.state(0.3)['blockers'][0]['parts'] == ['shot']


def test_silent_status_means_no_launcher_and_ends_the_session():
    arbiter = ready_arbiter()
    assert arbiter.roller(1, 0.5, 0.0) is None
    arbiter.set_roller_status(ROLLER_OK, 0.4)
    arbiter.set_shot_status(SHOT_OK, 0.4)
    for now in (0.5, 0.8, 1.1, 1.3):
        arbiter.roller(1, 0.5, now)
        arbiter.set_roller_status(ROLLER_OK, now)  # the shot node went quiet at 0.4
    assert arbiter.tick(1.5) == 0.0
    assert arbiter.last_stop == {'reason': shoot.NO_LAUNCHER, 'by': None}
    assert arbiter.state(1.5)['blockers'][0]['parts'] == ['shot']


def test_other_publisher_blocks_and_names_the_node():
    arbiter = ready_arbiter()
    arbiter.set_graph(['/rogue', '/rogue'], ['/esc'], ['/shot'], 0.1)
    assert arbiter.roller(1, 0.5, 0.1) == shoot.OTHER_PUBLISHER
    assert arbiter.state(0.1)['blockers'] == [
        {'code': shoot.OTHER_PUBLISHER, 'nodes': ['/rogue'], 'parts': None}]


def test_power_is_clamped_and_repeated():
    arbiter = ready_arbiter(max_power=0.8)
    assert arbiter.roller(1, 1.5, 0.0) is None
    assert arbiter.owner == 1 and arbiter.power == 0.8
    assert arbiter.tick(0.05) == 0.8
    assert arbiter.roller(1, -1.0, 0.1) is None
    assert arbiter.tick(0.15) == 0.0  # the session goes on with the roller stopped
    assert arbiter.active


def test_non_finite_values_end_the_owners_session():
    arbiter = ready_arbiter()
    arbiter.roller(1, 0.5, 0.0)
    assert arbiter.roller(1, float('nan'), 0.1) == shoot.INVALID
    assert not arbiter.active and arbiter.last_stop['reason'] == shoot.INVALID
    assert arbiter.roller(2, 'fast', 0.2) == shoot.INVALID
    assert arbiter.roller(2, True, 0.2) == shoot.INVALID
    assert arbiter.tilt_to(2, math.inf, 0.2) == (shoot.INVALID, None)


def test_one_owner_but_anyone_can_stop():
    arbiter = ready_arbiter()
    arbiter.roller(1, 0.5, 0.0)
    assert arbiter.roller(2, 0.5, 0.1) == shoot.BUSY
    assert arbiter.tilt_to(2, 10.0, 0.1) == (shoot.BUSY, None)
    assert arbiter.fire(2, True, 0.1) == shoot.BUSY
    assert arbiter.stop(2, 0.2)
    assert arbiter.last_stop == {'reason': shoot.STOPPED, 'by': 2}
    assert arbiter.tick(0.25) == 0.0  # zero held briefly...
    assert arbiter.tick(0.6) is None  # ...then nothing: no competing publisher
    assert not arbiter.stop(2, 0.7)
    assert arbiter.roller(2, 0.5, 0.8) is None  # now page 2 may


def test_heartbeat_loss_stops_the_roller():
    arbiter = ready_arbiter()
    arbiter.roller(1, 0.5, 0.0)
    feed(arbiter, 0.4)
    assert arbiter.tick(0.4) == 0.5
    assert arbiter.tick(0.6) == 0.0  # deadman 0.5 s
    assert arbiter.last_stop == {'reason': shoot.TIMEOUT, 'by': None}


def test_owner_leaving_stops_the_roller():
    arbiter = ready_arbiter()
    arbiter.roller(1, 0.5, 0.0)
    assert not arbiter.disconnect(2, 0.1)
    assert arbiter.disconnect(1, 0.1)
    assert arbiter.last_stop['reason'] == shoot.DISCONNECTED
    assert arbiter.tick(0.15) == 0.0


def test_session_time_limit():
    arbiter = ready_arbiter(max_spin_sec=3.0)
    spin_up(arbiter, until=3.0)
    assert arbiter.active
    arbiter.roller(1, 0.5, 3.05)
    feed(arbiter, 3.05)
    assert arbiter.tick(3.1) == 0.0
    assert arbiter.last_stop['reason'] == shoot.TIME_LIMIT


def test_tilt_is_clamped_and_starts_a_session():
    arbiter = ready_arbiter(tilt_min=0.0, tilt_max=70.0)
    assert arbiter.tilt_to(1, 100.0, 0.0) == (None, 70.0)
    assert arbiter.owner == 1
    assert arbiter.tilt_to(1, -5, 0.1) == (None, 0.0)
    feed(arbiter, 0.2, shot={'shooting': True})
    assert arbiter.tilt_to(1, 20.0, 0.2) == (shoot.SHOOTING, None)


def test_fire_rules():
    arbiter = ready_arbiter()
    # Nobody spins the roller: nothing to fire with.
    assert arbiter.fire(1, True, 0.0) == shoot.NOT_SPINNING
    # Too slow never becomes ready.
    arbiter.roller(1, 0.1, 0.0)
    feed(arbiter, 1.5)
    arbiter.roller(1, 0.1, 1.5)
    assert arbiter.fire(1, True, 1.5) == shoot.NOT_SPINNING
    # Fast enough, but not yet for 1 s.
    arbiter.roller(1, 0.5, 1.6)
    assert arbiter.state(2.0)['spin_ready_in_sec'] == 0.6
    assert arbiter.fire(1, True, 2.0) == shoot.NOT_SPINNING
    now = spin_up(arbiter, start=2.0, until=2.7)
    assert arbiter.ready_to_fire(now)
    # The pupil's tick is required every time.
    assert arbiter.fire(1, False, now) == shoot.NO_CONFIRM
    assert arbiter.fire(1, True, now) is None
    assert arbiter.lab_fired == 1
    assert arbiter.fire(1, True, now + 0.5) == shoot.INTERVAL
    assert arbiter.state(now + 0.5)['next_fire_in_sec'] == 1.5
    # The node reports the motion (and counts the lab shot: the interval is not restarted).
    arbiter.roller(1, 0.5, now + 0.3)
    arbiter.set_roller_status(ROLLER_OK, now + 0.3)
    arbiter.set_shot_status(dict(SHOT_OK, shooting=True, fired_count=1,
                                 last_fire_source='lab'), now + 0.3)
    assert round(arbiter.next_fire_in(now + 0.3), 6) == 1.7
    later = spin_up(arbiter, start=round(now + 0.4, 3), until=round(now + 2.1, 3),
                    shot={'shooting': True, 'fired_count': 1, 'last_fire_source': 'lab'})
    assert arbiter.fire(1, True, later) == shoot.SHOOTING
    feed(arbiter, later, shot={'fired_count': 1, 'last_fire_source': 'lab'})
    assert arbiter.fire(1, True, later) is None
    assert arbiter.lab_fired == 2
    now = later - 2.2
    # Dropping below the minimum power restarts the spin-up.
    arbiter.roller(1, 0.1, now + 2.3)
    arbiter.roller(1, 0.5, now + 2.4)
    assert arbiter.state(now + 2.4)['spin_ready_in_sec'] == 1.0


def test_controller_shot_counts_for_the_interval_and_takes_over():
    arbiter = ready_arbiter()
    now = spin_up(arbiter)
    feed(arbiter, now, shot={'fired_count': 1, 'last_fire_source': 'joy'})
    assert not arbiter.active
    assert arbiter.last_stop == {'reason': shoot.CONTROLLER, 'by': None}
    assert codes(arbiter) == [shoot.CONTROLLER]
    assert arbiter.next_fire_in(now) == 2.0
    # The controller's quiet time passes.
    feed(arbiter, now + 1.1, shot={'fired_count': 1, 'last_fire_source': 'joy'})
    arbiter.tick(now + 1.1)
    assert codes(arbiter) == []


def test_controller_on_the_roller_takes_over():
    arbiter = ready_arbiter()
    arbiter.roller(1, 0.5, 0.0)
    feed(arbiter, 0.1, roller={'source': 'joy'})
    assert arbiter.last_stop['reason'] == shoot.CONTROLLER
    assert arbiter.tick(0.12) == 0.0
    assert arbiter.roller(1, 0.5, 0.2) == shoot.CONTROLLER
    # Released: still the controller's for controller_quiet_sec (like the ESC's quiet time),
    # and the ESC keeps the lab locked until it hears 0.
    feed(arbiter, 0.3, roller={'source': 'idle', 'lab_locked': True})
    assert codes(arbiter) == [shoot.CONTROLLER]
    feed(arbiter, 1.2, roller={'source': 'idle', 'lab_locked': True})
    assert codes(arbiter) == [shoot.CONTROLLER]
    # The bridge re-arms it with a short 0, and not again at once.
    assert arbiter.tick(1.2) == 0.0
    assert arbiter.tick(1.45) == 0.0
    assert arbiter.tick(1.6) is None
    feed(arbiter, 1.6)
    assert arbiter.roller(1, 0.5, 1.6) is None
    # shot_component may report its own lock too.
    feed(arbiter, 1.7, shot={'lab_locked': True})
    assert arbiter.state(1.7)['blockers'] == [
        {'code': shoot.CONTROLLER, 'nodes': None, 'parts': ['shot']}]


def test_estop_keeps_the_esc_locked_until_the_bridge_re_arms_it():
    arbiter = ready_arbiter()
    arbiter.roller(1, 0.5, 0.0)
    feed(arbiter, 0.1, roller={'estop': True, 'lab_locked': True})
    assert codes(arbiter) == [shoot.EMERGENCY_STOP]  # not "controller": the E-stop's lock
    assert arbiter.last_stop['reason'] == shoot.EMERGENCY_STOP
    assert arbiter.tick(0.3) == 0.0  # zero on the new blocker
    assert arbiter.tick(0.5) is None  # no re-arm while the E-stop is on
    feed(arbiter, 0.6, roller={'lab_locked': True})  # released, still locked
    assert codes(arbiter) == [shoot.CONTROLLER]
    assert arbiter.tick(0.6) == 0.0  # re-arm
    feed(arbiter, 0.8)
    assert codes(arbiter) == []


def test_a_new_blocker_publishes_zero_without_a_session():
    arbiter = ready_arbiter()
    feed(arbiter, 0.9)
    assert arbiter.tick(1.0) is None
    arbiter.set_emergency_stop(True, 1.0)
    assert arbiter.tick(1.1) == 0.0
    assert arbiter.tick(1.25) == 0.0
    assert arbiter.tick(1.5) is None


def test_limits_follow_the_nodes_but_never_widen():
    arbiter = ready_arbiter(max_power=0.8, tilt_min=0.0, tilt_max=120.0)
    assert arbiter.roller(1, 0.8, 0.0) is None
    version = arbiter.version
    feed(arbiter, 0.1, roller={'lab_max_speed': 0.6},
         shot={'tilt_min_deg': 10.0, 'tilt_max_deg': 70.0})
    assert arbiter.version > version
    assert (arbiter.max_power, arbiter.tilt_min, arbiter.tilt_max) == (0.6, 10.0, 70.0)
    assert arbiter.power == 0.6  # the running command follows at once
    assert arbiter.tilt_to(1, 100.0, 0.2) == (None, 70.0)
    assert arbiter.tilt_to(1, 0.0, 0.2) == (None, 10.0)
    feed(arbiter, 0.3, roller={'lab_max_speed': 1.0},
         shot={'tilt_min_deg': 0.0, 'tilt_max_deg': 180.0})
    assert (arbiter.max_power, arbiter.tilt_min, arbiter.tilt_max) == (0.8, 0.0, 120.0)
    assert arbiter.state(0.3)['limits']['tilt_max'] == 120.0


def test_the_shot_nodes_own_interval_counts():
    arbiter = ready_arbiter()
    now = spin_up(arbiter)
    feed(arbiter, now, shot={'next_fire_in_sec': 1.5})
    assert arbiter.fire(1, True, now) == shoot.INTERVAL
    assert round(arbiter.next_fire_in(now + 0.5), 6) == 1.0


def test_emergency_stop_from_any_source():
    arbiter = ready_arbiter()
    arbiter.roller(1, 0.5, 0.0)
    arbiter.set_emergency_stop(True, 0.1)
    assert arbiter.last_stop['reason'] == shoot.EMERGENCY_STOP
    assert arbiter.fire(1, True, 0.1) == shoot.EMERGENCY_STOP
    arbiter.set_emergency_stop(False, 0.2)
    feed(arbiter, 0.2, roller={'estop': True})
    assert arbiter.state(0.2)['blockers'] == [
        {'code': shoot.EMERGENCY_STOP, 'nodes': None, 'parts': ['roller']}]
    feed(arbiter, 0.3)
    assert codes(arbiter) == []


def test_version_changes_only_on_news():
    arbiter = ready_arbiter()
    version = arbiter.version
    feed(arbiter, 0.1)
    arbiter.tick(0.1)
    assert arbiter.version == version
    arbiter.roller(1, 0.5, 0.2)
    started = arbiter.version
    assert started > version
    arbiter.roller(1, 0.5, 0.3)  # heartbeat with the same power
    feed(arbiter, 0.3)
    arbiter.tick(0.3)
    assert arbiter.version == started
    # Becoming ready to fire is news.
    spin_up(arbiter, start=0.4, until=1.3)
    assert arbiter.version > started and arbiter.state(1.3)['ready_to_fire']


def test_state_shape():
    arbiter = ready_arbiter()
    now = spin_up(arbiter, power=0.6)
    state = arbiter.state(now)
    assert set(state) == {'allowed', 'blockers', 'owner', 'active', 'roller', 'tilt_deg',
                          'ready_to_fire', 'next_fire_in_sec', 'spin_ready_in_sec',
                          'session_sec', 'fired', 'limits', 'last_stop'}
    assert state['roller'] == {'power': 0.6, 'since_sec': 1.2}
    assert state['owner'] == 1 and state['ready_to_fire'] is True
    assert state['limits'] == {'max_power': 0.8, 'min_fire_power': 0.2, 'spin_up_sec': 1.0,
                               'fire_interval_sec': 2.0, 'tilt_min': 0.0, 'tilt_max': 120.0,
                               'deadman': 0.5, 'seconds': 30.0}
