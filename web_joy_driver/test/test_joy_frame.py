"""Unit tests for web_joy_driver.joy_frame (no ROS runtime required)."""

import math
import threading

import pytest

from web_joy_driver.joy_frame import (
    HOLD_ACTIVE,
    HOLD_RELEASED,
    HOLD_TIMEOUT,
    FrameError,
    JoyHold,
    apply_deadzone,
    is_neutral_frame,
    parse_frame,
)


def test_is_neutral_frame():
    assert is_neutral_frame({"type": "joy", "axes": [0, 0.0, -0.0], "buttons": [0, False]})
    assert is_neutral_frame({"type": "joy"})  # missing arrays count as zeros
    assert not is_neutral_frame({"type": "joy", "axes": [0.01], "buttons": []})
    assert not is_neutral_frame({"type": "joy", "axes": [], "buttons": [1]})
    assert not is_neutral_frame({"type": "joy", "axes": [], "buttons": [True]})
    assert not is_neutral_frame({"type": "joy", "axes": [float("nan")]})
    assert not is_neutral_frame({"type": "joy", "axes": ["0"]})
    assert not is_neutral_frame({"type": "stop"})
    assert not is_neutral_frame([0, 0])


def test_apply_deadzone_clamps_and_zeroes():
    assert apply_deadzone(2.0, 0.05) == 1.0
    assert apply_deadzone(-2.0, 0.05) == -1.0
    assert apply_deadzone(0.04, 0.05) == 0.0
    assert apply_deadzone(-0.04, 0.05) == 0.0
    assert apply_deadzone(0.5, 0.05) == 0.5


def test_parse_frame_pads_short_arrays():
    axes, buttons = parse_frame({"type": "joy", "axes": [0.5, -1.0], "buttons": [1]}, 8, 14)
    assert axes == [0.5, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    assert buttons == [1] + [0] * 13


def test_parse_frame_accepts_missing_arrays():
    axes, buttons = parse_frame({"type": "joy"}, 8, 14)
    assert axes == [0.0] * 8
    assert buttons == [0] * 14


def test_parse_frame_applies_deadzone_and_clamp():
    axes, _ = parse_frame({"type": "joy", "axes": [0.02, 3.0, -3.0]}, 8, 14, deadzone=0.05)
    assert axes[:3] == [0.0, 1.0, -1.0]


def test_parse_frame_button_forms():
    _, buttons = parse_frame({"type": "joy", "buttons": [True, False, 1, 0, 1.0]}, 8, 14)
    assert buttons[:5] == [1, 0, 1, 0, 1]


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {"type": "nope"},
        {"type": "joy", "axes": "abc"},
        {"type": "joy", "axes": [0.0] * 9},
        {"type": "joy", "buttons": [0] * 15},
        {"type": "joy", "axes": ["x"]},
        {"type": "joy", "axes": [True]},
        {"type": "joy", "axes": [math.nan]},
        {"type": "joy", "axes": [math.inf]},
        {"type": "joy", "buttons": [2]},
        {"type": "joy", "buttons": ["1"]},
    ],
)
def test_parse_frame_rejects_malformed(payload):
    with pytest.raises(FrameError):
        parse_frame(payload, 8, 14)


def test_hold_released_by_default():
    hold = JoyHold(8, 14, 0.5)
    axes, buttons, state, *_ = hold.snapshot(10.0)
    assert state == HOLD_RELEASED
    assert axes == [0.0] * 8 and buttons == [0] * 14
    assert hold.snapshot(10.0).age_sec is None


def test_hold_active_then_timeout_then_release():
    hold = JoyHold(8, 14, 0.5)
    axes_in = [1.0] + [0.0] * 7
    buttons_in = [0] * 5 + [1] + [0] * 8
    hold.update(axes_in, buttons_in, now=1.0)

    axes, buttons, state, *_ = hold.snapshot(1.4)
    assert state == HOLD_ACTIVE
    assert axes == axes_in and buttons == buttons_in
    assert hold.snapshot(1.4).age_sec == pytest.approx(0.4)

    axes, buttons, state, *_ = hold.snapshot(1.6)
    assert state == HOLD_TIMEOUT
    assert axes == [0.0] * 8 and buttons == [0] * 14

    # Held input cannot recover until a valid neutral frame has arrived.
    assert not hold.update(axes_in, buttons_in, now=2.0).accepted
    assert hold.snapshot(2.0).stopped
    assert hold.accept({"type": "joy"}, 2.0).accepted
    assert hold.update(axes_in, buttons_in, now=2.1).accepted
    assert hold.snapshot(2.1)[2] == HOLD_ACTIVE

    hold.release()
    axes, buttons, state, *_ = hold.snapshot(2.1)
    assert state == HOLD_RELEASED
    assert axes == [0.0] * 8 and buttons == [0] * 14


@pytest.mark.parametrize("timeout", [0.0, -1.0])
def test_hold_timeout_disabled_when_non_positive(timeout):
    hold = JoyHold(8, 14, timeout)
    hold.update([0.3] * 8, [1] * 14, now=0.0)
    assert hold.snapshot(1000.0)[2] == HOLD_ACTIVE


def test_hold_snapshot_returns_copies():
    hold = JoyHold(8, 14, 0.5)
    hold.update([0.3] * 8, [1] * 14, now=0.0)
    axes, buttons, *_ = hold.snapshot(0.0)
    axes[0] = 9.0
    buttons[0] = 9
    assert hold.snapshot(0.0)[0][0] == 0.3
    assert hold.snapshot(0.0)[1][0] == 1


def test_hold_update_rejects_size_mismatch():
    hold = JoyHold(8, 14, 0.5)
    with pytest.raises(FrameError):
        hold.update([0.0] * 7, [0] * 14, now=0.0)


@pytest.mark.parametrize("age, stopped", [(0.499, False), (0.5, False), (0.501, True)])
def test_hold_timeout_boundary(age, stopped):
    hold = JoyHold()
    hold.accept({"type": "joy", "axes": [1]}, 0.0)
    assert hold.snapshot(age).stopped is stopped


def test_accept_detects_gap_without_a_timer_and_repeats():
    hold = JoyHold()
    held = {"type": "joy", "axes": [1], "buttons": [1]}
    neutral = {"type": "joy"}
    hold.accept(held, 0.0)
    for start in [1.0, 2.0, 3.0]:
        result = hold.accept(held, start)
        assert not result.accepted and result.changed
        snap = hold.snapshot(start)
        assert snap.stopped and snap.stop_reason == "timeout"
        assert snap.age_sec >= 0.5
        assert snap.axes == [0.0] * 8 and snap.buttons == [0] * 14
        assert not hold.accept(held, start + 0.01).changed
        assert hold.accept(neutral, start + 0.02).accepted
        assert hold.accept(held, start + 0.03).accepted


@pytest.mark.parametrize("timeout", [0.5, 0, -1])
@pytest.mark.parametrize("reason", ["released", "owner_change", "stop"])
def test_explicit_latch_requires_every_axis_and_button_neutral(timeout, reason):
    hold = JoyHold(timeout_sec=timeout, deadzone=0.05)
    hold.release(reason)
    for axis in range(8):
        payload = {"type": "joy", "axes": [0] * 8}
        payload["axes"][axis] = 0.01  # even inside the motion deadzone
        assert not hold.accept(payload, 0).accepted
    for button in range(14):
        for pressed in [1, True]:
            payload = {"type": "joy", "buttons": [0] * 14}
            payload["buttons"][button] = pressed
            assert not hold.accept(payload, 0).accepted
    assert hold.snapshot(100).stop_reason == reason
    assert hold.accept({"type": "joy", "buttons": [False]}, 100).accepted
    assert not hold.snapshot(100).stopped
    assert hold.accept({"type": "joy", "axes": [1]}, 100).accepted


@pytest.mark.parametrize("payload", [
    {"type": "joy", "axes": [0] * 9},
    {"type": "joy", "buttons": [0] * 15},
    {"type": "joy", "axes": [math.nan]},
    {"type": "joy", "axes": [math.inf]},
    {"type": "joy", "axes": [10 ** 400]},
    {"type": "joy", "axes": [False]},
    {"type": "joy", "buttons": ["0"]},
])
def test_invalid_neutral_never_clears_latch(payload):
    hold = JoyHold()
    hold.release()
    with pytest.raises(FrameError):
        hold.accept(payload, 1)
    assert hold.snapshot(1).stopped
    assert hold.snapshot(1).age_sec is None


def test_failed_parse_keeps_timeout_detected_in_accept():
    hold = JoyHold()
    hold.accept({"type": "joy", "axes": [1]}, 0)
    with pytest.raises(FrameError):
        hold.accept({"type": "joy", "axes": [0] * 9}, 0.6)
    assert hold.snapshot(0.6).stop_reason == "timeout"
    assert hold.snapshot(0.6).age_sec == 0.6
    hold.release("stop")
    assert hold.snapshot(1).stop_reason == "stop"
    hold.release("owner_change")
    assert hold.snapshot(1).stopped


def test_clock_is_read_under_lock_and_expiry_can_clear_in_same_accept():
    now = [0.0]
    def clock():
        assert hold._lock.locked()
        return now[0]

    hold = JoyHold(clock=clock)
    hold.accept({"type": "joy", "axes": [1]})
    now[0] = 0.6
    result = hold.accept({"type": "joy"})
    assert result.accepted and result.changed
    assert not hold.snapshot().stopped
    assert hold.snapshot().age_sec == 0


def test_concurrent_held_updates_and_snapshots_cannot_escape_latch():
    hold = JoyHold(timeout_sec=0)
    hold.release()
    start = threading.Barrier(2)
    errors = []

    def update():
        start.wait()
        for _ in range(500):
            if hold.update([1] * 8, [True] * 14).accepted:
                errors.append("accepted held input")

    def snapshot():
        start.wait()
        for _ in range(500):
            snap = hold.snapshot()
            if not snap.stopped or any(snap.axes) or any(snap.buttons):
                errors.append("non-neutral snapshot")

    threads = [threading.Thread(target=update), threading.Thread(target=snapshot)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=3)
        assert not thread.is_alive()
    assert not errors


def test_already_acquired_snapshot_is_not_recalled_by_release():
    hold = JoyHold()
    hold.accept({"type": "joy", "axes": [1]}, 0)
    old = hold.snapshot(0)
    hold.release()
    assert old.axes[0] == 1
    assert hold.snapshot(0).axes == [0] * 8
