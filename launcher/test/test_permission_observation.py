# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.

"""Exercise startup permission acceptance and immediate failure without ROS."""

from permission_observation import PermissionObservation
import pytest


COMPETITION = ('competition', False, ['referee:off'])
UNKNOWN = ('competition', False, ['referee:unknown'])


def test_unknown_then_expected_keeps_every_sample():
    """Allow repeated fail-closed startup samples before the exact expected value."""
    observation = PermissionObservation(COMPETITION)
    for value in [UNKNOWN, UNKNOWN]:
        observation.receive(value)
        assert not observation.matches()
    observation.receive(COMPETITION)
    assert observation.require_match() == COMPETITION
    assert observation.history == [UNKNOWN, UNKNOWN, COMPETITION]


@pytest.mark.parametrize('value', [
    ('competition', True, []),
    ('competition', True, ['referee:unknown']),
    ('lesson', False, ['teacher:unknown']),
    ('competition', False, ['teacher:unknown']),
    ('competition', False, ['referee:stale']),
    ('competition', False, []),
    ('competition', False, ['referee:unknown', 'referee:unknown']),
])
def test_invalid_sample_fails_before_a_later_expected_value(value):
    """Reject unsafe or unrelated samples at receipt, retaining the failing sample."""
    observation = PermissionObservation(COMPETITION)
    observation.receive(UNKNOWN)
    with pytest.raises(AssertionError, match='permission history') as failure:
        observation.receive(value)
    assert repr(value) in str(failure.value)
    assert observation.history == [UNKNOWN, value]


@pytest.mark.parametrize('history', [[], [UNKNOWN], [UNKNOWN, UNKNOWN]])
def test_unreached_expectation_fails_with_complete_history(history):
    """Fail at the wait's timeout rather than accepting the latest unknown sample."""
    observation = PermissionObservation(COMPETITION)
    for value in history:
        observation.receive(value)
    with pytest.raises(AssertionError, match='Timed out') as failure:
        observation.require_match()
    assert repr(history) in str(failure.value)
    assert repr(COMPETITION) in str(failure.value)


@pytest.mark.parametrize('expected', [
    COMPETITION, ('lesson', False, ['teacher:unknown']), ('practice', True, []),
])
def test_each_mode_accepts_its_unchanged_expectation(expected):
    """Keep all three modes' existing expected mode, flag and blockers unchanged."""
    observation = PermissionObservation(expected)
    observation.receive(expected)
    assert observation.require_match() == expected


@pytest.mark.parametrize('value', [
    ('practice', False, []), ('practice', False, ['teacher:unknown']),
    ('practice', True, ['teacher:unknown']),
])
def test_practice_has_no_valid_intermediate_refusal(value):
    """Practice needs no vote, so only its exact allowed decision is legitimate."""
    observation = PermissionObservation(('practice', True, []))
    with pytest.raises(AssertionError):
        observation.receive(value)


def test_received_blocker_lists_are_snapshots():
    """Keep history intact even if the caller reuses and mutates a blocker list."""
    blockers = ['referee:unknown']
    observation = PermissionObservation(COMPETITION)
    observation.receive(('competition', False, blockers))
    blockers[:] = ['referee:off']
    assert observation.history == [UNKNOWN]
    assert not observation.matches()


@pytest.mark.parametrize('value', [
    ('competition', False, ['referee:stale']),
    UNKNOWN,
    ('competition', False, ['teacher:unknown']),
    ('competition', False, []),
])
def test_after_expected_fail_closed_samples_are_recorded(value):
    """Keep startup confirmed when later graph waits receive another safe refusal."""
    observation = PermissionObservation(COMPETITION)
    observation.receive(COMPETITION)
    observation.receive(value)
    assert observation.history == [COMPETITION, value]
    assert observation.current == value
    assert observation.matches()
    assert observation.require_match() == COMPETITION


@pytest.mark.parametrize('value', [
    ('competition', True, []),
    ('competition', True, ['referee:stale']),
    ('lesson', False, ['teacher:unknown']),
])
def test_after_expected_unsafe_samples_still_fail_immediately(value):
    """Never ignore an allowed pulse or a changed mode after confirming startup."""
    observation = PermissionObservation(COMPETITION)
    observation.receive(COMPETITION)
    observation.receive(('competition', False, ['referee:stale']))
    with pytest.raises(AssertionError, match='permission history'):
        observation.receive(value)
    assert observation.history[-1] == value


def test_lesson_cannot_become_allowed_after_expected_unknown():
    """Apply the continuing fail-closed safety check to the teacher's mode too."""
    expected = ('lesson', False, ['teacher:unknown'])
    observation = PermissionObservation(expected)
    observation.receive(expected)
    with pytest.raises(AssertionError):
        observation.receive(('lesson', True, []))


def test_practice_records_later_refusal_without_changing_startup_expectation():
    """Once practice's exact allowed startup is confirmed, a refusal is safe to record."""
    expected = ('practice', True, [])
    observation = PermissionObservation(expected)
    observation.receive(expected)
    refusal = ('practice', False, ['teacher:unknown'])
    observation.receive(refusal)
    assert observation.history == [expected, refusal]
    assert observation.require_match() == expected
