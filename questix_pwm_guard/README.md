# QUESTiX GPIO13 RP1 PWM guard

Opt-in software implementation for Pi 5, GPIO13 / physical 33 / HAT CN3.3.
The daemon owns RP1 **PWM0 channel 1**, selected by the Device Tree node ending
`/rp1/pwm@98000`, not a hard-coded pwmchip number. CN3.2 is GND; CN3.1 is 3.3 V.

This implementation has not been deployed or electrically validated. Do not claim
Issue #177 resolved, ESC safety proven, or shooting enabled from software tests.

## Output and lifetime contract

- Period 20 ms, normal polarity; neutral 1000 us; allowed nonzero width 500–2000 us.
- Starts with enabled duty=0, leaves the export and pinmux in place after ROS exits.
- The root-owned daemon is separate from the robot cgroup. Only it writes PWM.
- No lgpio/pigpio claim/write is used for GPIO13 by the `rp1_hw` backend.
- Manual authorize gives one 30 s arm ticket. ARMING has a fixed 3 s deadline.
- COMPLETE switches to a 1 s lease; the ROS executor refreshes commands every 100 ms,
  re-evaluating E-stop/permission/command timeouts. RP1 generates edges independently.
- Normal shutdown fixes a 500 ms neutral interval, then terminal Low. It cannot be
  extended by repeated shutdown or delayed commands. Old sessions cannot restart PWM.
- Unexpected connection loss or lease expiry requests Low without a new 500 ms wait.
- Fault cause is latched. A manual authorize after Low is required for another session.
- API acceptance/readback is **not** measured voltage, waveform or motor rotation.

Linux/guard failure may leave the last PWM running until recovery. systemd watchdog
and ExecStopPost Low recovery are best effort, with no hard real-time bound.
Independent power-cut hardware is needed to cover a complete Linux hang. Manual
E-stop remains required; passive pull-down is not a substitute for removing PWM.

## Protocol / permission

Unix SOCK_SEQPACKET; ASCII decimal fields, no host byte-order dependence:
`1 OP session sequence pulse_us`. Responses:
`1 ok STATE applied_us session error`. Error is a negative errno-style code.
Frames with unsupported version, invalid fields, trailing fields or excessive size
are rejected. Client RPC timeout is 100 ms; shutdown wait budget is 800 ms.

Operations: STATUS, AUTHORIZE, LOW, ARM, COMPLETE, COMMAND, SHUTDOWN, STOP.
AUTHORIZE/LOW require uid 0 in the production daemon. ARM requires the configured
robot uid; a single socket owns the session. Other connections cannot use its ID.
Service socket group grants connection, not administrative operations.

The compile-time fake Output/admin override exists only in the uninstalled test
server. The production daemon rejects those command-line options.

Existing export takeover requires the root-owned owner marker, matching boot and
controller plus normal/20 ms/enabled state. Unknown output is refused, not silently
reset. New export and pinmux startup transients require ESC-OFF scope verification.
No automatic unexport is performed, including at shutdown. Reboot/power loss is a
separate electrical state that cannot be guaranteed by this process.

## Build/test

Build `questix_pwm_guard`, `questix_msgs`, `questix_safety`, `esc_motor_control_cpp`
with ROS 2 Jazzy/colcon. Hardware-free tests use fake files, injected time and actual
Unix sockets/process SIGKILL/SIGSTOP. `test_rp1_backend` exercises the real adapter
against an in-process fake guard. No tests in this package touch live GPIO/sysfs.

Legacy `auto` defaults remain unchanged. Explicit `pwm_backend: rp1_hw` is required;
initialization failure does not fall back to simulation. `test_mode=true` is still
explicit simulation. Live RP1 configuration requires 0/2000/1000 us mapping and a
finite safety timeout in (0,1]. Invalid intermediate pulse widths are rejected,
not remapped. The guard enforces the deployed 2000 us maximum independently.

## Reviewed deployment (not executed here)

`deploy/` is an explicit ID13 opt-in path, separate from generic kit/Ansible defaults.
It does not broaden polkit or sudo privileges and does not modify Robot Manager.
The systemd drop-in calls a root-owned manual-start validator before robot launch;
existing Robot Manager practice/lesson start requests are required. Competition
boot activation is intentionally rejected in this first opt-in implementation.
The top-level launcher forwards `QUESTIX_ESC_CONFIG_FILE` to the existing ESC YAML
argument. The canonical YAML stays the single source of defaults; a deployment
copy changes only the backend.

`install_reviewed.sh` installs reviewed **ARM64** binaries, units and GPIO13-only DT
into root-owned paths, with backup. It does not start/enable services, export PWM,
reboot or switch the live robot workspace. Before use: independent code review,
ESC power OFF, verify kernel DT symbols/driver/other consumers, verify reviewed ROS
install is the robot's actual workspace, and check service security/order. Its
arguments are the reviewed colcon install prefix and robot user.

`rollback_reviewed.sh` withdraws this new robot drop-in and restores boot config,
leaving assets for evidence. It is for the first opt-in installation, not an updater
that automatically restores an earlier RP1 installation. Restore previous custom
assets from backup if present. Neither script proves Low while unexported/unpowered.

No operator should execute deployment until the separate review/physical-test prompt
and actual safety conditions are satisfied.
