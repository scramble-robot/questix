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

## Review corrections and deployment gate (v2)

The v2 owner record begins `COMMITTED`, is root-owned mode 0600, and is published
atomically only after this guard successfully exports and validates enabled Low.
A `.pending` file records incomplete initialization and never authorizes recovery.
Old unversioned markers are rejected: **do not upgrade a live owner or remove its
marker/export to make startup pass**. Preserve ESC OFF and review an orderly reboot
and the actual pinmux/export before migration. `FAULT_LOW` remains monitored;
unexpected duty is driven back to API Low, while unknown period/polarity/enable or
failed readback becomes `FAULT_UNKNOWN`. The original fault remains latched.

Privileged robot callbacks no longer read the user-owned `launch.env`: the opt-in
drop-in resets `EnvironmentFile`, uses Python isolated mode, and gives the native
AUTHORIZE child a fixed environment. The unprivileged standard launcher still reads
normal configuration, then pins the reviewed local install and ESC YAML from the
root-owned `reviewed-launch.env`. Parent colcon overlays are not sourced. Root guard
writes are limited to the reviewed Ubuntu Pi 5 PWM0 device path and its runtime
folder; capabilities are empty. A differing sysfs device path needs explicit review.

Before the two-argument installer can be used, build the **reviewed source** for
ARM64, including the launcher and its runtime dependencies. Each guard/ctl and ESC
node/component ELF embeds the source digest of the six reviewed package trees and
standard launcher. With the build complete and review checks passed, seal it:

```sh
python3 -I questix_pwm_guard/deploy/review_manifest.py seal \
  /path/to/reviewed/source /path/to/reviewed/install \
  /path/to/reviewed/install/reviewed-release.json
# After an independent review records the exact manifest SHA (not a hash guessed from this prefix):
# the operator records that SHA in root-owned mode 0600
# /etc/questix_pwm_guard/approved-release.sha256. Keep its parent root-owned and non-writable.
sudo bash questix_pwm_guard/deploy/install_reviewed.sh /path/to/reviewed/install scramble
```

The manifest records the whole install prefix's file hashes, including Python bytecode, and rejects old ELFs,
changed dependencies, missing runtime packages and YAML/setup changes. Its digest
is source identity, **not independent approval or a measured safety result**. Do not
seal an unreviewed build to bypass the gate. The installer requires the separately approved manifest SHA, freezes it in root-owned
staging, and compares copied native binaries/helpers/config inputs against that fixed
table before installation. An ELF source marker alone authenticates nothing. It verifies
its own source identity, stages DT compilation before asset changes, records all backup paths and
absences, and publishes `READY` only after final verification. A durable deployment
in-progress record blocks manual authorization after any interrupted update; never
rerun a partial installer blindly. Installer/validator/rollback share a deployment
lock. Installer requires robot and guard quiescent and never stops a running Low
owner to satisfy that check. It installs the reviewed standard launcher, but does
not replace the source workspace, enable/start services, reboot, or export GPIO.

Rollback restores the recorded paths and retains withdrawn assets, including
originally absent paths. It does not stop a live guard, change unit enable state,
restore unrecorded custom assets, or guarantee pinmux. Review the backup and keep
ESC OFF through an operator-approved reboot before choosing lgpio. Existing custom
symlinks and unsafe privileged directories require separate review.

Shutdown's 800 ms budget begins at entry and bounds each RPC and sleep by the same
monotonic deadline. Linux scheduling still supplies no hard real-time guarantee.
Legacy backend run-write failures immediately attempt signal stop; successful Low
fallback is terminal and later neutral is refused. Actual requests in the invalid
1–499 us interval are rejected and stopped without silently changing the mapping.

Software verification does not release E-stop or shooting HOLD. Before powered
motion/shooting, validate the reviewed ARM64 deployment, neutral/Low and complete
normal/fault shutdown waveforms, and independently approve the physical setup and
power-cut protection. Initial short Low snapshots do not cover those conditions.
