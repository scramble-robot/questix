#!/usr/bin/env python3
# Copyright 2026 scramble-robot
#
# Use of this source code is governed by an MIT-style
# license that can be found in the LICENSE file or at
# https://opensource.org/licenses/MIT.
"""Fake DDT M0602C motors on a pseudo terminal, for running drive_component without hardware.

drive_component opens the pseudo terminal as its serial port. Each motor answers Protocol 1 frames
like the real driver (one request, one 10-byte answer, CRC-8/MAXIM) and moves a one-wheel model:

    J dω/dt = Kt * i - friction(ω)

Kt = 0.44 Nm/A and the no-load figures come from the M0602C spec sheet; the inertia and friction
of each load are estimates, not measurements. The physics runs in its own thread at about 1 kHz,
so the wheel keeps moving (and coasting) between frames, as a real one does.

Lifted, each wheel spins on its own. On the floor the two wheels drive one robot body (mass and
yaw inertia, rolling without slip, the right motor mounted mirrored), whose pose is integrated:

    (m + 2 Jw / r^2) dv/dt = (F_L + F_R)
    (Iz + 2 Jw (b/2)^2 / r^2) dω/dt = (F_R - F_L) b/2,    F = Kt (i - friction) / r

Current mode applies the commanded current. Velocity mode is an approximation of the firmware loop
(first order, 0.1 s); it exists so the default drive configuration also runs here, not to study it.
Like the unknown real behaviour, the last current is held when frames stop (worst case).

Mode frames (Protocol 3) follow the spec sheet by default: the mode value is DATA[9], no CRC.
`mode_frames='legacy'` takes the layout drive_component sent until 2026-10 instead (mode in DATA[8],
CRC in DATA[9]); `'never'` ignores both, as a motor that stays in its power-on velocity loop.
A motor that did not switch reads a current command as a speed target, as the real one would.
"""

import math
import os
import pty
import random
import threading
import time
import tty
from dataclasses import dataclass

KT_NM_PER_AMP = 0.44
RPM_PER_RAD_PER_SEC = 60.0 / (2.0 * math.pi)
AMP_PER_RAW = 8.0 / 32767.0
NO_LOAD_RPM = 480.0  # about 470 rpm at 25.6 V (spec sheet): the voltage limit of the drive
VELOCITY_MODE_TAU_SEC = 0.1
VELOCITY_MODE_AMP_PER_RPM = 0.02  # the approximate firmware loop on the floor (body) model
VELOCITY_MODE_MAX_AMP = 3.0
WHEEL_INERTIA = 4.7e-4  # [kg m^2] rotor + wheel, estimate

MODE_CURRENT = 0x01
MODE_VELOCITY = 0x02


def crc8_maxim(data):
    """Return the CRC-8/MAXIM of the bytes (polynomial 0x31 reflected, initial value 0)."""
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0x8C if crc & 1 else crc >> 1
    return crc


def to_int16(high, low):
    """Return the signed 16-bit value of a big-endian byte pair."""
    value = (high << 8) | low
    return value - 0x10000 if value & 0x8000 else value


def int16_bytes(value):
    """Return the big-endian byte pair of a signed 16-bit value (clamped)."""
    value = max(-32767, min(32767, int(value))) & 0xFFFF
    return (value >> 8) & 0xFF, value & 0xFF


@dataclass(frozen=True)
class WheelModel:
    """One wheel's load, as seen by its motor (and, on the floor, the robot it drives)."""

    label: str
    inertia: float  # [kg m^2] what the motor turns by itself (rotor + wheel)
    coulomb_amp: float  # [A] the current that balances the dry friction (per wheel)
    viscous_amp_per_rpm: float  # [A/rpm]
    lifted: bool
    mass: float = 0.0  # [kg] the robot (floor only)
    yaw_inertia: float = 0.0  # [kg m^2] the robot about its vertical axis (floor only)


def box_yaw_inertia(mass, length=0.4, width=0.5):
    """Return the yaw inertia of a uniform box (an estimate of the robot body)."""
    return mass * (length ** 2 + width ** 2) / 12.0


PLANTS = {
    'lifted': WheelModel('浮かせた車輪（標準）', WHEEL_INERTIA, 0.08, 3.6e-4, True),
    'lifted_light': WheelModel('浮かせた車輪（軽い）', 2.5e-4, 0.05, 3.0e-4, True),
    'lifted_heavy': WheelModel('浮かせた車輪（重い）', 9.0e-4, 0.08, 3.6e-4, True),
    'floor6': WheelModel('床の上 6 kg', WHEEL_INERTIA, 0.15, 3.6e-4, False, 6.0,
                         box_yaw_inertia(6.0)),
    'floor10': WheelModel('床の上 10 kg', WHEEL_INERTIA, 0.20, 3.6e-4, False, 10.0,
                          box_yaw_inertia(10.0)),
}


class RobotBody:
    """The robot on the floor: chassis speeds and pose (x forward, y left, θ counter-clockwise)."""

    def __init__(self):
        self.v = 0.0  # [m/s]
        self.w = 0.0  # [rad/s]
        self.x = 0.0  # [m]
        self.y = 0.0
        self.theta = 0.0  # [rad]
        self.distance = 0.0  # [m] path length


class FakeMotor:
    """State of one motor: firmware mode, command and the physics of its wheel."""

    def __init__(self, motor_id, model):
        self.motor_id = motor_id
        self.model = model
        self.mode = MODE_VELOCITY  # the driver's power-on default
        self.current_amp = 0.0  # the current the driver applies
        self.velocity_target_rpm = 0.0
        self.speed_rpm = 0.0  # physical speed, positive = the direction of a positive current
        self.position_turns = 0.0
        self.frames = 0

    def step(self, seconds):
        """Advance the wheel by the given time with the current command."""
        model = self.model
        if self.mode == MODE_VELOCITY:
            # Approximate firmware loop: first order towards the target.
            alpha = min(1.0, seconds / VELOCITY_MODE_TAU_SEC)
            accel = (self.velocity_target_rpm - self.speed_rpm) * alpha / max(seconds, 1e-9)
            gain = KT_NM_PER_AMP / model.inertia * RPM_PER_RAD_PER_SEC
            friction = model.viscous_amp_per_rpm * self.speed_rpm + math.copysign(
                model.coulomb_amp, self.speed_rpm) * (abs(self.speed_rpm) > 0.5)
            self.current_amp = accel / gain + friction
            self.speed_rpm += accel * seconds
        else:
            amp = self.current_amp
            # The drive cannot push current against the back EMF near the no-load speed.
            if amp * self.speed_rpm > 0.0:
                amp *= max(0.0, 1.0 - abs(self.speed_rpm) / NO_LOAD_RPM)
            gain = KT_NM_PER_AMP / model.inertia * RPM_PER_RAD_PER_SEC  # [rpm/s per A]
            if abs(self.speed_rpm) <= 0.5 and abs(amp) <= model.coulomb_amp:
                self.speed_rpm = 0.0  # held by dry friction
                return
            friction = model.viscous_amp_per_rpm * self.speed_rpm
            if abs(self.speed_rpm) > 0.5:
                friction += math.copysign(model.coulomb_amp, self.speed_rpm)
            else:
                friction += max(-model.coulomb_amp, min(model.coulomb_amp, amp))  # stiction
            new_speed = self.speed_rpm + seconds * gain * (amp - friction)
            # Dry friction stops a wheel; it never reverses it.
            if (self.speed_rpm > 0.0 > new_speed or self.speed_rpm < 0.0 < new_speed) and \
                    abs(amp) <= model.coulomb_amp:
                new_speed = 0.0
            self.speed_rpm = new_speed
        self.position_turns += self.speed_rpm / 60.0 * seconds

    def answer(self, noise_rpm, rng):
        """Return the Protocol 1 answer frame with the present state."""
        speed = round(self.speed_rpm + rng.uniform(-noise_rpm, noise_rpm))
        position = int((self.position_turns % 1.0) * 32767) & 0xFFFF
        current = self.current_amp / AMP_PER_RAW
        frame = [self.motor_id, self.mode, *int16_bytes(current), *int16_bytes(speed),
                 (position >> 8) & 0xFF, position & 0xFF, 0]
        frame.append(crc8_maxim(frame))
        return bytes(frame)


class FakeDdtBus:
    """Two (or more) fake motors on one pseudo terminal, like the RS-485 bus of the robot."""

    def __init__(self, motor_ids=(4, 5), plant='lifted', noise_rpm=1.0, link_path=None, seed=1,
                 mode_frames='spec', wheel_radius=0.05, wheel_separation=0.5):
        self._lock = threading.Lock()
        self.mode_frames = mode_frames
        self.left_id, self.right_id = motor_ids[0], motor_ids[1]
        self.wheel_radius = wheel_radius
        self.wheel_separation = wheel_separation
        self.body = RobotBody()
        self._rng = random.Random(seed)
        self.noise_rpm = noise_rpm
        self.drop_answers = False
        self.plant = plant
        self.motors = {motor_id: FakeMotor(motor_id, PLANTS[plant]) for motor_id in motor_ids}
        self._master, self._slave = pty.openpty()
        tty.setraw(self._master)
        self.device = os.ttyname(self._slave)
        self.link_path = link_path
        if link_path:
            if os.path.islink(link_path):
                os.unlink(link_path)
            os.symlink(self.device, link_path)
        self._running = False
        self._threads = []

    @property
    def port(self):
        """Return the path drive_component should open."""
        return self.link_path or self.device

    def start(self):
        """Start the serial and physics threads."""
        self._running = True
        for target in (self._serial_loop, self._physics_loop):
            thread = threading.Thread(target=target, daemon=True)
            thread.start()
            self._threads.append(thread)

    def stop(self):
        """Stop the threads and release the pseudo terminal."""
        self._running = False
        for fd in (self._master, self._slave):
            try:
                os.close(fd)
            except OSError:
                pass
        if self.link_path and os.path.islink(self.link_path):
            os.unlink(self.link_path)

    def set_plant(self, plant):
        """Change the load of the wheels.

        Lifting keeps the wheels spinning and stops the body; putting it down starts the body at
        the speed its wheels have.
        """
        with self._lock:
            was_lifted = PLANTS[self.plant].lifted
            self.plant = plant
            for motor in self.motors.values():
                motor.model = PLANTS[plant]
            if PLANTS[plant].lifted:
                self.body.v = self.body.w = 0.0
            elif was_lifted:
                v_left, v_right = self._wheel_speeds_mps()
                self.body.v = (v_left + v_right) / 2.0
                self.body.w = (v_right - v_left) / self.wheel_separation

    def reset_pose(self):
        """Put the robot back at the origin, facing +x (keeps its speed)."""
        with self._lock:
            self.body.x = self.body.y = self.body.theta = self.body.distance = 0.0

    def snapshot(self):
        """Return {motor_id: (speed_rpm, current_amp, mode)} of the physical state."""
        with self._lock:
            return {motor_id: (motor.speed_rpm, motor.current_amp, motor.mode)
                    for motor_id, motor in self.motors.items()}

    def robot_snapshot(self):
        """Return the body state (pose and chassis speeds) and whether it is lifted."""
        with self._lock:
            b = self.body
            return {'x': b.x, 'y': b.y, 'theta': b.theta, 'v': b.v, 'w': b.w,
                    'distance': b.distance, 'lifted': PLANTS[self.plant].lifted}

    def _rpm_per_mps(self):
        return 60.0 / (2.0 * math.pi * self.wheel_radius)

    def _wheel_speeds_mps(self):
        """Return (left, right) wheel ground speeds, forward positive (right motor mirrored)."""
        k = self._rpm_per_mps()
        return (self.motors[self.left_id].speed_rpm / k,
                -self.motors[self.right_id].speed_rpm / k)

    def _drive_amp(self, motor):
        """Return the current the drive puts into the winding (motor frame, voltage limited)."""
        if motor.mode == MODE_VELOCITY:
            amp = VELOCITY_MODE_AMP_PER_RPM * (motor.velocity_target_rpm - motor.speed_rpm)
            amp = max(-VELOCITY_MODE_MAX_AMP, min(VELOCITY_MODE_MAX_AMP, amp))
            motor.current_amp = amp
        else:
            amp = motor.current_amp
        if amp * motor.speed_rpm > 0.0:
            amp *= max(0.0, 1.0 - abs(motor.speed_rpm) / NO_LOAD_RPM)
        return amp

    def _step_body(self, seconds):
        """Advance the robot on the floor; the wheel speeds follow the body (no slip)."""
        model = PLANTS[self.plant]
        body, r, half = self.body, self.wheel_radius, self.wheel_separation / 2.0
        k = self._rpm_per_mps()
        left, right = self.motors[self.left_id], self.motors[self.right_id]
        rpm_left = (body.v - body.w * half) * k  # forward frame
        rpm_right = (body.v + body.w * half) * k
        left.speed_rpm, right.speed_rpm = rpm_left, -rpm_right

        def friction(rpm):  # smooth dry friction (no stick-slip chatter) + viscous, as amps
            return model.coulomb_amp * math.tanh(rpm / 0.5) + model.viscous_amp_per_rpm * rpm

        force_left = KT_NM_PER_AMP * (self._drive_amp(left) - friction(rpm_left)) / r
        force_right = KT_NM_PER_AMP * (-self._drive_amp(right) - friction(rpm_right)) / r
        mass = model.mass + 2.0 * model.inertia / r ** 2
        yaw = model.yaw_inertia + 2.0 * model.inertia * half ** 2 / r ** 2
        body.v += seconds * (force_left + force_right) / mass
        body.w += seconds * (force_right - force_left) * half / yaw
        body.theta = math.atan2(math.sin(body.theta + body.w * seconds),
                                math.cos(body.theta + body.w * seconds))
        body.x += body.v * math.cos(body.theta) * seconds
        body.y += body.v * math.sin(body.theta) * seconds
        body.distance += abs(body.v) * seconds
        for motor in (left, right):
            motor.position_turns += motor.speed_rpm / 60.0 * seconds

    def handle_frame(self, frame):
        """Apply one 10-byte frame and return the answer bytes (b'' when there is none)."""
        with self._lock:
            motor = self.motors.get(frame[0])
            if motor is None:
                return b''
            if frame[1] == 0xA0:  # Protocol 3: mode switch (no answer)
                mode = None
                if self.mode_frames == 'spec' and frame[9] in (MODE_CURRENT, MODE_VELOCITY):
                    mode = frame[9]  # spec sheet: DATA[9] is the mode value, no CRC
                elif (self.mode_frames == 'legacy' and crc8_maxim(frame[:9]) == frame[9]
                      and frame[8] in (MODE_CURRENT, MODE_VELOCITY)):
                    mode = frame[8]
                if mode is not None:
                    motor.mode = mode
                    motor.current_amp = 0.0
                    motor.velocity_target_rpm = 0.0
                return b''
            if frame[1] != 0x64 or crc8_maxim(frame[:9]) != frame[9]:
                return b''
            # The answer reports the state when the frame arrives, then the command applies.
            answer = b'' if self.drop_answers else motor.answer(self.noise_rpm, self._rng)
            value = to_int16(frame[2], frame[3])
            if motor.mode == MODE_CURRENT:
                motor.current_amp = value * AMP_PER_RAW
            else:
                motor.velocity_target_rpm = float(value)
            motor.frames += 1
            return answer

    def _serial_loop(self):
        buffer = bytearray()
        while self._running:
            try:
                data = os.read(self._master, 64)
            except OSError:
                if not self._running:
                    return
                time.sleep(0.01)  # nobody holds the port (drive_component not started yet)
                continue
            buffer.extend(data)
            while len(buffer) >= 10:
                if buffer[0] not in self.motors or buffer[1] not in (0x64, 0xA0):
                    del buffer[0]  # resynchronize on the next byte
                    continue
                frame = bytes(buffer[:10])
                del buffer[:10]
                answer = self.handle_frame(frame)
                if answer:
                    os.write(self._master, answer)

    def _physics_loop(self):
        last = time.monotonic()
        while self._running:
            time.sleep(0.001)
            now = time.monotonic()
            elapsed = min(now - last, 0.05)
            last = now
            steps = max(1, int(math.ceil(elapsed / 0.0005)))
            with self._lock:
                if PLANTS[self.plant].lifted:
                    for motor in self.motors.values():
                        for _ in range(steps):
                            motor.step(elapsed / steps)
                else:
                    for _ in range(steps):
                        self._step_body(elapsed / steps)


if __name__ == '__main__':
    import tempfile
    bus = FakeDdtBus(link_path=os.path.join(tempfile.mkdtemp(prefix='questix_sim_'), 'ttyDDT'))
    bus.start()
    print(f'fake M0602C bus on {bus.port} -> {bus.device} (Ctrl-C to stop)')
    try:
        while True:
            time.sleep(1.0)
            print({k: round(v[0], 1) for k, v in bus.snapshot().items()})
    except KeyboardInterrupt:
        bus.stop()
