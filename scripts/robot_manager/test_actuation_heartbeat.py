"""Exercise permission changes through real pipes without ROS or hardware."""

from contextlib import contextmanager
import json
import os
import queue
import threading
import time

import pytest

from robot_manager import actuation_heartbeat as heartbeat

OFF = heartbeat.ALL_OFF
DRIVE = (True, False, True, False)
BOTH = (True, True, True, True)


def _line(state):
    return (json.dumps(dict(zip(('drive', 'launcher', 'lab_drive', 'lab_launcher'), state)))
            + '\n').encode()


class _PipeRun:
    def __init__(self, reader, parent_alive):
        self.messages = queue.Queue()
        self.published = []
        self.errors = []
        self.sent = None
        self.reader = reader
        self.parent_alive = parent_alive
        self.thread = threading.Thread(target=self.run, daemon=True)

    def publish(self, *state):
        self.published.append(state)
        self.messages.put(state)

    def run(self):
        try:
            self.sent = heartbeat.run(self.reader, self.publish, parent_alive=self.parent_alive)
        except BaseException as error:
            self.errors.append(error)

    def next_state(self):
        # A whole five seconds, rather than a narrow wall-clock window, for loaded CI runners.
        return self.messages.get(timeout=5)

    def next_change(self, previous):
        deadline = time.monotonic() + 5
        while True:
            remaining = deadline - time.monotonic()
            assert remaining > 0, 'permission did not change'
            state = self.messages.get(timeout=remaining)
            if state != previous:
                return state

    def finish(self):
        self.thread.join(timeout=5)
        assert not self.thread.is_alive(), 'heartbeat did not terminate'
        assert not self.errors, self.errors
        assert self.sent == len(self.published)
        assert self.published[-heartbeat.FINAL_OFF_COUNT:] == [OFF] * heartbeat.FINAL_OFF_COUNT


@contextmanager
def _pipe_run(parent_alive=lambda: True):
    read_fd, write_fd = os.pipe()
    # Use a buffered stream deliberately: the old loop strands its second line here.
    with os.fdopen(read_fd, 'r') as reader, os.fdopen(write_fd, 'wb', buffering=0) as writer:
        running = _PipeRun(reader, parent_alive)
        running.thread.start()
        try:
            assert running.next_state() == OFF
            yield running, writer
        finally:
            writer.close()
            running.finish()


@pytest.mark.parametrize('states', [(DRIVE, BOTH), (BOTH, OFF)],
                         ids=['drive-then-both', 'on-then-off'])
def test_queued_state_changes_are_all_published_without_another_write(states):
    with _pipe_run() as (running, writer):
        payload = b''.join(_line(state) for state in states)
        assert os.write(writer.fileno(), payload) == len(payload)
        previous = OFF
        for state in states:
            assert running.next_change(previous) == state
            previous = state
        # Check the next periodic heartbeat too, while the writer remains open and silent.
        assert running.next_state() == states[-1]


def test_three_queued_changes_preserve_order_and_the_latest_lease():
    states = (BOTH, OFF, DRIVE)
    with _pipe_run() as (running, writer):
        writer.write(b''.join(_line(state) for state in states))
        previous = OFF
        for state in states:
            assert running.next_change(previous) == state
            previous = state
        assert running.next_state() == DRIVE


def test_a_partial_line_waits_for_the_next_write_without_blocking_the_heartbeat():
    payload = _line(BOTH)
    with _pipe_run() as (running, writer):
        writer.write(payload[:20])
        assert running.next_state() == OFF  # an incomplete JSON line is not a change
        writer.write(payload[20:])
        assert running.next_change(OFF) == BOTH


def test_an_oversized_unterminated_line_revokes_and_discards_until_its_newline():
    with _pipe_run() as (running, writer):
        writer.write(_line(BOTH))
        assert running.next_change(OFF) == BOTH
        writer.write(b'x' * (heartbeat.MAX_LINE_BYTES + 1))
        assert running.next_change(BOTH) == OFF
        # Even a valid JSON suffix belongs to the bad line, not to a new permission.
        writer.write(_line(BOTH))
        assert running.next_state() == OFF
        writer.write(_line(DRIVE))
        assert running.next_change(OFF) == DRIVE


def test_an_oversized_complete_line_revokes_before_processing_the_next_line():
    # Reads can split the oversized line or receive its newline together with the tail;
    # either path must revoke before applying the following, separate permission line.
    with _pipe_run() as (running, writer):
        writer.write(_line(BOTH))
        assert running.next_change(OFF) == BOTH
        writer.write(b' ' * (heartbeat.MAX_LINE_BYTES + 1) + _line(BOTH) + _line(DRIVE))
        assert running.next_change(BOTH) == OFF
        assert running.next_change(OFF) == DRIVE


def test_an_empty_line_revokes_until_a_separate_valid_line_arrives():
    with _pipe_run() as (running, writer):
        writer.write(_line(BOTH))
        assert running.next_change(OFF) == BOTH
        writer.write(b'\n')
        assert running.next_change(BOTH) == OFF
        assert running.next_state() == OFF
        writer.write(_line(DRIVE))
        assert running.next_change(OFF) == DRIVE


@pytest.mark.parametrize('trailing', [b'', b'{"drive": true'], ids=['clean', 'partial'])
def test_eof_drains_complete_lines_discards_a_partial_line_and_sends_final_offs(trailing):
    with _pipe_run() as (running, writer):
        writer.write(_line(DRIVE) + _line(BOTH) + trailing)
        writer.close()
        running.finish()
        before_final = running.published[:-heartbeat.FINAL_OFF_COUNT]
        assert DRIVE in before_final and before_final[-1] == BOTH
        assert OFF not in before_final[before_final.index(DRIVE):]


def test_parent_exit_with_the_pipe_open_ends_with_final_offs():
    alive = threading.Event()
    alive.set()
    with _pipe_run(parent_alive=alive.is_set) as (running, writer):
        writer.write(_line(BOTH))
        assert running.next_change(OFF) == BOTH
        alive.clear()
        running.finish()
        before_final = running.published[:-heartbeat.FINAL_OFF_COUNT]
        assert BOTH in before_final
        assert all(state == BOTH for state in before_final[before_final.index(BOTH):])
