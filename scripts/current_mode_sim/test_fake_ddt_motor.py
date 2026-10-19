# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""Unit tests of the fake M0602C motor (no ROS, no pseudo terminal I/O)."""

import math
import os
from pathlib import Path
import random
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fake_ddt_motor as f  # noqa: E402


def frame(motor_id, kind, value=0):
    """Return a Protocol 1 command frame with a valid CRC."""
    high, low = f.int16_bytes(value)
    data = [motor_id, kind, high, low, 0, 0, 0, 0, 0]
    return bytes(data + [f.crc8_maxim(data)])


def test_crc_matches_the_spec_sheet_examples():
    assert f.crc8_maxim(bytes([4, 0x94, 0, 0, 0, 0, 0, 0, 0])) == 0x71
    assert f.crc8_maxim(bytes([5, 0x94, 0, 0, 0, 0, 0, 0, 0])) == 0xD5


def test_position_feedback_matches_shared_cpp_scale_and_native_direction():
    header = (Path(__file__).resolve().parents[2] / 'motor_control_lib' / 'include' /
              'motor_control_lib' / 'ddt_protocol.hpp').read_text()
    scale = int(re.search(r'kPositionRawPerTurn\s*=\s*(\d+)', header).group(1))
    motor = f.FakeMotor(4, f.PLANTS['lifted'])
    for turns in [0.0, 0.25, 0.999, 1.0, -0.25]:
        motor.position_turns = turns
        answer = motor.answer(0, random.Random(0))
        position = (answer[6] << 8) | answer[7]
        assert position == int((turns % 1.0) * scale)
        assert f.crc8_maxim(answer[:9]) == answer[9]
    for direction in [1, -1]:
        motor.position_turns = 0.0
        motor.speed_rpm = 0.0
        motor.velocity_target_rpm = direction * 10.0
        for _ in range(100):
            motor.step(0.001)
        assert motor.position_turns * direction > 0
        assert motor.speed_rpm * direction > 0


def test_lifted_wheel_settles_where_the_current_balances_friction():
    motor = f.FakeMotor(4, f.PLANTS['lifted'])
    motor.mode = f.MODE_CURRENT
    motor.current_amp = 0.3
    for _ in range(3000):
        motor.step(0.001)
    model = f.PLANTS['lifted']
    # 0.3 * (1 - w / no_load) = coulomb + viscous * w  (the drive's voltage limit near no load)
    expected = (0.3 - model.coulomb_amp) / (model.viscous_amp_per_rpm + 0.3 / f.NO_LOAD_RPM)
    assert abs(motor.speed_rpm - expected) < 0.02 * expected


def test_dry_friction_stops_without_reversing():
    motor = f.FakeMotor(4, f.PLANTS['floor6'])
    motor.mode = f.MODE_CURRENT
    motor.speed_rpm = 50.0
    for _ in range(5000):
        motor.step(0.001)
    assert motor.speed_rpm == 0.0


def test_no_load_speed_limits_a_held_current():
    motor = f.FakeMotor(4, f.PLANTS['lifted'])
    motor.mode = f.MODE_CURRENT
    motor.current_amp = 4.0
    for _ in range(5000):
        motor.step(0.001)
    assert motor.speed_rpm <= f.NO_LOAD_RPM


def make_bus(mode_frames):
    bus = f.FakeDdtBus(mode_frames=mode_frames)
    return bus


def test_spec_mode_frame_switches_and_the_answer_reports_it():
    bus = make_bus('spec')
    try:
        assert bus.handle_frame(bytes([4, 0xA0, 0, 0, 0, 0, 0, 0, 0, f.MODE_CURRENT])) == b''
        answer = bus.handle_frame(frame(4, 0x64, 410))
        assert len(answer) == 10 and answer[1] == f.MODE_CURRENT
        assert f.crc8_maxim(answer[:9]) == answer[9]
        assert abs(bus.motors[4].current_amp - 410 * f.AMP_PER_RAW) < 1e-9
    finally:
        bus.stop()


def test_legacy_mode_frame_is_ignored_by_a_spec_motor():
    bus = make_bus('spec')
    try:
        legacy = [4, 0xA0, 0, 0, 0, 0, 0, 0, f.MODE_CURRENT]
        bus.handle_frame(bytes(legacy + [f.crc8_maxim(legacy)]))
        assert bus.motors[4].mode == f.MODE_VELOCITY
        # A current command to a motor still in the velocity loop is read as a speed target.
        bus.handle_frame(frame(4, 0x64, 410))
        assert bus.motors[4].velocity_target_rpm == 410.0
    finally:
        bus.stop()


def test_legacy_firmware_takes_the_legacy_frame_only():
    bus = make_bus('legacy')
    try:
        bus.handle_frame(bytes([4, 0xA0, 0, 0, 0, 0, 0, 0, 0, f.MODE_CURRENT]))
        assert bus.motors[4].mode == f.MODE_VELOCITY
        legacy = [4, 0xA0, 0, 0, 0, 0, 0, 0, f.MODE_CURRENT]
        bus.handle_frame(bytes(legacy + [f.crc8_maxim(legacy)]))
        assert bus.motors[4].mode == f.MODE_CURRENT
    finally:
        bus.stop()


def test_dropped_answers_still_apply_the_command():
    bus = make_bus('spec')
    try:
        bus.handle_frame(bytes([5, 0xA0, 0, 0, 0, 0, 0, 0, 0, f.MODE_CURRENT]))
        bus.drop_answers = True
        assert bus.handle_frame(frame(5, 0x64, 100)) == b''
        assert bus.motors[5].current_amp > 0.0
    finally:
        bus.stop()


def test_bad_crc_is_ignored():
    bus = make_bus('spec')
    try:
        bad = bytearray(frame(4, 0x64, 100))
        bad[9] ^= 0xFF
        assert bus.handle_frame(bytes(bad)) == b''
        assert bus.motors[4].frames == 0
    finally:
        bus.stop()


def floor_bus():
    bus = f.FakeDdtBus(plant='floor6')
    for motor in bus.motors.values():
        motor.mode = f.MODE_CURRENT
    return bus


def run_body(bus, seconds):
    for _ in range(int(seconds / 0.0005)):
        bus._step_body(0.0005)


def test_equal_forward_currents_drive_the_robot_straight():
    bus = floor_bus()
    try:
        bus.motors[4].current_amp = 0.5   # left: forward is positive
        bus.motors[5].current_amp = -0.5  # right is mounted mirrored: forward is negative
        run_body(bus, 1.0)
        robot = bus.robot_snapshot()
        assert robot['v'] > 0.3 and abs(robot['w']) < 1e-9
        assert robot['x'] > 0.1 and abs(robot['y']) < 1e-9
        # the wheels follow the body (no slip), right one in its mirrored sign
        assert bus.motors[4].speed_rpm > 0 > bus.motors[5].speed_rpm
        assert abs(bus.motors[4].speed_rpm + bus.motors[5].speed_rpm) < 1e-6
    finally:
        bus.stop()


def test_left_back_right_forward_turns_counter_clockwise_in_place():
    bus = floor_bus()
    try:
        bus.motors[4].current_amp = -0.4
        bus.motors[5].current_amp = -0.4
        run_body(bus, 1.0)
        robot = bus.robot_snapshot()
        assert robot['w'] > 1.0 and abs(robot['v']) < 1e-9 and robot['theta'] > 0.5
    finally:
        bus.stop()


def test_friction_stops_a_coasting_robot():
    bus = floor_bus()
    try:
        bus.body.v = 0.5
        run_body(bus, 5.0)
        assert abs(bus.robot_snapshot()['v']) < 0.01
    finally:
        bus.stop()


def test_picking_up_stops_the_body_and_putting_down_takes_the_wheel_speeds():
    bus = floor_bus()
    try:
        bus.body.v = 0.4
        run_body(bus, 0.01)
        bus.set_plant('lifted')
        robot = bus.robot_snapshot()
        assert robot['lifted'] and robot['v'] == 0.0
        assert bus.motors[4].speed_rpm > 0  # the wheels keep spinning in the air
        bus.set_plant('floor6')
        assert abs(bus.robot_snapshot()['v'] - 0.4) < 0.05
    finally:
        bus.stop()


def test_reset_pose_keeps_the_speed():
    bus = floor_bus()
    try:
        bus.body.v = 0.3
        run_body(bus, 0.5)
        bus.reset_pose()
        robot = bus.robot_snapshot()
        assert robot['x'] == 0.0 and robot['distance'] == 0.0 and robot['v'] > 0.0
    finally:
        bus.stop()


# ---- Optional faults and the reported-speed lag (Issue #222, G2) ---------------------------------


class FakeClock:
    """A bus clock the test moves by hand."""

    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def speed_of(answer):
    """Return the reported speed (DATA[4..5]) of an answer frame."""
    return f.to_int16(answer[4], answer[5])


def position_of(answer):
    """Return the reported position (DATA[6..7]) of an answer frame."""
    return (answer[6] << 8) | answer[7]


def current_bus(**kwargs):
    bus = f.FakeDdtBus(noise_rpm=0.0, **kwargs)
    for motor_id in (4, 5):
        bus.handle_frame(bytes([motor_id, 0xA0, 0, 0, 0, 0, 0, 0, 0, f.MODE_CURRENT]))
    return bus


def test_by_default_the_reported_speed_is_the_wheel_speed():
    bus = current_bus()
    try:
        motor = bus.motors[4]
        motor.speed_rpm = 123.0
        motor.step(0.001)
        assert speed_of(bus.handle_frame(frame(4, 0x64, 0))) == round(motor.speed_rpm)
    finally:
        bus.stop()


def test_reported_speed_lags_by_the_dead_time_then_the_first_order_lag():
    motor = f.FakeMotor(4, f.PLANTS['lifted'], report_dead_time=0.04, report_tau=0.1)
    motor.mode = f.MODE_CURRENT
    for _ in range(100):  # at rest for 0.1 s
        motor.advance_report(0.001)
    motor.speed_rpm = 100.0  # a step of the physical speed (held by hand)
    for _ in range(39):
        motor.advance_report(0.001)
    assert motor.reported_rpm == 0.0  # still inside the dead time
    for _ in range(101):
        motor.advance_report(0.001)
    # 40 ms dead time + one time constant: about 1 - 1/e of the step
    assert abs(motor.reported_rpm - 100.0 * (1.0 - math.exp(-1.0))) < 2.0
    for _ in range(1000):
        motor.advance_report(0.001)
    assert abs(motor.reported_rpm - 100.0) < 0.1


def test_the_position_is_not_delayed():
    bus = current_bus(report_dead_time=0.04, report_tau=0.1)
    try:
        motor = bus.motors[4]
        motor.current_amp = 0.5
        for _ in range(300):
            motor.step(0.001)
        answer = bus.handle_frame(frame(4, 0x64, 0))
        expected = int((motor.position_turns % 1.0) * 32767) & 0xFFFF
        assert position_of(answer) == expected
        assert speed_of(answer) < motor.speed_rpm - 10.0  # the speed is behind
    finally:
        bus.stop()


def test_floor_body_also_lags_the_reported_speed():
    bus = f.FakeDdtBus(plant='floor6', noise_rpm=0.0, report_dead_time=0.04, report_tau=0.1)
    try:
        for motor in bus.motors.values():
            motor.mode = f.MODE_CURRENT
        bus.motors[4].current_amp = 0.8
        bus.motors[5].current_amp = -0.8
        run_body(bus, 0.2)
        assert 0.0 < bus.motors[4].reported_rpm < bus.motors[4].speed_rpm
    finally:
        bus.stop()


def test_one_silent_wheel_still_applies_commands_and_answers_again_later():
    clock = FakeClock()
    bus = current_bus(clock=clock)
    try:
        bus.silence(5, 0.5)
        assert bus.handle_frame(frame(5, 0x64, 410)) == b''
        assert abs(bus.motors[5].current_amp - 410 * f.AMP_PER_RAW) < 1e-9  # applied
        assert len(bus.handle_frame(frame(4, 0x64, 0))) == 10  # the other wheel answers
        clock.t += 0.5
        assert len(bus.handle_frame(frame(5, 0x64, 0))) == 10
    finally:
        bus.stop()


def test_a_deaf_wheel_keeps_its_last_current():
    clock = FakeClock()
    bus = current_bus(clock=clock)
    try:
        bus.handle_frame(frame(5, 0x64, 410))
        bus.silence(5, None, deaf=True)
        assert bus.handle_frame(frame(5, 0x64, 0)) == b''
        assert abs(bus.motors[5].current_amp - 410 * f.AMP_PER_RAW) < 1e-9  # the stop never came
        clock.t += 60.0
        assert bus.handle_frame(frame(5, 0x64, 0)) == b''  # until unsilence
        bus.unsilence(5)
        assert len(bus.handle_frame(frame(5, 0x64, 0))) == 10
        assert bus.motors[5].current_amp == 0.0
    finally:
        bus.stop()


def test_a_rebooted_motor_reads_currents_as_speed_targets():
    clock = FakeClock()
    bus = current_bus(clock=clock)
    try:
        bus.handle_frame(frame(4, 0x64, 410))
        bus.at(1.0, bus.reboot, 4)
        clock.t += 0.5
        assert bus.handle_frame(frame(4, 0x64, 410))[1] == f.MODE_CURRENT  # not yet
        clock.t += 0.5
        answer = bus.handle_frame(frame(4, 0x64, 1229))  # 0.3 A as a raw current
        assert answer[1] == f.MODE_VELOCITY
        assert bus.motors[4].velocity_target_rpm == 1229.0
        assert bus.motors[4].current_amp == 0.0
        assert bus.motors[4].reboots == 1
        assert bus.motors[5].mode == f.MODE_CURRENT  # only that motor
    finally:
        bus.stop()


def test_a_reboot_can_be_silent_while_booting():
    clock = FakeClock()
    bus = current_bus(clock=clock)
    try:
        bus.reboot(4, boot_silence=0.2)
        assert bus.handle_frame(frame(4, 0x64, 410)) == b''
        assert bus.motors[4].velocity_target_rpm == 0.0  # deaf while booting
        clock.t += 0.2
        assert bus.handle_frame(frame(4, 0x64, 0))[1] == f.MODE_VELOCITY
    finally:
        bus.stop()


def test_a_scheduled_load_change_puts_the_lifted_wheels_on_the_floor():
    clock = FakeClock()
    bus = current_bus(clock=clock)
    try:
        bus.at(0.3, bus.set_plant, 'floor6')
        bus.handle_frame(frame(4, 0x64, 0))
        assert bus.plant == 'lifted'
        clock.t += 0.3
        bus.handle_frame(frame(4, 0x64, 0))
        assert bus.plant == 'floor6' and not bus.robot_snapshot()['lifted']
    finally:
        bus.stop()


def test_the_frame_observer_sees_every_command():
    clock = FakeClock()
    bus = current_bus(clock=clock)
    seen = []
    try:
        bus.on_frame = lambda motor_id, mode, value, answered: seen.append(
            (motor_id, mode, value, answered))
        bus.handle_frame(frame(4, 0x64, 100))
        bus.silence(5, 1.0)
        bus.handle_frame(frame(5, 0x64, -100))
        bus.silence(5, 1.0, deaf=True)
        bus.handle_frame(frame(5, 0x64, 7))
        assert seen == [(4, f.MODE_CURRENT, 100, True), (5, f.MODE_CURRENT, -100, False),
                        (5, None, 7, False)]
    finally:
        bus.stop()
