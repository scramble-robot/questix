# operation_manager

The robot-wide stop and permission decisions of QUESTiX, as three components that share no state
(`design/safety_permission_input_refactor.md`, section 3.3). Each runs as its own process
(`*_node` executables) and can also be loaded into a container. `questix_core` starts them through
`launch/operation_manager.launch.xml` (arguments: `robot_mode`, `enable_gpio_safety`,
`enable_referee`).

| Component | Decides | Inputs | Publishes |
|---|---|---|---|
| `EmergencyStopManager` (`emergency_stop_manager`) | the emergency stop (L1), a safety function | GPIO5 (physical E-stop) | `/emergency_stop` |
| `RefereeMonitor` (`referee_monitor`, competition only) | the referee's vote | GPIO27 (AutoReferee `AR_in`) | `/motion_vote/referee` |
| `MotionPermissionManager` (`motion_permission_manager`) | the motion permission (L2) | the votes the running mode needs | `/motion_permission` |

The actuators (drive_component, shot_component, esc_motor_control) obey `/motion_permission` and
`/emergency_stop` and nothing else; they know no mode, no referee and no teacher. Contracts:
`questix_msgs/README.md`.

## EmergencyStopManager (L1)

The physical E-stop circuit's GPIO5, and nothing that is not a safety function (keep other
features out of this component). `config/emergency_stop_manager.yaml`:

- `safe_low_pins` (`[5]`): pins whose safe value is `false` (stop on `true`). GPIO5 raw value:
  released `false`, pressed `true`.
- `timeout_seconds` (1.0): a GPIO update older than this counts as pressed.
- `emergency_stop_topic` (`/emergency_stop`).
- `gpio_safety_enabled` (default `true`): `false` runs without the GPIO safety path
  (`config/emergency_stop_manager.no_gpio.yaml`, used by `questix_core` with
  `enable_gpio_ref:=false`, an explicit manual diagnostic launch only: the launch argument must be
  given on that launch, the `ENABLE_GPIO_REF` environment variable never selects it, and nothing
  persists it; the production launcher always passes `enable_gpio_ref:=true`). It then reads no
  GPIO, publishes no pin diagnostics (one WARN status instead), and still owns `/emergency_stop`:
  `active=false`, reason `released (no GPIO safety path)`, every 100 ms. Every actuating node and
  QUESTiX LAB therefore keep one rule (unheard, silent or active means stop) with or without GPIO.

Publishers:

- `/emergency_stop` (questix_msgs/EmergencyStop, reliable + transient_local, keep-last(1)):
  `active` while a monitored pin is pressed, not received, stale or has an invalid time; on every
  GPIO update and every 100 ms. `source` is `operation_manager`; `reason` is `released` or the pin
  reasons (`pin 5 not received; `, `pin 5 is true, expected false; `, `pin 5 timeout; `).
- `/diagnostics` (diagnostic_msgs/DiagnosticArray): one status `operation_manager: emergency_stop`
  (OK / ERROR) with per-pin `pin_<N>_state`, `_expected`, `_received`, `_age_sec`.

The circuit independently removes motor power through RLY1: both DDT drive motors, the roller ESC,
the Shot servo and the Tilt servo, while the Raspberry Pi and the 5 V / 3.3 V I/O stay powered (so
GPIO5 keeps reporting). The hardware cutoff and the ROS software stop are independent, redundant
safety paths.

## RefereeMonitor (the referee's vote)

The AutoReferee's GPIO27 as the referee's vote for the motion permission. A defeat is a state of
the game, not a safety function: it never reaches `/emergency_stop`. Started by competition
launches only. `config/referee_monitor.yaml`: `referee_pins` (`[27]`, safe-high),
`timeout_seconds` (1.0), `vote_topic` (`/motion_vote/referee`).

- `/motion_vote/referee` (questix_msgs/ActuationAuthority, reliable + volatile, keep-last(1); both
  flags equal, `source` `referee`): true while GPIO27 is received, fresh and true; on every GPIO
  update and every 100 ms.
- `/diagnostics`: `operation_manager: referee` (OK; WARN while the referee stops the robot; ERROR
  while the signal is missing) with the per-pin values and `pin_27_signal_limit`.

GPIO27 is the AutoReferee `AR_in`. The client's defeat output (5 V when defeated, 0 V otherwise)
is inverted by the HAT's optocoupler, so defeated reads `false` and not defeated is pulled to
3.3 V / `true` by R2 (10 kΩ). A disconnected AutoReferee, an unpowered client and an open primary
side also read `true`: current hardware cannot tell them from "not defeated", and the diagnostics
say so (`pin_27_signal_limit`).

## MotionPermissionManager (L2)

Combines the votes the running mode needs into `/motion_permission` (questix_msgs/MotionPermission,
reliable + volatile, 20 Hz and at once on a change). It knows only votes
(`config/operation_manager.permission.yaml`):

- `votes.<name>: <topic>`: `referee: /motion_vote/referee`, `teacher: /actuation_authority`.
- `required.<mode>: [<name>, ...]`: lesson `[teacher]`, competition `[referee]`; practice is left
  out (no vote, always allowed, still published).
- `modes`: the known modes; `mode` (questix_core's `robot_mode`): another one refuses to start, as
  does a required vote without a topic.
- `lease_sec` (1.0): a vote older than this is stale.

A required vote never heard → `<name>:unknown`, silent → `<name>:stale` (both flags), a received
false → `<name>:off` (that flag). A new condition is a node that publishes a vote and one line in
the YAML. Rule: `questix_safety/motion_permission_rule.hpp`.

## Modes

| Mode | GPIO5 physical E-stop | GPIO27 AutoReferee | `/emergency_stop` | `/motion_permission` |
|---|---:|---:|---|---|
| practice / lesson | false | not read | released | practice: allowed; lesson: the teacher's vote |
| any | true, missing or stale | - | active | (whatever the votes say) |
| competition | false | true | released | allowed |
| competition | false | false, missing or stale | released | not allowed (`referee:off`) |

GPIO freshness uses `std::chrono::steady_clock` (monotonic, independent of ROS or system-clock
adjustments); ROS time is only in the message stamps. A backwards or non-finite freshness time
counts as stale, so an invalid time source cannot extend the fresh period. No pin is considered
safe before its first message.

Build:
- colcon build --packages-select operation_manager

Run (with config):
- `ros2 launch operation_manager operation_manager.launch.xml robot_mode:=practice`
