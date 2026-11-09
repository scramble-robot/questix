"""A page's driving run: who drives, for how long, and when the run must end.

ROS-free and clock-injected (``now`` in seconds, monotonic) so every rule is unit-tested.
The node feeds it the browser's requests, the ROS graph, the emergency stop, the motion
permission and command_arbiter's status, and publishes whatever :meth:`DriveSession.tick`
returns on ``/target_twist/lab``.

The bridge holds the session only (design/safety_permission_input_refactor.md, 4.5). What
reaches the drive is decided further down: command_arbiter's DriveArbiter (the teacher's lesson
permission ``/lab_permission``, QUESTiX LAB's speed caps, the controller always wins) and
drive_component itself (``/emergency_stop``, ``/motion_permission``). The bridge shows those
decisions to the pages and ends a run they refuse, never guesses them:

* One page drives at a time (the owner). Any page may stop it (the header stop control); a page
  ending its own run asks with ``only_own`` so it never ends another pupil's run.
* The owner repeats its command at least every ``deadman_sec``; silence stops the robot, so a
  closed laptop or a lost Wi-Fi link cannot leave it running. So does the owner disconnecting,
  and a run longer than ``max_run_sec``. A non-finite value is refused and ends the owner's run.
* Blockers (shown to the pages, and a blocker that appears ends the run): ``not_allowed`` (the
  arbiter reports the teacher's lesson permission off), ``no_drive_node`` (nothing subscribes to
  the drive topic, or the arbiter's status is missing: no arbiter), ``other_publisher`` (someone else publishes it), ``estop_unknown``
  (``/emergency_stop`` not heard yet: only ``set_estop_known`` clears it, a derived report never
  does), ``emergency_stop``, ``no_motion_permission`` (``/motion_permission`` does not allow the
  drive: the teacher's switch, or the robot's permission is missing).
* The arbiter's status ends a run it refused: the controller took over or locked the lab out. A
  status counts for a run only once it reports a lab command received after the run started
  (``lab_count``), so an earlier status never ends a new run.
* After a stop, zero is published for ``stop_hold_sec`` (the arbiter forwards it as the run's
  stop, and it ends the run there), then nothing: an idle bridge does not compete.
* A run the bridge ended (a blocker, the dead-man, the time limit, the arbiter, another page's
  stop) is not restarted by its owner's commands for ``RESTART_GUARD_SEC``: those were already on
  their way, and the page has given the run up. They are dropped without an answer (``STALE``).
"""

import math

# Why driving is not possible right now, in the order the page shows them.
NOT_ALLOWED = 'not_allowed'
NO_DRIVE_NODE = 'no_drive_node'
OTHER_PUBLISHER = 'other_publisher'
ESTOP_UNKNOWN = 'estop_unknown'  # /emergency_stop not observed yet
EMERGENCY_STOP = 'emergency_stop'
NO_MOTION_PERMISSION = 'no_motion_permission'  # /motion_permission does not allow the drive
BLOCKER_ORDER = (NOT_ALLOWED, ESTOP_UNKNOWN, EMERGENCY_STOP, NO_DRIVE_NODE, OTHER_PUBLISHER,
                 NO_MOTION_PERMISSION)

# Refusals of a single request (besides the blockers).
BUSY = 'busy'
INVALID = 'invalid'
# A command of a run the bridge has just ended: dropped without an answer to the page.
STALE = 'stale'
NEEDS_NEUTRAL = 'needs_neutral'
RESTART_GUARD_SEC = 1.0
STARTUP_NEUTRAL_SEC = 0.3  # repeated zeros, not a delivery guarantee or actuator acknowledgement

# Why the last run ended.
STOPPED = 'stopped'
TIMEOUT = 'timeout'
TIME_LIMIT = 'time_limit'
DISCONNECTED = 'disconnected'
CONTROLLER = 'controller'  # command_arbiter gave the robot to the controller (a hand on the stick)

# command_arbiter refusals that mean the controller has the robot.
_CONTROLLER_REFUSALS = ('controller', 'locked')


class DriveSession:

    def __init__(self, deadman_sec=0.5, max_run_sec=30.0, stop_hold_sec=0.3):
        self.deadman_sec = float(deadman_sec)
        self.max_run_sec = float(max_run_sec)
        self.stop_hold_sec = float(stop_hold_sec)
        # Fail closed: the E-stop is unknown until /emergency_stop has been observed.
        self._blockers = {NO_DRIVE_NODE: True, ESTOP_UNKNOWN: True}
        self._arbiter = None  # command_arbiter's latest drive status (a dict), or None
        self._drive_subscribed = False  # the graph shows a node on the drive topic
        self._count_at_start = 0
        self._seen_lab = False
        self.owner = None
        self.linear = 0.0
        self.angular = 0.0
        self._heard_at = 0.0
        self._started_at = 0.0
        self._hold_until = -math.inf
        self._guard = (None, -math.inf)  # (previous owner, until): see RESTART_GUARD_SEC
        self._needs_neutral = set()  # generated stop zeros and time passing cannot release clients
        self.last_stop = None  # {'reason', 'by'} of the run that ended last
        self.version = 0  # bumped on every change the pages should hear about

    @property
    def active(self):
        return self.owner is not None

    @property
    def allowed(self):
        """Whether the arbiter reports the teacher's lesson permission for driving."""
        return bool(self._arbiter and self._arbiter.get('lab_permitted') is True)

    def limits(self):
        """Return QUESTiX LAB's speed caps in effect (the arbiter's), or None before it reports."""
        status = self._arbiter or {}
        linear = _number(status.get('max_linear'))
        angular = _number(status.get('max_angular'))
        return None if linear is None or angular is None else (abs(linear), abs(angular))

    def blockers(self):
        """``[(code, detail)]`` in display order; detail lists node names for OTHER_PUBLISHER."""
        return [(code, self._blockers[code]) for code in BLOCKER_ORDER if code in self._blockers]

    def set_graph(self, other_publishers, drive_subscribers, now):
        """Update what the ROS graph says: node names other than the bridge itself."""
        others = sorted(set(other_publishers))
        self._set_blocker(OTHER_PUBLISHER, others if others else None, now)
        self._drive_subscribed = bool(drive_subscribers)
        self._set_drive_node(now)

    def _set_drive_node(self, now):
        # Fail closed: a run needs the arbiter on the topic and its status (whose permission and
        # refusals the run follows); either missing reads as no drive node.
        present = self._drive_subscribed and self._arbiter is not None
        self._set_blocker(NO_DRIVE_NODE, None if present else True, now)

    def set_emergency_stop(self, active, now):
        """Whether any source says the E-stop is pressed (authoritative or derived)."""
        self._set_blocker(EMERGENCY_STOP, True if active else None, now)

    def set_estop_known(self, known, now):
        """Whether the authoritative ``/emergency_stop`` has been observed (never a derived one)."""
        self._set_blocker(ESTOP_UNKNOWN, None if known else True, now)

    def set_motion_permission(self, allowed, now):
        """Whether a fresh ``/motion_permission`` allows the drive (never heard or stale: no)."""
        self._set_blocker(NO_MOTION_PERMISSION, None if allowed else True, now)

    def set_arbiter(self, status, now):
        """Feed command_arbiter's drive status (a dict of ArbiterStatus fields), None when gone."""
        before = (self.allowed, self.limits())
        self._arbiter = status if isinstance(status, dict) else None
        if (self.allowed, self.limits()) != before:
            self.version += 1
        # Not permitted is a blocker only once the arbiter says so: without an arbiter the page
        # is told no_drive_node, not that the teacher forbids it.
        self._set_blocker(
            NOT_ALLOWED, True if self._arbiter is not None and not self.allowed else None, now)
        self._set_drive_node(now)
        status = self._arbiter
        if not self.active or status is None:
            return
        count = status.get('lab_count')
        if not isinstance(count, int) or count <= self._count_at_start:
            return  # nothing of this run has reached the arbiter yet
        if status.get('active_source') == 'lab':
            self._seen_lab = True
        took_over = self._seen_lab and status.get('active_source') != 'lab' and (
            status.get('switch_reason') == 'controller')
        if status.get('lab_refusal') in _CONTROLLER_REFUSALS or took_over:
            self._end(CONTROLLER, None, now)

    def _set_blocker(self, code, detail, now):
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
        owner, until = self._guard
        if client is not None and client == owner and now < until:
            return STALE
        blockers = self.blockers()
        if blockers:
            self._needs_neutral.add(client)
            return blockers[0][0]
        if self.owner is not None and self.owner != client:
            return BUSY
        linear = _number(linear)
        angular = _number(angular)
        if linear is None or angular is None:
            if self.owner == client:
                self._end(INVALID, client, now)
            return INVALID
        if client in self._needs_neutral:
            if (linear, angular) != (0.0, 0.0):
                return NEEDS_NEUTRAL
            self._needs_neutral.discard(client)
        if self.owner is None:
            self.owner = client
            self._started_at = now
            self._count_at_start = (self._arbiter or {}).get('lab_count', 0)
            self._seen_lab = False
            self.last_stop = None
            self.version += 1
        if (linear, angular) != (self.linear, self.angular):
            self.version += 1
        self.linear, self.angular = linear, angular
        self._heard_at = now
        return None

    def stop(self, client, now, only_own=False):
        """Stop the run; return whether one ended.

        Any page may stop the robot, whoever drives it. With ``only_own`` the run ends only if
        ``client`` owns it: a page whose request was refused, or whose run already ended,
        must not stop the run another page has started since.
        """
        if only_own and self.owner != client:
            return False
        if self.active:
            self._end(STOPPED, client, now)
            return True
        return False

    def run_seconds(self, now):
        """Return how long the current run has lasted (0 when none runs)."""
        return now - self._started_at if self.active else 0.0

    def disconnect(self, client, now):
        if self.owner == client:
            self._end(DISCONNECTED, client, now)
        self._needs_neutral.discard(client)  # no unbounded retention of disconnected sessions

    def tick(self, now):
        """Return ``(linear, angular)`` to publish now, or None to publish nothing."""
        if self.active:
            if now - self._heard_at > self.deadman_sec:
                self._end(TIMEOUT, None, now)
            elif now - self._started_at > self.max_run_sec:
                self._end(TIME_LIMIT, None, now)
            else:
                if now - self._started_at < STARTUP_NEUTRAL_SEC:
                    return (0.0, 0.0)
                return (self.linear, self.angular)
        if now < self._hold_until:
            return (0.0, 0.0)
        return None

    def _end(self, reason, by, now):
        if self.owner is not None:
            self._needs_neutral.add(self.owner)
        if self.owner is not None and by != self.owner:
            # Not the owner's own stop: its commands still on their way must not restart it.
            self._guard = (self.owner, now + RESTART_GUARD_SEC)
        self.owner = None
        self.linear = self.angular = 0.0
        self._hold_until = now + self.stop_hold_sec
        self.last_stop = {'reason': reason, 'by': by}
        self.version += 1

    def state(self):
        """Return the ``drive_state`` payload body (see messages.drive_state_payload)."""
        limits = self.limits()
        return {
            'allowed': self.allowed,
            'blockers': [{'code': code, 'nodes': detail if isinstance(detail, list) else None}
                         for code, detail in self.blockers()],
            'owner': self.owner,
            'active': self.active,
            'linear': self.linear,
            'angular': self.angular,
            'limits': {
                'linear': limits[0] if limits else None,
                'angular': limits[1] if limits else None,
                'deadman': self.deadman_sec,
                'seconds': self.max_run_sec,
            },
            'last_stop': self.last_stop,
        }


def arbiter_status(msg):
    """Return the ArbiterStatus fields the bridge uses, as a dict (NaN limits become None)."""
    return {
        'mechanism': str(msg.mechanism),
        'active_source': str(msg.active_source),
        'switch_reason': str(msg.switch_reason),
        'lab_permitted': bool(msg.lab_permitted),
        'lab_locked': bool(msg.lab_locked),
        'lab_refusal': str(msg.lab_refusal),
        'lab_count': int(msg.lab_count),
        'max_linear': _number(msg.max_linear),
        'max_angular': _number(msg.max_angular),
        'max_power': _number(msg.max_power),
        'tilt_min_deg': _number(msg.tilt_min_deg),
        'tilt_max_deg': _number(msg.tilt_max_deg),
        'min_fire_power': _number(msg.min_fire_power),
        'spin_up_sec': _number(msg.spin_up_sec),
        'fire_interval_sec': _number(msg.fire_interval_sec),
        'next_fire_in_sec': _number(msg.next_fire_in_sec),
        'spin_ready_in_sec': _number(msg.spin_ready_in_sec),
    }


def _number(value):
    if isinstance(value, bool):
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None
