# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.

"""Validate every startup permission sample without depending on ROS."""


class PermissionObservation:
    """Wait for the exact expectation, allowing only its fail-closed unknown vote."""

    def __init__(self, expected):
        """Capture the unchanged expected decision and start an empty receive history."""
        self.expected = (expected[0], expected[1], list(expected[2]))
        self.history = []
        self.current = None

    def receive(self, value):
        """Record and validate one sample before a later sample can overwrite it."""
        value = (value[0], value[1], list(value[2]))
        self.history.append(value)
        assert value[0] == self.expected[0], self.message('Unexpected mode')
        if value != self.expected:
            # Practice has no required votes: decideMotionPermission allows it from the
            # constructor's first publish. There is no legitimate startup refusal to ignore.
            # Lesson/competition may only wait for their own not-yet-received vote, never
            # accept an allowed pulse, stale vote, unrelated blocker or empty blocker list.
            unknown = [blocker.rsplit(':', 1)[0] + ':unknown'
                       for blocker in self.expected[2]]
            assert (not self.expected[1] and value == (self.expected[0], False, unknown)), \
                self.message('Unexpected permission during startup')
        self.current = value

    def matches(self):
        """Return whether the latest validated sample exactly matches the expectation."""
        return self.current == self.expected

    def require_match(self):
        """Fail with every received sample if the expectation was not reached in time."""
        assert self.matches(), self.message('Timed out waiting for permission')
        return self.current

    def message(self, reason):
        """Describe the expectation and the complete sequence for failure diagnostics."""
        return f'{reason}: expected {self.expected!r}; permission history: {self.history!r}'
