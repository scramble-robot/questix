"""Who may operate the disc launcher (roller, tilt, fire) from a QUESTiX LAB page, and when not.

ROS-free and clock-injected (``now`` in seconds, monotonic) like drive.py, so every rule is
unit-tested. The node feeds it the pages' requests, the ROS graph, ``/roller/status``,
``/shot/status`` and the emergency stop, and publishes what the calls return.

Rules, all enforced here and not in the page (the launcher nodes check again on their side:
``accept_lab_input``, E-stop, controller quiet time, clamps, fire interval):

* Off unless the bridge was started with ``allow_shoot``.
* Blocked (``blockers``) while
  - ``no_launcher``: nobody subscribes to the roller or fire topic, a status topic is silent
    for ``status_timeout_sec``, a status says ``lab_accepted: false`` (the node runs without
    ``accept_lab_input``: a competition launch) or the shot node is not ``active``;
  - ``emergency_stop``: ``/emergency_stop``, ``/drive_status`` or either status says so;
  - ``controller``: the controller uses the launcher (``/roller/status`` ``source: "joy"`` now
    or within ``controller_quiet_sec``, ``lab_locked`` outside an E-stop, ``/shot/status``
    ``lab_locked`` when present, or a controller shot within ``controller_quiet_sec``);
  - ``other_publisher``: another node publishes one of the lab topics.
  A blocker that appears during a session ends it: the controller always wins. A new blocker
  also publishes roller 0 for ``stop_hold_sec``, session or not.
* The ESC keeps the lab locked after a controller press or an E-stop until it hears a lab 0:
  once the controller and the E-stop have let go, :meth:`tick` publishes 0 for ``stop_hold_sec``
  (at most every ``rearm_retry_sec``) to re-arm it.
* The limits are the bridge's caps narrowed by what the nodes report (``lab_max_speed``,
  ``tilt_min_deg`` / ``tilt_max_deg``), never widened; ``next_fire_in_sec`` is the later of the
  bridge's own count and shot_component's.
* One page operates at a time (the owner, ``busy`` for the others). Its first accepted roller
  or tilt command starts a session. Any page may stop the roller (``roller_stop``).
* The owner repeats ``roller`` at least every ``deadman_sec`` (``power`` 0 keeps the session
  without spinning); silence, the owner leaving and a session longer than ``max_spin_sec`` end
  it. Ending a session publishes roller 0 for ``stop_hold_sec``, then nothing.
* Roller power is clamped to [0, ``max_power``]; tilt to [``tilt_min``, ``tilt_max``] degrees;
  a non-finite value is refused (``invalid``) and ends the owner's session.
* ``fire`` needs ``confirm: true`` (the pupil's safety tick), the owner, the roller commanded at
  ``min_fire_power`` or more for ``spin_up_sec`` without a break, no shot in progress, and
  ``fire_interval_sec`` since the last shot of any source (the controller's included).
  Refused requests are answered, never queued.
"""

import math

# Why the launcher cannot be operated right now, in the order the page shows them.
NOT_ALLOWED = 'not_allowed'
NO_LAUNCHER = 'no_launcher'
OTHER_PUBLISHER = 'other_publisher'
EMERGENCY_STOP = 'emergency_stop'
CONTROLLER = 'controller'
BLOCKER_ORDER = (NOT_ALLOWED, NO_LAUNCHER, OTHER_PUBLISHER, EMERGENCY_STOP, CONTROLLER)

# Refusals of a single request (besides the blockers).
BUSY = 'busy'  # another page owns the launcher
INVALID = 'invalid'  # not a finite number
NO_CONFIRM = 'no_confirm'  # fire without the pupil's safety tick
NOT_SPINNING = 'not_spinning'  # fire before the roller ran fast enough for long enough
INTERVAL = 'interval'  # fire sooner than fire_interval_sec after the last shot
SHOOTING = 'shooting'  # a shot is still moving

# Why the last session ended (besides the blockers, which end it with their own code).
STOPPED = 'stopped'
TIMEOUT = 'timeout'
TIME_LIMIT = 'time_limit'
DISCONNECTED = 'disconnected'

# Parts of the launcher, as named in blocker details.
ROLLER = 'roller'
SHOT = 'shot'


class ShootArbiter:

    def __init__(self, allowed, max_power=0.8, tilt_min=0.0, tilt_max=120.0,
                 fire_interval_sec=2.0, min_fire_power=0.2, spin_up_sec=1.0, deadman_sec=0.5,
                 max_spin_sec=30.0, stop_hold_sec=0.3, status_timeout_sec=1.0,
                 controller_quiet_sec=1.0, rearm_retry_sec=2.0):
        self.allowed = bool(allowed)
        # The bridge's own caps; the effective limits (max_power, tilt_min, tilt_max) are
        # narrowed further by what the nodes report (lab_max_speed, tilt_min_deg/tilt_max_deg),
        # never widened.
        self.max_power_cap = max(0.0, min(1.0, float(max_power)))
        low, high = float(tilt_min), float(tilt_max)
        self.tilt_cap = (min(low, high), max(low, high))
        self.max_power = self.max_power_cap
        self.tilt_min, self.tilt_max = self.tilt_cap
        self.rearm_retry_sec = float(rearm_retry_sec)
        self.fire_interval_sec = float(fire_interval_sec)
        self.min_fire_power = float(min_fire_power)
        self.spin_up_sec = float(spin_up_sec)
        self.deadman_sec = float(deadman_sec)
        self.max_spin_sec = float(max_spin_sec)
        self.stop_hold_sec = float(stop_hold_sec)
        self.status_timeout_sec = float(status_timeout_sec)
        self.controller_quiet_sec = float(controller_quiet_sec)
        self._blockers = {} if self.allowed else {NOT_ALLOWED: None}
        # Inputs behind the blockers, combined by _update_blockers.
        self._others = []
        self._subscribed = {ROLLER: False, SHOT: False}
        self._status = {ROLLER: None, SHOT: None}
        self._status_at = {ROLLER: -math.inf, SHOT: -math.inf}
        self._estop_topic = False
        self._joy_fired_at = -math.inf
        self._joy_roller_at = -math.inf  # /roller/status last said source "joy"
        self._node_fire_ready_at = -math.inf  # /shot/status next_fire_in_sec, as a time
        self._rearm_at = -math.inf  # next time a locked ESC may be re-armed with 0
        self._fired_count = None  # /shot/status fired_count last seen
        # The session.
        self.owner = None
        self.power = 0.0
        self.tilt = None  # last tilt sent by the lab [deg]
        self._heard_at = 0.0
        self._started_at = 0.0
        self._spinning_since = None  # power >= min_fire_power continuously since
        self._hold_until = -math.inf
        self._last_fire_at = -math.inf  # any source
        self._ready = False
        self.lab_fired = 0  # shots fired from the pages since the bridge started
        self.last_stop = None  # {'reason', 'by'} of the session that ended last
        self.version = 0  # bumped on every change the pages should hear about
        self._update_blockers(0.0)  # nothing heard yet: no_launcher

    @property
    def active(self):
        return self.owner is not None

    # --- what the robot says -----------------------------------------------------------------

    def set_graph(self, other_publishers, roller_subscribed, fire_subscribed, now):
        """Update the ROS graph: nodes other than the bridge on the lab topics."""
        self._others = sorted(set(other_publishers))
        self._subscribed = {ROLLER: bool(roller_subscribed), SHOT: bool(fire_subscribed)}
        self._update_blockers(now)

    def set_emergency_stop(self, active, now):
        """``/emergency_stop`` or ``/drive_status`` (the statuses carry their own ``estop``)."""
        self._estop_topic = bool(active)
        self._update_blockers(now)

    def set_roller_status(self, status, now):
        """Feed one ``/roller/status`` JSON object (Contract A); anything else is ignored."""
        if not isinstance(status, dict):
            return
        self._status[ROLLER] = status
        self._status_at[ROLLER] = now
        if status.get('source') == 'joy':
            self._joy_roller_at = now
        self._update_limits()
        self._update_blockers(now)

    def set_shot_status(self, status, now):
        """Feed one ``/shot/status`` JSON object; counts shots of any source for the interval."""
        if not isinstance(status, dict):
            return
        wait = _number(status.get('next_fire_in_sec'))
        if wait is not None and wait >= 0.0:
            self._node_fire_ready_at = now + wait
        count = status.get('fired_count')
        if isinstance(count, int) and not isinstance(count, bool):
            if self._fired_count is not None and count > self._fired_count:
                source = status.get('last_fire_source')
                # A lab shot already started the interval when it was sent (fire()).
                if source != 'lab' or now - self._last_fire_at >= self.fire_interval_sec:
                    self._last_fire_at = now
                if source == 'joy':
                    self._joy_fired_at = now
                self.version += 1
            self._fired_count = count
        self._status[SHOT] = status
        self._status_at[SHOT] = now
        self._update_limits()
        self._update_blockers(now)

    def _update_limits(self):
        """Narrow the caps to what the nodes report (never wider); bump version on a change."""
        power = self.max_power_cap
        speed = _number((self._status[ROLLER] or {}).get('lab_max_speed'))
        if speed is not None:
            power = max(0.0, min(power, speed))
        low, high = self.tilt_cap
        shot = self._status[SHOT] or {}
        node_low = _number(shot.get('tilt_min_deg'))
        node_high = _number(shot.get('tilt_max_deg'))
        if node_low is not None:
            low = max(low, node_low)
        if node_high is not None:
            high = min(high, node_high)
        high = max(low, high)  # disjoint ranges (a misconfiguration): one angle only
        if (power, low, high) != (self.max_power, self.tilt_min, self.tilt_max):
            self.max_power, self.tilt_min, self.tilt_max = power, low, high
            self.version += 1
            if self.power > power:
                self._set_power(power, self._heard_at)

    def _launcher_missing(self, now):
        missing = []
        for part in (ROLLER, SHOT):
            status = self._status[part]
            if (not self._subscribed[part] or status is None
                    or now - self._status_at[part] > self.status_timeout_sec
                    or status.get('lab_accepted') is not True
                    or (part == SHOT and status.get('active') is False)):
                missing.append(part)
        return missing

    def _fresh(self, part, now):
        return (self._status[part] is not None
                and now - self._status_at[part] <= self.status_timeout_sec)

    def _update_blockers(self, now):
        if not self.allowed:
            return
        missing = self._launcher_missing(now)
        estop = (['topic'] if self._estop_topic else []) + [
            part for part in (ROLLER, SHOT)
            if self._fresh(part, now) and self._status[part].get('estop') is True]
        controller = []
        roller = self._status[ROLLER]
        # The ESC keeps the lab locked after a controller press, and through an E-stop, until it
        # hears a lab 0 (tick() re-arms it); under an E-stop that is the E-stop's blocker.
        if self._fresh(ROLLER, now) and (
                roller.get('source') == 'joy'
                or now - self._joy_roller_at < self.controller_quiet_sec
                or (roller.get('lab_locked') is True and not estop)):
            controller.append(ROLLER)
        shot = self._status[SHOT]
        if (self._fresh(SHOT, now) and shot.get('lab_locked') is True) or (
                now - self._joy_fired_at < self.controller_quiet_sec):
            controller.append(SHOT)
        self._set_blocker(NO_LAUNCHER, missing or None, now)
        self._set_blocker(OTHER_PUBLISHER, self._others or None, now)
        self._set_blocker(EMERGENCY_STOP, estop or None, now)
        self._set_blocker(CONTROLLER, controller or None, now)

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
                # A new blocker: publish 0 briefly even without a session (the ESC then holds
                # the roller at the lab's 0, whatever came before).
                self._hold_until = max(self._hold_until, now + self.stop_hold_sec)

    def blockers(self):
        """``[(code, detail)]`` in display order."""
        return [(code, self._blockers[code]) for code in BLOCKER_ORDER if code in self._blockers]

    # --- what the pages ask for ---------------------------------------------------------------

    def _admit(self, client, now):
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
            self._started_at = now
            self.last_stop = None
            self.version += 1
        self._heard_at = now

    def roller(self, client, power, now):
        """Owner heartbeat and roller power; return None, or why it was refused.

        The node publishes whatever :meth:`tick` returns, so an accepted change reaches the
        roller within one tick.
        """
        refused = self._admit(client, now)
        if refused is not None:
            return refused
        power = _number(power)
        if power is None:
            if self.owner == client:
                self._end(INVALID, client, now)
            return INVALID
        self._begin(client, now)
        self._set_power(max(0.0, min(self.max_power, power)), now)
        return None

    def _set_power(self, power, now):
        if power != self.power:
            self.version += 1
        if power >= self.min_fire_power:
            if self._spinning_since is None:
                self._spinning_since = now
        else:
            self._spinning_since = None
        self.power = power

    def tilt_to(self, client, deg, now):
        """Return ``(None, degrees to publish)`` or ``(reason, None)``."""
        refused = self._admit(client, now)
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
        deg = max(self.tilt_min, min(self.tilt_max, deg))
        if deg != self.tilt:
            self.version += 1
        self.tilt = deg
        return None, deg

    def fire(self, client, confirm, now):
        """Return None when one disc may be fired now (the node publishes it), or why not."""
        refused = self._admit(client, now)
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
        """Seconds until the fire interval since the last shot (any source) has passed.

        The later of the bridge's own count and shot_component's ``next_fire_in_sec``.
        """
        return max(0.0, self._last_fire_at + self.fire_interval_sec - now,
                   self._node_fire_ready_at - now)

    def spin_ready_in(self, now):
        """Seconds until the roller has run fast enough long enough (inf when it is not)."""
        if self._spinning_since is None or not self.active:
            return math.inf
        return max(0.0, self._spinning_since + self.spin_up_sec - now)

    def ready_to_fire(self, now):
        return (self.active and not self._blockers and self.spin_ready_in(now) == 0.0
                and self.next_fire_in(now) == 0.0 and not self._shooting(now))

    def tick(self, now):
        """Return the roller power to publish now, or None to publish nothing.

        Also ends a silent or overlong session, re-evaluates blockers that depend on time
        (a status that went silent, the controller's quiet time) and notices ``ready_to_fire``
        changing.
        """
        self._update_blockers(now)
        if self.active:
            if now - self._heard_at > self.deadman_sec:
                self._end(TIMEOUT, None, now)
            elif now - self._started_at > self.max_spin_sec:
                self._end(TIME_LIMIT, None, now)
        elif self._needs_rearm(now) and now >= self._rearm_at:
            # The ESC stays locked after a controller press or an E-stop until the lab sends 0.
            self._hold_until = max(self._hold_until, now + self.stop_hold_sec)
            self._rearm_at = now + self.rearm_retry_sec
        ready = self.ready_to_fire(now)
        if ready != self._ready:
            self._ready = ready
            self.version += 1
        if self.active:
            return self.power
        if now < self._hold_until:
            return 0.0
        return None

    def _needs_rearm(self, now):
        """Tell whether the ESC reports lab_locked while the controller and E-stop have let go."""
        roller = self._status[ROLLER]
        return (self.allowed and self._fresh(ROLLER, now) and roller.get('lab_locked') is True
                and roller.get('source') != 'joy' and roller.get('lab_accepted') is True
                and self._subscribed[ROLLER] and EMERGENCY_STOP not in self._blockers)

    def _end(self, reason, by, now):
        self.owner = None
        self.power = 0.0
        self._spinning_since = None
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
            'max_power': self.max_power,
            'min_fire_power': self.min_fire_power,
            'spin_up_sec': self.spin_up_sec,
            'fire_interval_sec': self.fire_interval_sec,
            'tilt_min': self.tilt_min,
            'tilt_max': self.tilt_max,
            'deadman': self.deadman_sec,
            'seconds': self.max_spin_sec,
        }


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
