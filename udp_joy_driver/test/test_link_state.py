"""Safety transitions and packet loss with deterministic monotonic timestamps."""

import pytest
from udp_joy_driver.link_state import LinkState

HOME = 0x400
BACK = 0x20


@pytest.fixture
def link():
    return LinkState(deadzone=0.1, message_timeout_sec=0.5, input_stale_sec=1.0,
                     arm_button=10, stop_button=8, allow_rearm_after_stop=False)


def receive(link, packet, now, **changes):
    p = packet(**changes)
    accepted = link.accept(p, bytes.fromhex(p['raw']), now)
    return accepted, link.snapshot(now)


def arm(link, packet):
    receive(link, packet, -0.01, seq=0)
    receive(link, packet, 0, seq=1, buttons=HOME)
    receive(link, packet, 0.01, seq=2)


def test_off_arm_and_neutral(link, packet):
    assert not receive(link, packet, 0, x=32767)[1][2]
    assert receive(link, packet, 0.01, seq=2, buttons=BACK)[1][3][0] == 'OFF'
    assert receive(link, packet, 0.02, seq=3, buttons=HOME)[1][2]
    for seq in (4, 5):
        result = receive(link, packet, seq * .01, seq=seq, buttons=HOME, x=32767)[1]
        assert not any(result[0]) and not any(result[1])
    receive(link, packet, .06, seq=6)
    assert receive(link, packet, .07, seq=7, x=32767)[1][0][0] == -1


@pytest.mark.parametrize('rearm', [True, False])
def test_stop_priority_and_persistence(link, packet, rearm):
    link.rearm = rearm
    arm(link, packet)
    result = receive(link, packet, .02, seq=3, buttons=HOME | BACK)[1]
    assert result[3][0] == 'STOPPED' and not result[2]
    receive(link, packet, .03, seq=4)
    result = receive(link, packet, .04, seq=5, buttons=HOME)[1]
    assert result[2] == rearm
    if rearm:
        assert not any(result[1])  # HOME still needs release
        receive(link, packet, .05, seq=6, buttons=BACK)
    # A complete sender restart must not clear STOPPED.
    assert not link.snapshot(3)[2]
    receive(link, packet, 3.01, seq=0)
    result = receive(link, packet, 3.02, seq=1, buttons=HOME)[1]
    assert result[2] == rearm


@pytest.mark.parametrize('age,alive', [(0.49999, True), (0.5, False), (0.50001, False)])
def test_timeout_boundaries(link, packet, age, alive):
    arm(link, packet)
    receive(link, packet, .02, seq=3, x=32767)
    result = link.snapshot(.02 + age)
    assert result[2] == alive
    if not alive:
        result = receive(link, packet, .6, seq=4, x=32767)[1]
        assert result[2] and not any(result[0])
        receive(link, packet, .61, seq=5)
        assert receive(link, packet, .62, seq=6, x=32767)[1][0][0] == -1


def test_seq_wrap_old_and_restart(link, packet):
    receive(link, packet, 0, seq=0xfffffffe)
    assert receive(link, packet, .01, seq=0xffffffff)[0]
    assert receive(link, packet, .02, seq=0)[0]
    assert not receive(link, packet, .3, seq=0)[0]
    assert not receive(link, packet, .4, seq=0xffffffff)[0]
    assert link.last_packet == .02
    assert receive(link, packet, 2.02, seq=0)[0]


@pytest.mark.parametrize('changes,reason', [
    (dict(protocol='none', connected=False, kind='status'), 'disconnected'),
    (dict(pid='0001', kind='status'), 'connection changed'),
    (dict(raw='ff' * 20), 'unknown report'), (dict(ep=2), 'unknown report')])
def test_invalid_recovery(link, packet, changes, reason):
    arm(link, packet)
    result = receive(link, packet, .02, seq=3, **changes)[1]
    assert not result[2] and not any(result[0]) and result[3][1] == reason
    result = receive(link, packet, .03, seq=4, kind='status')[1]
    assert not result[2]  # status cannot decode or arm


def test_reports_grace_and_continuous_thinned_input(link, packet):
    arm(link, packet)
    for i in range(3, 300):
        t = i * .0125  # 125 Hz thinned to 80 Hz; reports commonly skip two.
        result = receive(link, packet, t, seq=i * 2, reports=i * 2, x=32767)[1]
        assert result[0][0] == -1
        if i % 8 == 0:
            assert receive(link, packet, t + .001, seq=i * 2 + 1,
                           reports=i * 2 + 1, kind='status')[1][0][0] == -1
    t += .02
    receive(link, packet, t, seq=1000, kind='status', reports=9999)
    assert link.snapshot(t + .099)[0][0] == -1
    assert not link.snapshot(t + .101)[2]
    assert receive(link, packet, t + .11, seq=1001, x=32767)[1][0] == [0] * 8


def test_status_same_reports_and_timeout_during_grace(link, packet):
    arm(link, packet)
    receive(link, packet, .02, seq=3, reports=3, x=32767)
    receive(link, packet, .1, seq=4, reports=3, kind='status')
    assert link.pending_since is None
    receive(link, packet, .2, seq=5, reports=4, kind='status')
    link.timeout = .05
    assert link.snapshot(.251)[3][1] == 'message timeout'


def test_hid_stale_and_home_unknown(link, packet):
    # Unknown raw with a held GUIDE cannot arm or count as a released HOME.
    assert not receive(link, packet, 0, buttons=HOME, raw='ff' * 20)[1][2]
    receive(link, packet, .001, seq=2)
    receive(link, packet, .002, seq=3, buttons=HOME)
    assert receive(link, packet, .003, seq=4)[1][2]
    receive(link, packet, .02, seq=10, protocol='hid', raw='01808080800800000000')
    assert receive(link, packet, .03, seq=11, protocol='hid',
                   raw='01808080800800000000')[1][2]
    for i in range(1, 5):
        receive(link, packet, .03 + i * .2, seq=11 + i, protocol='hid',
                kind='status', reports=11)
    link.timeout = 2
    assert link.snapshot(1.03)[3][1] == 'HID input stale'


def make_state():
    return LinkState(deadzone=.1, message_timeout_sec=.5, input_stale_sec=1.,
                     arm_button=10, stop_button=8, allow_rearm_after_stop=False)


def deliver(state, packet, now):
    return state.accept(packet, bytes.fromhex(packet['raw']), now)


def test_reports_grace_and_timeout_independence(packet):
    state = make_state()
    deliver(state, packet(seq=0), -.01)
    deliver(state, packet(seq=1, buttons=0x400), 0)
    deliver(state, packet(seq=2), .01)
    deliver(state, packet(seq=3, x=20000, reports=3), .02)
    deliver(state, packet(seq=4, kind='status', reports=3), .03)
    assert state.snapshot(.03)[0][0] != 0
    deliver(state, packet(seq=5, kind='status', reports=5), .04)
    assert state.snapshot(.139)[0][0] != 0
    deliver(state, packet(seq=6, x=20000, reports=8), .139)
    assert state.snapshot(.14)[0][0] != 0
    deliver(state, packet(seq=7, kind='status', reports=9), .15)
    deliver(state, packet(seq=8, kind='status', reports=10), .20)
    assert not state.snapshot(.251)[2]
    assert not any(state.snapshot(.251)[0])
    # Continuous status must not extend a missing-input grace indefinitely.
    deliver(state, packet(seq=9, x=20000), .26)
    assert state.snapshot(.26)[2] and not any(state.snapshot(.26)[0])
    deliver(state, packet(seq=10), .27)
    deliver(state, packet(seq=11, x=20000), .28)
    deliver(state, packet(seq=12, kind='status', reports=12), .7)
    # Still expires for transport independently after the last status.
    assert not state.snapshot(1.2)[2]


def test_thinned_125hz_reports_never_inject_neutral(packet):
    state = make_state()
    deliver(state, packet(seq=0), -.01)
    deliver(state, packet(seq=1, buttons=0x400), 0)
    deliver(state, packet(seq=2), .01)
    seq = 2
    for i in range(1, 301):
        seq += 1
        now = .01 + i / 90
        reports = int(i * 125 / 90)
        # A status can describe the upcoming complete input before it is sent.
        if i % 9 == 0:
            deliver(state, packet(seq=seq, kind='status', reports=reports), now - .001)
            seq += 1
        deliver(state, packet(seq=seq, x=20000, reports=reports), now)
        axes, _, allowed, _ = state.snapshot(now)
        assert allowed and axes[0] != 0


def test_identity_change_requires_following_fresh_input(packet):
    state = make_state()
    deliver(state, packet(seq=0), -.01)
    deliver(state, packet(seq=1, buttons=HOME), 0)
    deliver(state, packet(seq=2), .01)
    deliver(state, packet(seq=3, x=20000), .02)
    deliver(state, packet(seq=4, pid='0001', x=20000), .03)
    assert not state.snapshot(.03)[2]
    deliver(state, packet(seq=5, pid='0001', x=20000), .04)
    assert state.snapshot(.04)[2] and not any(state.snapshot(.04)[0])
    deliver(state, packet(seq=6, pid='0001'), .05)
    deliver(state, packet(seq=7, pid='0001', x=20000), .06)
    assert state.snapshot(.06)[0][0] != 0


def test_first_input_from_replacement_device_blocks_then_requires_neutral(packet):
    state = make_state()
    deliver(state, packet(seq=0), -.01)
    deliver(state, packet(seq=1, buttons=HOME), 0)
    deliver(state, packet(seq=2), .01)
    deliver(state, packet(seq=3, x=16000), .02)
    deliver(state, packet(seq=4, x=16000, pid='0001'), .03)
    assert not state.snapshot(.03)[2]
    deliver(state, packet(seq=5, x=16000, pid='0001'), .04)
    assert state.snapshot(.04)[2] and not any(state.snapshot(.04)[0])
    deliver(state, packet(seq=6, pid='0001'), .05)
    deliver(state, packet(seq=7, x=16000, pid='0001'), .06)
    assert state.snapshot(.06)[0][0] != 0


def test_hid_fresh_input_and_exact_expiry(packet):
    state = make_state()
    deliver(state, packet(seq=0, protocol='hid', raw='01808080800800000000'), -.01)
    home = packet(seq=1, protocol='hid', raw='01808080800800010000')
    deliver(state, home, 0)
    neutral = packet(seq=2, protocol='hid', raw='01808080800800000000')
    deliver(state, neutral, .01)
    assert state.snapshot(.01)[2]
    for i in range(1, 5):
        deliver(state, packet(seq=2 + i, kind='status', protocol='hid', reports=2), i * .2)
    assert state.snapshot(1.009)[2]
    assert not state.snapshot(1.01)[2]
    assert state.reason == 'HID input stale'


def test_xinput_unchanged_status_ignores_input_stale(packet):
    state = make_state()
    deliver(state, packet(seq=0), -.01)
    deliver(state, packet(seq=1, buttons=HOME), 0)
    deliver(state, packet(seq=2), .01)
    for i in range(1, 16):
        deliver(state, packet(seq=i + 2, kind='status', reports=2), i * .2)
        assert state.snapshot(i * .2)[2]



def test_initial_held_home_never_arms_until_released(link, packet):
    for seq in (1, 2, 3):
        result = receive(link, packet, seq * .01, seq=seq, buttons=HOME)[1]
        assert result[3][0] == 'OFF' and not result[2]
        assert not any(result[0]) and not any(result[1])
    receive(link, packet, .04, seq=4)
    result = receive(link, packet, .05, seq=5, buttons=HOME)[1]
    assert result[3][0] == 'ON' and result[2]
    assert result[3][2]  # A valid rising edge still requires a fresh all-neutral.


@pytest.mark.parametrize('restart', [False, True])
def test_stopped_held_home_cannot_rearm_across_link_loss(link, packet, restart):
    link.rearm = True
    arm(link, packet)
    receive(link, packet, .02, seq=3, buttons=BACK | HOME)
    assert link.mode == 'STOPPED'
    receive(link, packet, .03, seq=4, buttons=HOME)
    assert link.mode == 'STOPPED'
    now = 3.1 if restart else .6
    assert not link.snapshot(now)[2]
    seq = 0 if restart else 5
    for offset in range(3):
        result = receive(link, packet, now + .01 * offset, seq=seq + offset,
                         buttons=HOME)[1]
        assert result[3][0] == 'STOPPED' and not result[2]
    receive(link, packet, now + .03, seq=seq + 3)
    assert receive(link, packet, now + .04, seq=seq + 4, buttons=HOME)[1][2]
