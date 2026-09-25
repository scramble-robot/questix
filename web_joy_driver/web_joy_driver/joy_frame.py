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
from typing import Any, List, Optional, Sequence, Tuple

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
    value = float(raw)
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


class JoyHold:
    """Thread-safe holder for the latest joy command with a staleness watchdog.

    ``update`` stores a fresh command, ``release`` drops back to neutral
    immediately (client disconnected) and ``snapshot`` returns what should be
    published *now*: the held command while it is younger than ``timeout_sec``,
    otherwise neutral. A non-positive ``timeout_sec`` disables the watchdog.
    """

    def __init__(
        self,
        num_axes: int = DEFAULT_NUM_AXES,
        num_buttons: int = DEFAULT_NUM_BUTTONS,
        timeout_sec: float = 0.5,
    ) -> None:
        """Create a neutral hold for the given array sizes."""
        self._num_axes = num_axes
        self._num_buttons = num_buttons
        self._timeout_sec = timeout_sec
        self._lock = threading.Lock()
        self._axes: List[float] = [0.0] * num_axes
        self._buttons: List[int] = [0] * num_buttons
        self._last_update: Optional[float] = None

    @property
    def timeout_sec(self) -> float:
        """Return the watchdog timeout in seconds (``<= 0`` disables it)."""
        return self._timeout_sec

    def neutral(self) -> Tuple[List[float], List[int]]:
        """Return an all-zero ``(axes, buttons)`` pair."""
        return [0.0] * self._num_axes, [0] * self._num_buttons

    def update(self, axes: Sequence[float], buttons: Sequence[int], now: float) -> None:
        """Store a validated command received at monotonic time ``now``."""
        if len(axes) != self._num_axes or len(buttons) != self._num_buttons:
            raise FrameError("array size mismatch")
        with self._lock:
            self._axes = list(axes)
            self._buttons = list(buttons)
            self._last_update = now

    def release(self) -> None:
        """Drop the held command; ``snapshot`` returns neutral from now on."""
        with self._lock:
            self._axes, self._buttons = self.neutral()
            self._last_update = None

    def age_sec(self, now: float) -> Optional[float]:
        """Return seconds since the last ``update`` or ``None`` when released."""
        with self._lock:
            if self._last_update is None:
                return None
            return max(0.0, now - self._last_update)

    def snapshot(self, now: float) -> Tuple[List[float], List[int], str]:
        """Return ``(axes, buttons, state)`` to publish at monotonic time ``now``."""
        with self._lock:
            if self._last_update is None:
                axes, buttons = self.neutral()
                return axes, buttons, HOLD_RELEASED
            if self._timeout_sec > 0.0 and now - self._last_update > self._timeout_sec:
                axes, buttons = self.neutral()
                return axes, buttons, HOLD_TIMEOUT
            return list(self._axes), list(self._buttons), HOLD_ACTIVE
