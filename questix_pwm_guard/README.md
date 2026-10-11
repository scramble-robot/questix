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

## Trust contract: reliability monitoring, not isolation from classroom code

The robot account (`scramble` on ID13) remains the desktop auto-login and classroom
account. This opt-in does not introduce a dedicated ESC UID or change student login,
lesson/practice start/stop buttons, or classroom editing/build commands.

All code running as the configured robot UID is inside the trusted control domain.
The guard checks the UID and session owner, **not** the identity of the ESC executable.
After root AUTHORIZE, any process of that UID can claim the first ARM and issue valid
commands without the ROS gates. The owner socket prevents a second connection from
using an existing session; it does not authenticate the first owner as the ROS ESC.
The manual request's mode/boot/time checks do not independently authenticate a human:
the robot account can write the request and use its existing unit-start permission.

Operators accepting this contract must treat both intentional bypass and accidental
ticket capture/direct guard use by same-UID classroom code as outside the guard's
protection. Documentation is a deployment acceptance condition, not technical
enforcement. Do not run code that requires isolation from the actuators under this
account and claim that the guard supplies that isolation. Revisit account/process
separation and authenticated safety inputs if such isolation becomes a requirement.
ROS topic authentication is not added here. Freezing reviewed runtime artifacts below
does not authenticate ROS publishers or make the editable launch.env trusted against
the account that owns it.

The implemented boundary covers approved runtime file integrity, session/sequence,
expiry and best-effort disconnect/fault handling. It cannot cover Linux hangs, every
other GPIO path or arbitrary code in the robot account. Physical E-stop and powered
test approval remain separate; no software review releases shooting HOLD.

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
# Prepare a source receipt as an ordinary user; this is evidence, not self-approval:
python3 -I questix_pwm_guard/deploy/review_manifest.py source-seal \
  /path/to/reviewed/source /path/to/reviewed/source/reviewed-installer-source.json
# The root operator independently reviews the exact source table/digest and copies the
# reviewed source and receipt into a versioned root-managed tree. Keep source/ancestors
# root-owned, go-w removed, no symlinks/hardlinks; receipt mode0600. Check copied SHA.
# Execute only that protected copy, using fixed executables and an empty environment:
/usr/bin/sudo /usr/bin/env -i PATH=/usr/bin:/bin LANG=C /bin/bash --noprofile --norc \
  /root/questix-reviewed/SOURCE_ID/questix_pwm_guard/deploy/install_reviewed.sh \
  /path/to/reviewed/install scramble
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

The reviewed release must be a standalone **non-symlink install**, with relocatable
colcon local setup/hooks and runtime dependencies. The ordinary student workspace
and its `--symlink-install` build workflow stay unchanged; do not seal that mutable
development tree as a release. Inspect external absolute references, Python `.pth`
files and ELF search paths before approving a release; hashes alone cannot prove
that approved script code has no external dependency. The fixed Jazzy underlay is
separate from the reviewed prefix and must also remain administrator managed.

Installation now freezes **every approved install file** into
`/opt/questix_pwm_guard/releases/<approved-manifest-sha256>/`. Copy traversal refuses
symlinks/special files and rechecks all copied bytes before installed-asset changes.
The CLI prefix must equal the independently approved manifest's prefix. Publication
uses a private root staging directory and never overwrites a version. Root owns all
runtime files and ancestors; the robot cannot write them or replace their paths.
The exact original approval is retained as mode-0600 `reviewed-release.json` inside
the release. The deployed root manifest binds that approval, file table and frozen
path; the standard launcher uses only that path. Source digest is not a runtime
release ID: different dependencies/build artifacts need their own approved manifest.

Startup rejects legacy mutable-prefix manifests, writable/non-root paths, links and
changed bytes. Old SD installation is **not upgraded by this source commit**: build,
independently approve and install a new ARM64 release before attempting robot start.
Later edits or deletion of the original build/install cannot change frozen bytes.
Logs/cache/output belong outside the runtime. If relocation or read-only execution
fails, keep startup blocked and correct the build/output paths; do not silently fall
back to the editable prefix. Backup/rollback includes the version tree beneath
`/opt/questix_pwm_guard`, preserves withdrawn evidence and does not start services.

ARMING's fixed 3 s value is a **completion deadline**, not a minimum neutral hold.
The regular ESC component waits 2 s before COMPLETE; another allowed-UID client can
complete sooner. A minimum duration in the guard is not added by this change.

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

## Privileged source, public runtime layout and approval withdrawal

Installer and rollback must be invoked from an independently reviewed root-managed
source snapshot with `reviewed-installer-source.json` at its root, root-owned mode0600.
The receipt binds every file in the six source packages and the standard launcher,
including both scripts and all helpers/templates/DTS. Its source digest is evidence,
not approval by itself: the operator must review it independently before copying it
into the protected source tree. A development checkout is not a root execution source.
Use the clean-environment `/usr/bin/env -i ... /bin/bash --noprofile --norc` invocation
above for rollback too, with its recorded backup argument. The caller must trust those
system executables. Script-body PATH assignment cannot prevent Bash startup code or
loader injection that runs before the script; do not preserve caller environment.
Both scripts fix PATH before external operations, check source/file ancestors, links,
receipt permissions and every source SHA before executing helpers, and recheck before
completion. Store the independent expected SHA and the protected-copy checks in the
operator's deployment evidence. Student login and classroom buttons are unchanged.

Manifest schema3 (`rp1-reviewed-v3`) requires the approved `install_layout` table:
all directories, including empty ones, and each file's intended mode. Runtime is
public-readable educational material: files become0644 plus independently approved
execute bits, directories0755; this is an intentional normalization, not byte-for-byte
preservation of access permissions. Do not place private keys, credentials or other
confidential data in this public runtime prefix. The approval receipt itself remains
0600. Special permission bits are refused. Source execute-mode changes and published
mode/directory changes are rejected, and the frozen original binds the layout as well
as file bytes. Old schema2 manifests are not silently upgraded; rebuild/reseal/review
and reinstall the complete ARM64 release. The embedded V2 source-identity marker is
still a source digest marker, not the manifest schema or an independent approval.

`approved-release.sha256` is the current administrative approval; installation records
the exact installed original-manifest digest in root0600 `runtime-approved.sha256`.
The manual validator checks both against the retained original manifest. The daemon
also checks the two strict root0600 digest records before AUTHORIZE and ARM, including
ARM using an already issued ticket. Missing/mismatched/malformed records or unsafe
files deny new authorization/arming. STATUS, LOW and recovery remain available.
These file checks spawn no process and do not execute setup/workspace code; no hard
real-time I/O bound is claimed.

Removing or replacing current approval prevents new authorization/ARM. It does not
stop an active session or cut ESC power. A root administrator remains trusted and can
replace privileged configuration; this is not isolation against root. For immediate
operational withdrawal, independently ensure ESC power OFF, stop robot under the
reviewed procedure, verify/retain required Low/export, and block subsequent starts.
Do not stop guard, unexport, remove the drop-in, or fallback to the editable workspace
as an automatic consequence of approval loss. Existing runtime release/backup evidence
must be retained. Restoring matching approval is an explicit administrator decision.
The old SD at27467b1 has not received these changes and no physical tests are implied.


Source receipt verification independently enumerates exactly the six source package
folders (`launcher` is the source name) and `systemd/questix_robot_launcher.sh`, then
requires exact equality with receipt keys before executing any source helper. Entries
inside `__pycache__` and files ending `.pyc` are the fixed generated-cache exclusions;
links/special entries and unsafe source paths are rejected. Installer and rollback use
the same rule. A receipt covering only mandatory scripts, missing files, stale entries
or additional unapproved files is refused.

The three required ELF programs (guard, CLI and ESC node) must have approved public
mode0755; verify/seal/freeze reject0644 or owner-only execute modes even when their
bytes and manifest hashes agree. The shared component library and sourced setup files
remain valid0644. Normalized public reading, student login/actions and schema3 stay
unchanged. Fresh source identity requires a new reviewed ARM64 build and approval;
this software change does not deploy or operate the robot.
