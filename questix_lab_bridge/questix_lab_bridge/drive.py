"""Who may drive the robot from a QUESTiX LAB page, how fast, and when it must stop.

ROS-free and clock-injected (``now`` in seconds, monotonic) so every rule is unit-tested.
The node feeds it the browser's requests, the ROS graph and the emergency stop, and
publishes whatever :meth:`DriveArbiter.tick` returns.

Rules, all enforced here and not in the page:

* Off unless the bridge was started with ``allow_drive``.
* Refused while something else publishes the drive topic (the controller: two sources
  on ``/target_twist`` would alternate every tick), while no drive node subscribes to
  it, and while the emergency stop is active. A blocker that appears mid-run stops it.
* One page drives at a time (the owner). Any page may stop it.
* The owner repeats its command at least every ``deadman_sec``; silence stops the robot,
  so a closed laptop or a lost Wi-Fi link cannot leave it running. So does the owner
  disconnecting, and a run longer than ``max_run_sec``.
* Speeds are clamped to ``max_linear`` / ``max_angular``; a non-finite value stops.
* After a stop, zero is published for ``stop_hold_sec`` so the drive node sees an explicit
  stop, then nothing: an idle bridge does not compete with a controller started later.
"""

import math

# Why driving is not possible right now, in the order the page shows them.
NOT_ALLOWED = 'not_allowed'
NO_DRIVE_NODE = 'no_drive_node'
OTHER_PUBLISHER = 'other_publisher'
EMERGENCY_STOP = 'emergency_stop'
BLOCKER_ORDER = (NOT_ALLOWED, NO_DRIVE_NODE, OTHER_PUBLISHER, EMERGENCY_STOP)

# Refusals of a single request (besides the blockers).
BUSY = 'busy'
INVALID = 'invalid'

# Why the last run ended.
STOPPED = 'stopped'
TIMEOUT = 'timeout'
TIME_LIMIT = 'time_limit'
DISCONNECTED = 'disconnected'


class DriveArbiter:

    def __init__(self, allowed, max_linear, max_angular, deadman_sec=0.5, max_run_sec=30.0,
                 stop_hold_sec=0.3):
        self.allowed = bool(allowed)
        self.max_linear = abs(float(max_linear))
        self.max_angular = abs(float(max_angular))
        self.deadman_sec = float(deadman_sec)
        self.max_run_sec = float(max_run_sec)
        self.stop_hold_sec = float(stop_hold_sec)
        self._blockers = {} if self.allowed else {NOT_ALLOWED: None}
        self.owner = None
        self.linear = 0.0
        self.angular = 0.0
        self._heard_at = 0.0
        self._started_at = 0.0
        self._hold_until = -math.inf
        self.last_stop = None  # {'reason', 'by'} of the run that ended last
        self.version = 0  # bumped on every change the pages should hear about

    @property
    def active(self):
        return self.owner is not None

    def blockers(self):
        """``[(code, detail)]`` in display order; detail lists node names for OTHER_PUBLISHER."""
        return [(code, self._blockers[code]) for code in BLOCKER_ORDER if code in self._blockers]

    def set_graph(self, other_publishers, drive_subscribers, now):
        """Update what the ROS graph says: node names other than the bridge itself."""
        others = sorted(set(other_publishers))
        self._set_blocker(OTHER_PUBLISHER, others if others else None, now)
        self._set_blocker(NO_DRIVE_NODE, True if not drive_subscribers else None, now)

    def set_emergency_stop(self, active, now):
        self._set_blocker(EMERGENCY_STOP, True if active else None, now)

    def _set_blocker(self, code, detail, now):
        if not self.allowed:
            return
        before = self._blockers.get(code)
        if detail is None:
            self._blockers.pop(code, None)
        else:
            self._blockers[code] = detail
        if before != detail:
            self.version += 1
            if detail is not None and self.active:
                self._end(code, None, now)

    def request(self, client, linear, angular, now):
        """Let ``client`` drive at (linear, angular); return None, or why it was refused."""
        blockers = self.blockers()
        if blockers:
            return blockers[0][0]
        if self.owner is not None and self.owner != client:
            return BUSY
        try:
            linear = float(linear)
            angular = float(angular)
        except (TypeError, ValueError):
            linear = angular = math.nan
        if not (math.isfinite(linear) and math.isfinite(angular)):
            if self.owner == client:
                self._end(INVALID, client, now)
            return INVALID
        linear = max(-self.max_linear, min(self.max_linear, linear))
        angular = max(-self.max_angular, min(self.max_angular, angular))
        if self.owner is None:
            self.owner = client
            self._started_at = now
            self.last_stop = None
            self.version += 1
        if (linear, angular) != (self.linear, self.angular):
            self.version += 1
        self.linear, self.angular = linear, angular
        self._heard_at = now
        return None

    def stop(self, client, now):
        """Any page may stop the robot, whoever drives it."""
        if self.active:
            self._end(STOPPED, client, now)
            return True
        return False

    def disconnect(self, client, now):
        if self.owner == client:
            self._end(DISCONNECTED, client, now)

    def tick(self, now):
        """Return ``(linear, angular)`` to publish now, or None to publish nothing."""
        if self.active:
            if now - self._heard_at > self.deadman_sec:
                self._end(TIMEOUT, None, now)
            elif now - self._started_at > self.max_run_sec:
                self._end(TIME_LIMIT, None, now)
            else:
                return (self.linear, self.angular)
        if now < self._hold_until:
            return (0.0, 0.0)
        return None

    def _end(self, reason, by, now):
        self.owner = None
        self.linear = self.angular = 0.0
        self._hold_until = now + self.stop_hold_sec
        self.last_stop = {'reason': reason, 'by': by}
        self.version += 1

    def state(self):
        """Return the ``drive_state`` payload body (see messages.drive_state_payload)."""
        return {
            'allowed': self.allowed,
            'blockers': [{'code': code, 'nodes': detail if isinstance(detail, list) else None}
                         for code, detail in self.blockers()],
            'owner': self.owner,
            'active': self.active,
            'linear': self.linear,
            'angular': self.angular,
            'limits': {
                'linear': self.max_linear,
                'angular': self.max_angular,
                'deadman': self.deadman_sec,
                'seconds': self.max_run_sec,
            },
            'last_stop': self.last_stop,
        }
