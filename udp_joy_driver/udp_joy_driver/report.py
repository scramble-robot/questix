"""Decode the bundle's complete XInput-compatible and assumed PS4 reports."""
# Ported from the CoRE gamepad UDP bundle (sender uart32-tx-20261114 / receiver uart32-rx-20261114), provided by Scramble and used with the author's permission.

from dataclasses import dataclass
import struct


@dataclass(frozen=True)
class Report:
    """Byte axes and the bundle's PS4-compatible button positions."""

    axes: tuple
    buttons: int
    hat: int = 8
    dpad: int | None = None


def signed_le(data):
    """Read one signed little-endian XInput axis."""
    return struct.unpack('<h', data)[0]


def trunc_div(value, divisor):
    """Match C++ integer division towards zero, including negative axes."""
    return (1 if value >= 0 else -1) * (abs(value) // divisor)


def axis_byte(value, invert=False):
    """Preserve the bundle's byte quantization and exact center 128."""
    if invert:
        return 128 - trunc_div(value * (127 if value < 0 else 128),
                               32768 if value < 0 else 32767)
    return 128 + trunc_div(value * (128 if value < 0 else 127),
                           32768 if value < 0 else 32767)


def decode(raw, protocol):
    """Return a complete report, or None without reusing previous values."""
    if protocol == 'hid':
        if len(raw) < 10 or raw[0] != 1 or raw[5] & 15 > 8:
            return None
        return Report(tuple(raw[1:5]), (raw[5] >> 4) | (raw[6] << 4)
                      | ((raw[7] & 3) << 12), raw[5] & 15)
    if protocol != 'xinput' or not 14 <= len(raw) <= 32:
        return None
    for base in range(3):
        if len(raw) < base + 14:
            break
        data = raw[base:]
        if data[0] != 0 or not 14 <= data[1] <= 32:
            continue
        axes = tuple(axis_byte(signed_le(data[i:i + 2]), i in (8, 12))
                     for i in (6, 8, 10, 12))
        buttons = 0
        for bit, byte, mask in ((0, 3, 64), (1, 3, 16), (2, 3, 32), (3, 3, 128),
                                (4, 3, 1), (5, 3, 2), (8, 2, 32), (9, 2, 16),
                                (10, 2, 64), (11, 2, 128), (12, 3, 4)):
            if data[byte] & mask:
                buttons |= 1 << bit
        if data[4]:
            buttons |= 1 << 6
        if data[5]:
            buttons |= 1 << 7
        return Report(axes, buttons, dpad=data[2] & 15)
    return None
