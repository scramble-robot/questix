"""A page's launcher session (roller, tilt, one disc at a time): who operates it, and for how long.

ROS-free and clock-injected (``now`` in seconds, monotonic) like drive.py, so every rule is
unit-tested. The node feeds it the pages' requests, the ROS graph, command_arbiter's launcher
status, ``/roller/status``, ``/shot/status``, the emergency stop and the motion permission, and
publishes what :meth:`ShootSession.tick` returns as a questix_msgs/LauncherCommand on
``/launcher_command/lab``.

The bridge holds the session only (design/safety_permission_input_refactor.md, 4.5). What reaches
the launcher is decided further down: command_arbiter's LauncherArbiter (the teacher's lesson
permission ``/lab_permission``, QUESTiX LAB's power and tilt caps, the roller spun up before a
shot, the interval between shots, the controller always wins) and the launcher nodes themselves
(``/emergency_stop``, ``/motion_permission``). The bridge shows those decisions to the pages, ends
a session they refuse and checks a request against them first so the page hears why at once:

* Blockers (shown to the pages; one that appears ends the session and publishes roller 0 for
  ``stop_hold_sec``): ``not_allowed`` (the arbiter reports the teacher's permission off),
  ``no_launcher`` (no arbiter on the topic or its status missing, a launcher status silent for
  ``status_timeout_sec``, or the shot node not ``active`` outside an E-stop), ``other_publisher``,
  ``estop_unknown`` (``/emergency_stop`` not heard yet; a status's ``estop: false`` never makes it known),
  ``emergency_stop`` (``/emergency_stop``, ``/drive_status`` or either status), ``no_motion_permission``
  (``/motion_permission`` does not allow the launcher), ``controller`` (the arbiter has locked the
  lab out: the controller took over).
* The arbiter's status also ends a session it refused (``controller``, ``locked``), counted only
  once it reports a lab command received after the session started (``lab_count``).
* One page operates at a time (the owner, ``busy`` for the others). Its first accepted roller or
  tilt command starts a session. Any page may stop the roller (``roller_stop``).
* The owner repeats ``roller`` at least every ``deadman_sec`` (``power`` 0 keeps the session
  without spinning); silence, the owner leaving and a session longer than ``max_spin_sec`` end
  it. Ending a session publishes roller 0 for ``stop_hold_sec``, then nothing.
* Roller power is clamped to [0, ``max_power``]; tilt to [``tilt_min``, ``tilt_max``] (the
  arbiter's caps narrowed by the shot node's range); a non-finite value is refused (``invalid``)
  and ends the owner's session.
* ``fire`` needs ``confirm: true`` (the pupil's safety tick), the owner, the roller commanded at
  ``min_fire_power`` or more for ``spin_up_sec`` without a break *and* ``/roller/status`` showing
  it turning for the lab at that power (counted from the later of the two), no shot in progress,
  and the intervals since the last shot (the arbiter's for the lab, the shot node's own). Refused
  requests are answered, never queued.
* A session the bridge ended (a blocker, the dead-man, the time limit, the arbiter, another page's
  stop) is not restarted by its owner's commands for ``RESTART_GUARD_SEC``: those were already on
  their way, and the page has given the session up. They are dropped without an answer
  (``STALE``); a page that wants the launcher again asks after that.
"""

import math

# Why the launcher cannot be operated right now, in the order the page shows them.
NOT_ALLOWED = 'not_allowed'
NO_LAUNCHER = 'no_launcher'
OTHER_PUBLISHER = 'other_publisher'
ESTOP_UNKNOWN = 'estop_unknown'  # /emergency_stop not observed yet
EMERGENCY_STOP = 'emergency_stop'
NO_MOTION_PERMISSION = 'no_motion_permission'  # /motion_permission does not allow the launcher
CONTROLLER = 'controller'
BLOCKER_ORDER = (NOT_ALLOWED, ESTOP_UNKNOWN, EMERGENCY_STOP, NO_LAUNCHER, OTHER_PUBLISHER,
                 NO_MOTION_PERMISSION, CONTROLLER)

# Refusals of a single request (besides the blockers).
BUSY = 'busy'  # another page owns the launcher
INVALID = 'invalid'  # not a finite number
NO_CONFIRM = 'no_confirm'  # fire without the pupil's safety tick
NOT_SPINNING = 'not_spinning'  # fire before the roller ran fast enough for long enough
INTERVAL = 'interval'  # fire sooner than the interval after the last shot
SHOOTING = 'shooting'  # a shot is still moving
# A command of a session the bridge has just ended: dropped without an answer to the page.
STALE = 'stale'
RESTART_GUARD_SEC = 1.0

# Why the last session ended (besides the blockers, which end it with their own code).
STOPPED = 'stopped'
TIMEOUT = 'timeout'
TIME_LIMIT = 'time_limit'
DISCONNECTED = 'disconnected'

# Parts of the launcher, as named in blocker details.
ROLLER = 'roller'
SHOT = 'shot'
ARBITER = 'arbiter'

# command_arbiter refusals that mean the controller has the launcher.
_CONTROLLER_REFUSALS = ('controller', 'locked')

# command_arbiter's packaged caps (config/command_arbiter.yaml): shown until its status arrives.
DEFAULT_LIMITS = {'max_power': 0.8, 'tilt_min': 0.0, 'tilt_max': 120.0, 'min_fire_power': 0.2,
                  'spin_up_sec': 1.0, 'fire_interval_sec': 2.0}


class ShootSession:

    def __init__(self, deadman_sec=0.5, max_spin_sec=30.0, stop_hold_sec=0.3,
                 status_timeout_sec=1.0):
        self.deadman_sec = float(deadman_sec)
        self.max_spin_sec = float(max_spin_sec)
        self.stop_hold_sec = float(stop_hold_sec)
        self.status_timeout_sec = float(status_timeout_sec)
        self._limits = dict(DEFAULT_LIMITS)
        # Inputs behind the blockers, combined by _update_blockers.
        self._others = []
        self._subscribed = False  # the arbiter subscribes to the lab's launcher topic
        self._arbiter = None  # command_arbiter's launcher status (a dict), or None
        self._arbiter_at = -math.inf
        self._status = {ROLLER: None, SHOT: None}
        self._status_at = {ROLLER: -math.inf, SHOT: -math.inf}
        self._estop_topic = False
        self._estop_known = False  # /emergency_stop observed (set_estop_known); fail closed
        self._motion = False  # /motion_permission allows the launcher (fresh)
        self._blockers = {}
        # The session.
        self.owner = None
        self.power = 0.0
        self.tilt = None  # the session's tilt target [deg], sent with every command
        self.fire_seq = 0  # this bridge's shot requests (each increase is one disc)
        self._heard_at = 0.0
        self._started_at = 0.0
        self._count_at_start = 0
        self._spinning_since = None  # power >= min_fire_power continuously since
        self._roller_confirmed_since = None  # /roller/status: turning for the lab since
        self._guard = (None, -math.inf)  # (previous owner, until): see RESTART_GUARD_SEC
        self._hold_until = -math.inf
        self._last_fire_at = -math.inf  # this bridge's last shot
        self._fire_ready_at = -math.inf  # the arbiter's and the shot node's interval, as a time
        self._ready = False
        self.lab_fired = 0  # shots asked for from the pages since the bridge started
        self.last_stop = None  # {'reason', 'by'} of the session that ended last
        self.version = 0  # bumped on every change the pages should hear about
        # A session: bumped whenever one starts, so work queued for it (a coalesced tilt) can
        # tell that its session is over even if the same page starts the next one.
        self.session = 0
        self._update_blockers(0.0)  # nothing heard yet: no_launcher, estop_unknown

    @property
    def active(self):
        return self.owner is not None

    @property
    def allowed(self):
        """Whether the arbiter reports the teacher's lesson permission for the launcher."""
        return bool(self._arbiter and self._arbiter.get('lab_permitted') is True)

    # --- what the robot says -----------------------------------------------------------------

    def set_graph(self, other_publishers, launcher_subscribed, now):
        """Update the ROS graph: other nodes on the lab's launcher topic, and its subscriber."""
        self._others = sorted(set(other_publishers))
        self._subscribed = bool(launcher_subscribed)
        self._update_blockers(now)

    def set_emergency_stop(self, active, now):
        """``/emergency_stop`` or ``/drive_status`` (the statuses carry their own ``estop``)."""
        self._estop_topic = bool(active)
        self._update_blockers(now)

    def set_estop_known(self, known, now):
        """Whether the authoritative ``/emergency_stop`` has been observed (never a derived one)."""
        self._estop_known = bool(known)
        self._update_blockers(now)

    def set_motion_permission(self, allowed, now):
        """Whether a fresh ``/motion_permission`` allows the launcher (never heard or stale: no)."""
        self._motion = bool(allowed)
        self._update_blockers(now)

    def set_arbiter(self, status, now):
        """Feed command_arbiter's launcher status (drive.arbiter_status fields), None when gone."""
        before = self.allowed
        self._arbiter = status if isinstance(status, dict) else None
        if self._arbiter is not None:
            self._arbiter_at = now
            wait = _number(self._arbiter.get('next_fire_in_sec'))
            if wait is not None and wait > 0.0:
                self._fire_ready_at = max(self._fire_ready_at, now + wait)
        if self.allowed != before:
            self.version += 1
        self._update_limits()
        self._update_blockers(now)
        status = self._arbiter
        if not self.active or status is None:
            return
        count = status.get('lab_count')
        if not isinstance(count, int) or count <= self._count_at_start:
            return  # nothing of this session has reached the arbiter yet
        if status.get('lab_refusal') in _CONTROLLER_REFUSALS:
            self._end(CONTROLLER, None, now)

    def session_token(self):
        """``(owner, session)`` of the running session, or None: what a queued command belongs to."""
        return (self.owner, self.session) if self.active else None

    def set_roller_status(self, status, now):
        """Feed one ``/roller/status`` JSON object; anything else is ignored."""
        if not isinstance(status, dict):
            return
        self._status[ROLLER] = status
        self._status_at[ROLLER] = now
        self._update_roller_confirmation(now)
        self._update_blockers(now)

    def _update_roller_confirmation(self, now):
        """Note when /roller/status starts showing the roller turning for the lab's session."""
        status = self._status[ROLLER] or {}
        command = _number(status.get('command'))
        turning = (self.active and self._spinning_since is not None
                   and status.get('source') == 'lab' and command is not None
                   and command >= self._limits['min_fire_power'])
        if not turning:
            self._roller_confirmed_since = None
        elif self._roller_confirmed_since is None:
            self._roller_confirmed_since = now
            self.version += 1

    def set_shot_status(self, status, now):
        """Feed one ``/shot/status`` JSON object (its range narrows the tilt, its interval waits)."""
        if not isinstance(status, dict):
            return
        wait = _number(status.get('next_fire_in_sec'))
        if wait is not None and wait > 0.0:
            self._fire_ready_at = max(self._fire_ready_at, now + wait)
        self._status[SHOT] = status
        self._status_at[SHOT] = now
        self._update_limits()
        self._update_blockers(now)

    def _update_limits(self):
        """Narrow the arbiter's caps by the shot node's tilt range; bump version on a change."""
        limits = dict(DEFAULT_LIMITS)
        status = self._arbiter or {}
        for key, field in (('max_power', 'max_power'), ('tilt_min', 'tilt_min_deg'),
                           ('tilt_max', 'tilt_max_deg'), ('min_fire_power', 'min_fire_power'),
                           ('spin_up_sec', 'spin_up_sec'),
                           ('fire_interval_sec', 'fire_interval_sec')):
            value = _number(status.get(field))
            if value is not None:
                limits[key] = value
        shot = self._status[SHOT] or {}
        node_low = _number(shot.get('tilt_min_deg'))
        node_high = _number(shot.get('tilt_max_deg'))
        if node_low is not None:
            limits['tilt_min'] = max(limits['tilt_min'], node_low)
        if node_high is not None:
            limits['tilt_max'] = min(limits['tilt_max'], node_high)
        limits['tilt_max'] = max(limits['tilt_min'], limits['tilt_max'])
        limits['max_power'] = max(0.0, min(1.0, limits['max_power']))
        if limits != self._limits:
            self._limits = limits
            self.version += 1
            if self.power > limits['max_power']:
                self._set_power(limits['max_power'], self._heard_at)

    def _fresh(self, part, now):
        return (self._status[part] is not None
                and now - self._status_at[part] <= self.status_timeout_sec)

    def _update_blockers(self, now):
        estop = (['topic'] if self._estop_topic else []) + [
            part for part in (ROLLER, SHOT)
            if self._fresh(part, now) and self._status[part].get('estop') is True]
        missing = [part for part in (ROLLER, SHOT) if not self._fresh(part, now)]
        # The E-stop releases the shot node's servo bus. A fresh inactive status then describes
        # the stop, not a missing launcher; stale statuses and missing ROS nodes still count.
        if (not estop and self._fresh(SHOT, now)
                and self._status[SHOT].get('active') is False):
            missing.append(SHOT)
        if not self._subscribed or self._arbiter is None:
            missing.insert(0, ARBITER)
        arbiter = self._arbiter
        locked = arbiter is not None and arbiter.get('lab_locked') is True
        self._set_blocker(NOT_ALLOWED, True if arbiter is not None and not self.allowed
                          else None, now)
        self._set_blocker(ESTOP_UNKNOWN, None if self._estop_known else True, now)
        self._set_blocker(EMERGENCY_STOP, estop or None, now)
        self._set_blocker(NO_LAUNCHER, missing or None, now)
        self._set_blocker(OTHER_PUBLISHER, self._others or None, now)
        self._set_blocker(NO_MOTION_PERMISSION, None if self._motion else True, now)
        self._set_blocker(CONTROLLER, [ARBITER] if locked else None, now)

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
            elif detail is not None and before is None:
                # A new blocker: publish 0 briefly even without a session.
                self._hold_until = max(self._hold_until, now + self.stop_hold_sec)

    def blockers(self):
        """``[(code, detail)]`` in display order."""
        return [(code, self._blockers[code]) for code in BLOCKER_ORDER if code in self._blockers]

    # --- what the pages ask for ---------------------------------------------------------------

    def _guarded(self, client, now):
        """Whether ``client``'s command belongs to a session the bridge has just ended."""
        owner, until = self._guard
        return client is not None and client == owner and now < until

    def _admit(self, client):
        """Return why ``client`` may not operate the launcher now, or None."""
        blockers = self.blockers()
        if blockers:
            return blockers[0][0]
        if self.owner is not None and self.owner != client:
            return BUSY
        return None

    def _begin(self, client, now):
        if self.owner is None:
            self.owner = client
            self.session += 1
            self._started_at = now
            self._count_at_start = (self._arbiter or {}).get('lab_count', 0)
            self.last_stop = None
            self.version += 1
        self._heard_at = now

    def roller(self, client, power, now):
        """Owner heartbeat and roller power; return None, or why it was refused.

        The node publishes whatever :meth:`tick` returns, so an accepted change reaches the
        roller within one tick.
        """
        if self._guarded(client, now):
            return STALE
        refused = self._admit(client)
        if refused is not None:
            return refused
        power = _number(power)
        if power is None:
            if self.owner == client:
                self._end(INVALID, client, now)
            return INVALID
        self._begin(client, now)
        self._set_power(max(0.0, min(self._limits['max_power'], power)), now)
        return None

    def _set_power(self, power, now):
        if power != self.power:
            self.version += 1
        if power >= self._limits['min_fire_power']:
            if self._spinning_since is None:
                self._spinning_since = now
        else:
            self._spinning_since = None
            self._roller_confirmed_since = None
        self.power = power

    def tilt_to(self, client, deg, now):
        """Return ``(None, degrees to send)`` or ``(reason, None)``."""
        if self._guarded(client, now):
            return STALE, None
        refused = self._admit(client)
        if refused is not None:
            return refused, None
        deg = _number(deg)
        if deg is None:
            if self.owner == client:
                self._end(INVALID, client, now)
            return INVALID, None
        if self._shooting(now):
            return SHOOTING, None
        self._begin(client, now)
        deg = max(self._limits['tilt_min'], min(self._limits['tilt_max'], deg))
        if deg != self.tilt:
            self.version += 1
        return None, deg

    def set_tilt(self, deg):
        """Set the tilt target the commands carry from now on (sent by the node, coalesced)."""
        self.tilt = deg

    def fire(self, client, confirm, now):
        """Return None when one disc is asked for now (the node publishes it), or why not."""
        if self._guarded(client, now):
            return STALE
        refused = self._admit(client)
        if refused is not None:
            return refused
        if confirm is not True:
            return NO_CONFIRM
        if self.owner != client or self.spin_ready_in(now) > 0.0:
            return NOT_SPINNING
        if self._shooting(now):
            return SHOOTING
        if self.next_fire_in(now) > 0.0:
            return INTERVAL
        self._heard_at = now
        self._last_fire_at = now
        self.fire_seq += 1
        self.lab_fired += 1
        self.version += 1
        return None

    def stop(self, client, now):
        """``roller_stop``: any page ends the session; return whether one ended."""
        if self.active:
            self._end(STOPPED, client, now)
            return True
        return False

    def disconnect(self, client, now):
        if self.owner == client:
            self._end(DISCONNECTED, client, now)
            return True
        return False

    # --- time -------------------------------------------------------------------------------

    def _shooting(self, now):
        return self._fresh(SHOT, now) and self._status[SHOT].get('shooting') is True

    def next_fire_in(self, now):
        """Seconds until the intervals since the last shot have passed (0 = now).

        The later of this bridge's own count (the arbiter's interval after a lab shot) and what
        the arbiter and the shot node last reported (any source's shot).
        """
        return max(0.0, self._last_fire_at + self._limits['fire_interval_sec'] - now,
                   self._fire_ready_at - now)

    def spin_ready_in(self, now):
        """Seconds until the roller has run fast enough long enough (inf when it is not asked to).

        Counted from the later of the command and ``/roller/status`` showing the roller turning
        for the lab; until the status shows it, the whole spin-up is still ahead.
        """
        if self._spinning_since is None or not self.active:
            return math.inf
        if self._roller_confirmed_since is None:
            return self._limits['spin_up_sec']
        since = max(self._spinning_since, self._roller_confirmed_since)
        return max(0.0, since + self._limits['spin_up_sec'] - now)

    def ready_to_fire(self, now):
        return (self.active and not self._blockers and self.spin_ready_in(now) == 0.0
                and self.next_fire_in(now) == 0.0 and not self._shooting(now))

    def tick(self, now, arbiter_timeout_sec=None):
        """Return the command to publish now, ``(power, tilt or None, fire_seq)``, or None.

        Also ends a silent or overlong session, forgets an arbiter status older than
        ``arbiter_timeout_sec``, re-evaluates blockers that depend on time (a status that went
        silent) and notices ``ready_to_fire`` changing.
        """
        if (arbiter_timeout_sec is not None and self._arbiter is not None
                and now - self._arbiter_at > arbiter_timeout_sec):
            self.set_arbiter(None, now)
        self._update_blockers(now)
        if self.active:
            if now - self._heard_at > self.deadman_sec:
                self._end(TIMEOUT, None, now)
            elif now - self._started_at > self.max_spin_sec:
                self._end(TIME_LIMIT, None, now)
        ready = self.ready_to_fire(now)
        if ready != self._ready:
            self._ready = ready
            self.version += 1
        if self.active:
            return self.command()
        if now < self._hold_until:
            return (0.0, None, self.fire_seq)
        return None

    def command(self):
        """``(power, tilt or None, fire_seq)`` of the running session."""
        return (self.power, self.tilt, self.fire_seq)

    def _end(self, reason, by, now):
        if self.owner is not None and by != self.owner:
            # Not the owner's own stop: its commands still on their way must not restart it.
            self._guard = (self.owner, now + RESTART_GUARD_SEC)
        self.owner = None
        self.power = 0.0
        self.tilt = None
        self._spinning_since = None
        self._roller_confirmed_since = None
        self._hold_until = now + self.stop_hold_sec
        self.last_stop = {'reason': reason, 'by': by}
        self._ready = False
        self.version += 1

    def session_seconds(self, now):
        return now - self._started_at if self.active else 0.0

    def state(self, now):
        """Return the ``shoot_state`` payload body (see messages.shoot_state_payload)."""
        spin = self.spin_ready_in(now)
        return {
            'allowed': self.allowed,
            'blockers': [{'code': code, 'nodes': detail if code == OTHER_PUBLISHER else None,
                          'parts': detail if isinstance(detail, list)
                          and code != OTHER_PUBLISHER else None}
                         for code, detail in self.blockers()],
            'owner': self.owner,
            'active': self.active,
            'roller': {
                'power': self.power,
                # How long the roller has run at min_fire_power or more (0 when it does not).
                'since_sec': _round(now - self._spinning_since)
                if self._spinning_since is not None and self.active else 0.0,
            },
            'tilt_deg': self.tilt,
            'ready_to_fire': self.ready_to_fire(now),
            'next_fire_in_sec': _round(self.next_fire_in(now)),
            'spin_ready_in_sec': None if math.isinf(spin) else _round(spin),
            'session_sec': _round(self.session_seconds(now)),
            'fired': self.lab_fired,
            'limits': self.limits(),
            'last_stop': self.last_stop,
        }

    def limits(self):
        return {
            'max_power': self._limits['max_power'],
            'min_fire_power': self._limits['min_fire_power'],
            'spin_up_sec': self._limits['spin_up_sec'],
            'fire_interval_sec': self._limits['fire_interval_sec'],
            'tilt_min': self._limits['tilt_min'],
            'tilt_max': self._limits['tilt_max'],
            'deadman': self.deadman_sec,
            'seconds': self.max_spin_sec,
        }


class TiltCoalescer:
    """Tilt targets at most every ``gap_sec`` (shot_component's rate limit), latest wins.

    A tilt asked for too soon is kept with the session token it was accepted for
    (:meth:`ShootSession.session_token`) and sent later only if that very session still runs and
    nothing blocks it: a tilt left over from a session that ended (the page left or stopped, a
    deadman or time limit, a blocker, 「すべて止める」, a new session in its place) is dropped, never
    sent. :meth:`drop` forgets it at once; the token check covers any path that does not call it.
    """

    def __init__(self, gap_sec):
        self.gap_sec = float(gap_sec)
        self._pending = None  # (degrees, token)
        self._sent_at = -math.inf

    @property
    def pending(self):
        return self._pending

    def request(self, deg, token, now):
        """Return ``deg`` to send now, or None when it is kept for :meth:`due`."""
        if token is None:
            self._pending = None
            return None
        if now - self._sent_at < self.gap_sec:
            self._pending = (deg, token)
            return None
        self._pending = None
        self._sent_at = now
        return deg

    def due(self, token, blocked, now):
        """Return the kept tilt to send now, or None (none, too soon, or void)."""
        if self._pending is None or now - self._sent_at < self.gap_sec:
            return None
        deg, pending_token = self._pending
        self._pending = None
        if token is None or pending_token != token or blocked:
            return None  # its session is over, another one runs, or something blocks it
        self._sent_at = now
        return deg

    def drop(self):
        """Forget the kept tilt (its session ended)."""
        self._pending = None


def _number(value):
    if isinstance(value, bool):
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _round(value):
    return round(value, 2)
