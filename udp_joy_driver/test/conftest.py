"""Synthetic packets: loopback only, no USB or hardware access."""

import struct

import pytest


@pytest.fixture
def packet():
    def make(seq=1, buttons=0, x=0, reports=None, kind='input', protocol='xinput', **changes):
        raw = bytearray(20)
        raw[1] = 20
        # On-wire XInput button fields, little-endian. Full state in every input.
        raw[2:4] = struct.pack('<H', buttons)
        raw[6:8] = struct.pack('<h', x)
        result = dict(v=3, type=kind, seq=seq, ms=seq, connected=True, protocol=protocol,
                      vid='045e', pid='028e', addr=1, ep=1 if kind == 'input' else 0,
                      raw=raw.hex() if kind == 'input' else '', reports=seq if reports is None
                      else reports, dropped=0, user_valid=False, user_age_ms=0xffffffff,
                      user_raw='00' * 32)
        result.update(changes)
        return result
    return make
