"""Clock-injected controller state, freshness, sequence and neutral rearming."""
# Ported from the CoRE gamepad UDP bundle (sender uart32-tx-20261114 / receiver uart32-rx-20261114), provided by Scramble and used with the author's permission.

from .joy_map import map_joy, neutral
from .report import decode


def forward(next_seq, previous):
    """Compare wrapping uint32 sequences, rejecting duplicate/old values."""
    return 0 < (next_seq - previous) & 0xffffffff < 0x80000000


class LinkState:
    """Hold STOPPED independently of the transport session and sender restarts."""

    def __init__(self, *, deadzone, message_timeout_sec, input_stale_sec,
                 arm_button, stop_button, allow_rearm_after_stop):
        self.deadzone = deadzone
        self.timeout = message_timeout_sec
        self.input_stale = input_stale_sec
        self.arm = arm_button
        self.stop = stop_button
        self.rearm = allow_rearm_after_stop
        self.mode = 'OFF'
        self.seq = None
        self.last_packet = None
        self.last_input = None
        self.input_reports = None
        self.pending_since = None
        self.identity = None
        self.endpoint = None
        self.controls = None
        self.needs_neutral = True
        # Require a released HOME input before accepting its next rising edge.
        self.home_down = True
        self.reason = 'no input'

    def invalidate(self, reason):
        """Require a new decoded neutral without clearing STOPPED."""
        self.controls = None
        self.needs_neutral = True
        # Require a released HOME input before accepting its next rising edge.
        self.home_down = True
        self.pending_since = None
        self.reason = reason

    def tick(self, now):
        """Expire before accepting input, including exact timeout boundaries."""
        if self.last_packet is not None and now - self.last_packet >= 2.0:
            self.seq = None
            self.identity = None
            self.endpoint = None
            self.input_reports = None
        if self.last_packet is None or now - self.last_packet >= self.timeout:
            self.invalidate('message timeout')
        elif (self.identity and self.identity[0] == 'hid' and self.last_input is not None
              and now - self.last_input >= self.input_stale):
            self.invalidate('HID input stale')
        elif self.pending_since is not None and now - self.pending_since >= 0.1:
            self.invalidate('unobserved input')

    def accept(self, packet, raw, now):
        """Accept a validated newer packet; only fresh input can arm or release."""
        self.tick(now)
        if self.seq is not None and not forward(packet['seq'], self.seq):
            return False
        self.seq = packet['seq']
        self.last_packet = now
        identity = (packet['protocol'], packet['vid'].lower(), packet['pid'].lower(),
                    packet['addr'])
        changed = self.identity is not None and identity != self.identity
        if identity != self.identity:
            self.invalidate('connection changed')
            self.identity = identity
            self.endpoint = None
            self.input_reports = None
        if not packet['connected']:
            self.invalidate('disconnected')
            return True
        if packet['type'] == 'status':
            if (self.input_reports is not None and forward(packet['reports'], self.input_reports)
                    and self.pending_since is None and self.controls is not None):
                # A status can overtake queued input. Allow 100 ms without a neutral glitch;
                # repeated status does not extend the grace or replace the input report.
                self.pending_since = now
            return True
        if changed:
            # A new device's first frame cannot silently reuse the old permission.
            return True
        report = decode(raw, packet['protocol'])
        if report is None or (self.endpoint is not None and self.endpoint != packet['ep']):
            self.invalidate('unknown report')
            return True
        self.endpoint = packet['ep']
        self.last_input = now
        self.input_reports = packet['reports']
        self.pending_since = None
        self.reason = ''
        axes, buttons = map_joy(report, self.deadzone)
        home = bool(buttons[self.arm])
        rising = home and not self.home_down
        self.home_down = home
        if buttons[self.stop]:
            if self.mode == 'ON':
                self.mode = 'STOPPED'
            self.needs_neutral = True
        elif rising and (self.mode == 'OFF' or self.mode == 'STOPPED' and self.rearm):
            self.mode = 'ON'
            self.needs_neutral = True
        if not any(axes) and not any(buttons):
            self.needs_neutral = False
        self.controls = (axes, buttons)
        return True

    def snapshot(self, now):
        """Return safe Joy, the vote, and transition diagnostics."""
        self.tick(now)
        allowed = self.mode == 'ON' and self.controls is not None and not self.reason
        axes, buttons = self.controls if allowed and not self.needs_neutral else neutral()
        return axes[:], buttons[:], allowed, (self.mode, self.reason, self.needs_neutral)
