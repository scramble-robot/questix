"""Pure-Python joy frame handling shared by the node and its unit tests.

A *frame* is one JSON object sent by the browser::

    {"type": "joy", "axes": [lx, ly, 0, rx, ry, 0, dh, dv], "buttons": [0, 1, ...]}

Axis/button indices follow the Switch2-native layout used by ``uart_joy_driver``.
The operator profile for this controller is
``questix_control_config/config/controls.web.yaml`` (``controller_type:=web``); the
shipped page sends only the sticks and L/R/ZL/ZR, so that profile tilts on buttons:

* buttons: A=0, B=1, X=2, Y=3, L=4, R=5, ZL=6, ZR=7, Minus=8, Plus=9, Home=10,
  Capture=11, LStick=12, RStick=13
* axes: LX=0, LY=1, RX=3, RY=4, D-pad H=6, D-pad V=7 (left/up = +1)

``parse_frame`` validates and normalizes a frame; ``JoyHold`` keeps the most
recent command and falls back to neutral when frames stop arriving.
"""

import math
import threading
import time
from typing import Any, Callable, List, NamedTuple, Optional, Sequence, Tuple

# Switch2-native array sizes (see uart_joy_driver/config/uart_joy_driver_params.yaml).
DEFAULT_NUM_AXES = 8
DEFAULT_NUM_BUTTONS = 14

HOLD_RELEASED = "released"  # no controller connected; neutral
HOLD_ACTIVE = "active"  # fresh frame available
HOLD_TIMEOUT = "timeout"  # controller connected but frames stopped; neutral


class FrameError(ValueError):
    """Raise when a client frame is malformed and must be ignored."""


def apply_deadzone(value: float, deadzone: float) -> float:
    """Clamp ``value`` to [-1, 1] and zero it when inside the dead zone."""
    value = max(-1.0, min(1.0, value))
    if abs(value) < deadzone:
        return 0.0
    return value


def _as_axis(raw: Any, index: int, deadzone: float) -> float:
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise FrameError(f"axes[{index}] is not a number")
    try:
        value = float(raw)
    except OverflowError as exc:
        raise FrameError(f"axes[{index}] is not finite") from exc
    if not math.isfinite(value):
        raise FrameError(f"axes[{index}] is not finite")
    return apply_deadzone(value, deadzone)


def _as_button(raw: Any, index: int) -> int:
    if isinstance(raw, bool):
        return int(raw)
    if isinstance(raw, int) and raw in (0, 1):
        return raw
    if isinstance(raw, float) and raw in (0.0, 1.0):
        return int(raw)
    raise FrameError(f"buttons[{index}] must be 0/1 or a boolean")


def parse_frame(
    payload: Any,
    num_axes: int = DEFAULT_NUM_AXES,
    num_buttons: int = DEFAULT_NUM_BUTTONS,
    deadzone: float = 0.0,
) -> Tuple[List[float], List[int]]:
    """Validate a decoded client frame and return ``(axes, buttons)``.

    Missing trailing entries are padded with zeros; longer arrays, non-numeric
    values, non-finite floats and unknown frame types raise ``FrameError``.
    """
    if not isinstance(payload, dict):
        raise FrameError("frame is not an object")
    if payload.get("type") != "joy":
        raise FrameError(f"unsupported frame type {payload.get('type')!r}")

    raw_axes = payload.get("axes", [])
    raw_buttons = payload.get("buttons", [])
    if not isinstance(raw_axes, list) or not isinstance(raw_buttons, list):
        raise FrameError("axes/buttons must be arrays")
    if len(raw_axes) > num_axes:
        raise FrameError(f"too many axes: {len(raw_axes)} > {num_axes}")
    if len(raw_buttons) > num_buttons:
        raise FrameError(f"too many buttons: {len(raw_buttons)} > {num_buttons}")

    axes = [_as_axis(v, i, deadzone) for i, v in enumerate(raw_axes)]
    axes.extend([0.0] * (num_axes - len(axes)))
    buttons = [_as_button(v, i) for i, v in enumerate(raw_buttons)]
    buttons.extend([0] * (num_buttons - len(buttons)))
    return axes, buttons


def is_neutral_frame(payload: Any) -> bool:
    """Return ``True`` when ``payload`` is a joy frame with every axis and button at zero.

    Used after a stop: the operator's page must let go of everything (it sends
    an all-zero frame) before its frames move the robot again. Anything that
    is not a well-formed all-zero joy frame counts as *not* neutral.
    """
    if not isinstance(payload, dict) or payload.get("type") != "joy":
        return False
    raw_axes = payload.get("axes", [])
    raw_buttons = payload.get("buttons", [])
    if not isinstance(raw_axes, list) or not isinstance(raw_buttons, list):
        return False
    for value in raw_axes + raw_buttons:
        if isinstance(value, bool):
            if value:
                return False
        elif not isinstance(value, (int, float)) or value != 0:
            return False
    return True


class AcceptResult(NamedTuple):
    """Report acceptance and whether a status refresh is needed."""

    accepted: bool
    changed: bool


class JoySnapshot(NamedTuple):
    """Copy one consistent input/output state while holding the input lock."""

    axes: List[float]
    buttons: List[int]
    state: str
    stopped: bool
    stop_reason: str
    age_sec: Optional[float]


class JoyHold:
    """Hold input until a gap, stop or release requires a valid neutral frame.

    The only latch lives here, under the same lock as validation and updates.
    A non-positive timeout disables only the watchdog, not explicit latches.
    Publishers use copied snapshots outside the lock; an already acquired
    snapshot cannot be recalled by a later stop.
    """

    def __init__(
        self,
        num_axes: int = DEFAULT_NUM_AXES,
        num_buttons: int = DEFAULT_NUM_BUTTONS,
        timeout_sec: float = 0.5,
        deadzone: float = 0.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Create a neutral holder; clock injection supports deterministic tests."""
        self._num_axes = num_axes
        self._num_buttons = num_buttons
        self._timeout_sec = timeout_sec
        self._deadzone = deadzone
        self._clock = clock
        self._lock = threading.Lock()
        self._axes: List[float] = [0.0] * num_axes
        self._buttons: List[int] = [0] * num_buttons
        self._last_update: Optional[float] = None
        self._stop_latched = False
        self._stop_reason = ""

    @property
    def timeout_sec(self) -> float:
        """Return the watchdog timeout (<= 0 disables only timeout detection)."""
        return self._timeout_sec

    def neutral(self) -> Tuple[List[float], List[int]]:
        """Return a new all-zero axes/buttons pair."""
        return [0.0] * self._num_axes, [0] * self._num_buttons

    def _expire_locked(self, now: float) -> bool:
        if (not self._stop_latched and self._last_update is not None
                and self._timeout_sec > 0.0
                and now - self._last_update > self._timeout_sec):
            self._stop_latched = True
            self._stop_reason = "timeout"
            self._axes, self._buttons = self.neutral()
            return True
        return False

    def accept(self, payload: Any, now: Optional[float] = None) -> AcceptResult:
        """Validate and accept input atomically, checking expiry before updating.

        Neutral means exact zero in the received frame, before deadzone.
        A parse failure preserves the latch, including expiry detected here.
        Explicit timestamps are for deterministic tests; production reads the
        monotonic clock after taking the lock.
        """
        with self._lock:
            now = self._clock() if now is None else now
            expired = self._expire_locked(now)
            axes, buttons = parse_frame(
                payload, self._num_axes, self._num_buttons, self._deadzone)
            if self._stop_latched and not is_neutral_frame(payload):
                return AcceptResult(False, expired)
            changed = expired or self._stop_latched
            self._axes, self._buttons = axes, buttons
            self._last_update = now
            self._stop_latched = False
            self._stop_reason = ""
            return AcceptResult(True, changed)

    def update(self, axes: Sequence[float], buttons: Sequence[int],
               now: Optional[float] = None) -> AcceptResult:
        """Accept an exactly sized frame through the same validation and latch."""
        if len(axes) != self._num_axes or len(buttons) != self._num_buttons:
            raise FrameError("array size mismatch")
        return self.accept({"type": "joy", "axes": list(axes), "buttons": list(buttons)}, now)

    def release(self, reason: str = "released") -> None:
        """Clear input and latch after disconnect, owner change or an explicit stop."""
        with self._lock:
            self._axes, self._buttons = self.neutral()
            self._last_update = None
            self._stop_latched = True
            self._stop_reason = reason

    def snapshot(self, now: Optional[float] = None) -> JoySnapshot:
        """Return a consistent copy, latching expiry before returning any values."""
        with self._lock:
            now = self._clock() if now is None else now
            self._expire_locked(now)
            age = None if self._last_update is None else max(0.0, now - self._last_update)
            state = HOLD_RELEASED if age is None else (
                HOLD_TIMEOUT if self._stop_latched else HOLD_ACTIVE)
            axes, buttons = self.neutral() if self._stop_latched else (
                list(self._axes), list(self._buttons))
            return JoySnapshot(axes, buttons, state, self._stop_latched, self._stop_reason, age)
