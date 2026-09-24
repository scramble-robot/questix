from questix_lab_bridge import drive
from questix_lab_bridge.drive import DriveArbiter


def ready_arbiter(**options):
    arbiter = DriveArbiter(allowed=True, max_linear=0.3, max_angular=1.0, deadman_sec=0.5,
                           max_run_sec=30.0, stop_hold_sec=0.3, **options)
    arbiter.set_graph([], ['/drive_component'], 0.0)
    return arbiter


def test_not_allowed_refuses_everything_and_publishes_nothing():
    arbiter = DriveArbiter(allowed=False, max_linear=0.3, max_angular=1.0)
    arbiter.set_graph([], ['/drive_component'], 0.0)
    assert arbiter.request(1, 0.1, 0.0, 0.0) == drive.NOT_ALLOWED
    assert arbiter.tick(0.1) is None
    assert arbiter.state()['blockers'] == [{'code': drive.NOT_ALLOWED, 'nodes': None}]


def test_other_publisher_blocks_and_names_the_node():
    arbiter = ready_arbiter()
    arbiter.set_graph(['/joy_controller'], ['/drive_component'], 0.0)
    assert arbiter.request(1, 0.1, 0.0, 0.0) == drive.OTHER_PUBLISHER
    assert arbiter.state()['blockers'] == [
        {'code': drive.OTHER_PUBLISHER, 'nodes': ['/joy_controller']}]


def test_no_drive_node_blocks():
    arbiter = ready_arbiter()
    arbiter.set_graph([], [], 0.0)
    assert arbiter.request(1, 0.1, 0.0, 0.0) == drive.NO_DRIVE_NODE


def test_drive_clamps_and_repeats_the_command():
    arbiter = ready_arbiter()
    assert arbiter.request(1, 2.0, -5.0, 0.0) is None
    assert arbiter.owner == 1
    assert arbiter.tick(0.05) == (0.3, -1.0)
    assert arbiter.tick(0.10) == (0.3, -1.0)


def test_non_finite_values_stop_the_owner():
    arbiter = ready_arbiter()
    arbiter.request(1, 0.1, 0.0, 0.0)
    assert arbiter.request(1, float('nan'), 0.0, 0.1) == drive.INVALID
    assert not arbiter.active
    assert arbiter.request(2, 'fast', 0.0, 0.1) == drive.INVALID


def test_one_owner_at_a_time_but_anyone_can_stop():
    arbiter = ready_arbiter()
    arbiter.request(1, 0.1, 0.0, 0.0)
    assert arbiter.request(2, 0.2, 0.0, 0.1) == drive.BUSY
    assert arbiter.stop(2, 0.2)
    assert not arbiter.active
    assert arbiter.last_stop == {'reason': drive.STOPPED, 'by': 2}
    # Once stopped, another page may take over.
    assert arbiter.request(2, 0.2, 0.0, 0.3) is None


def test_stop_only_own_ends_only_the_senders_run():
    arbiter = ready_arbiter()
    arbiter.request(1, 0.1, 0.0, 0.0)
    # Page 2 was refused (busy) and ends "its" experiment: page 1 keeps driving.
    assert arbiter.request(2, 0.1, 0.0, 0.1) == drive.BUSY
    assert not arbiter.stop(2, 0.2, only_own=True)
    assert arbiter.active and arbiter.owner == 1
    assert arbiter.tick(0.25) == (0.1, 0.0)
    # The owner itself may end it that way.
    assert arbiter.stop(1, 0.3, only_own=True)
    assert arbiter.last_stop == {'reason': drive.STOPPED, 'by': 1}
    # Nothing runs: nothing to stop, whatever the scope.
    assert not arbiter.stop(1, 0.4, only_own=True)
    assert not arbiter.stop(2, 0.4)


def test_silence_stops_the_robot_then_zero_is_held_briefly():
    arbiter = ready_arbiter()
    arbiter.request(1, 0.2, 0.0, 0.0)
    assert arbiter.tick(0.4) == (0.2, 0.0)
    assert arbiter.tick(0.6) == (0.0, 0.0)  # deadman 0.5 s exceeded
    assert arbiter.last_stop['reason'] == drive.TIMEOUT
    assert arbiter.tick(0.8) == (0.0, 0.0)
    assert arbiter.tick(1.0) is None  # idle: no competing publisher


def test_run_time_limit():
    arbiter = ready_arbiter()
    arbiter.request(1, 0.1, 0.0, 0.0)
    now = 0.0
    while now < 30.0:
        now += 0.25
        arbiter.request(1, 0.1, 0.0, now)
        arbiter.tick(now)
    assert arbiter.tick(30.3) == (0.0, 0.0)
    assert arbiter.last_stop['reason'] == drive.TIME_LIMIT


def test_owner_disconnect_stops():
    arbiter = ready_arbiter()
    arbiter.request(1, 0.1, 0.0, 0.0)
    arbiter.disconnect(2, 0.1)
    assert arbiter.active
    arbiter.disconnect(1, 0.1)
    assert arbiter.last_stop['reason'] == drive.DISCONNECTED


def test_blocker_during_a_run_stops_it():
    arbiter = ready_arbiter()
    arbiter.request(1, 0.1, 0.0, 0.0)
    arbiter.set_emergency_stop(True, 0.1)
    assert not arbiter.active
    assert arbiter.last_stop['reason'] == drive.EMERGENCY_STOP
    assert arbiter.request(1, 0.1, 0.0, 0.2) == drive.EMERGENCY_STOP
    arbiter.set_emergency_stop(False, 0.3)
    arbiter.request(1, 0.1, 0.0, 0.4)
    arbiter.set_graph(['/joy_controller'], ['/drive_component'], 0.5)
    assert arbiter.last_stop['reason'] == drive.OTHER_PUBLISHER


def test_version_changes_only_on_news():
    arbiter = ready_arbiter()
    version = arbiter.version
    arbiter.set_graph([], ['/drive_component'], 0.1)
    assert arbiter.version == version
    arbiter.request(1, 0.1, 0.0, 0.2)
    started = arbiter.version
    assert started > version
    arbiter.request(1, 0.1, 0.0, 0.3)  # heartbeat with the same command
    assert arbiter.version == started
