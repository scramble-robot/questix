# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.

"""Validate startup expectations and subsequent permission safety without ROS."""


class PermissionObservation:
    """Confirm the exact startup decision, then monitor mode and unsafe allowed pulses."""

    def __init__(self, expected):
        """Capture the unchanged expected decision and start an empty receive history."""
        self.expected = (expected[0], expected[1], list(expected[2]))
        self.history = []
        self.current = None
        self.reached_expected = False

    def receive(self, value):
        """Record and validate one sample before a later sample can overwrite it."""
        value = (value[0], value[1], list(value[2]))
        self.history.append(value)
        assert value[0] == self.expected[0], self.message('Unexpected mode')
        assert self.expected[1] or not value[1], self.message('Unexpected drive permission')
        if not self.reached_expected and value != self.expected:
            # Practice has no required votes: decideMotionPermission allows it from the
            # constructor's first publish. There is no legitimate startup refusal to ignore.
            # Lesson/competition may only wait for their own not-yet-received vote, never
            # accept an allowed pulse, stale vote, unrelated blocker or empty blocker list.
            unknown = [blocker.rsplit(':', 1)[0] + ':unknown'
                       for blocker in self.expected[2]]
            assert (not self.expected[1] and value == (self.expected[0], False, unknown)), \
                self.message('Unexpected permission during startup')
        # Once the exact startup decision is observed, the remaining graph/subscription
        # checks are not a heartbeat timing test. A referee's 1 s lease may expire on a
        # slow runner even after its initial OFF vote. Record later fail-closed decisions
        # without requiring identical blockers, but keep rejecting mode changes and any
        # allowed pulse in a mode whose expected decision refuses drive for the whole test.
        # Latch the observation so a later safe refusal cannot restart the startup wait.
        if value == self.expected:
            self.reached_expected = True
        self.current = value

    def matches(self):
        """Return whether the exact expectation has been observed at least once."""
        return self.reached_expected

    def require_match(self):
        """Fail with every received sample if the expectation was not reached in time."""
        assert self.matches(), self.message('Timed out waiting for permission')
        # Return the confirmed startup decision, not a subsequent fail-closed sample.
        return self.expected

    def message(self, reason):
        """Describe the expectation and the complete sequence for failure diagnostics."""
        return f'{reason}: expected {self.expected!r}; permission history: {self.history!r}'
