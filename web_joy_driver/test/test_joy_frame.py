"""Unit tests for web_joy_driver.joy_frame (no ROS runtime required)."""

import math

import pytest

from web_joy_driver.joy_frame import (
    HOLD_ACTIVE,
    HOLD_RELEASED,
    HOLD_TIMEOUT,
    FrameError,
    JoyHold,
    apply_deadzone,
    parse_frame,
)


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
    axes, buttons, state = hold.snapshot(10.0)
    assert state == HOLD_RELEASED
    assert axes == [0.0] * 8 and buttons == [0] * 14
    assert hold.age_sec(10.0) is None


def test_hold_active_then_timeout_then_release():
    hold = JoyHold(8, 14, 0.5)
    axes_in = [1.0] + [0.0] * 7
    buttons_in = [0] * 5 + [1] + [0] * 8
    hold.update(axes_in, buttons_in, now=1.0)

    axes, buttons, state = hold.snapshot(1.4)
    assert state == HOLD_ACTIVE
    assert axes == axes_in and buttons == buttons_in
    assert hold.age_sec(1.4) == pytest.approx(0.4)

    axes, buttons, state = hold.snapshot(1.6)
    assert state == HOLD_TIMEOUT
    assert axes == [0.0] * 8 and buttons == [0] * 14

    # A fresh frame recovers.
    hold.update(axes_in, buttons_in, now=2.0)
    assert hold.snapshot(2.1)[2] == HOLD_ACTIVE

    hold.release()
    axes, buttons, state = hold.snapshot(2.1)
    assert state == HOLD_RELEASED
    assert axes == [0.0] * 8 and buttons == [0] * 14


def test_hold_timeout_disabled_when_non_positive():
    hold = JoyHold(8, 14, 0.0)
    hold.update([0.3] * 8, [1] * 14, now=0.0)
    assert hold.snapshot(1000.0)[2] == HOLD_ACTIVE


def test_hold_snapshot_returns_copies():
    hold = JoyHold(8, 14, 0.5)
    hold.update([0.3] * 8, [1] * 14, now=0.0)
    axes, buttons, _ = hold.snapshot(0.0)
    axes[0] = 9.0
    buttons[0] = 9
    assert hold.snapshot(0.0)[0][0] == 0.3
    assert hold.snapshot(0.0)[1][0] == 1


def test_hold_update_rejects_size_mismatch():
    hold = JoyHold(8, 14, 0.5)
    with pytest.raises(FrameError):
        hold.update([0.0] * 7, [0] * 14, now=0.0)
