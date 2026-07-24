# operation_manager

ROS 2 package that subscribes to raw GPIO topics from `gpio_reader` and
produces the robot-wide fail-safe controllability state.

Publishers:
- `/gpio/controllable` (std_msgs/Bool): true if controllable
- `/diagnostics` (diagnostic_msgs/DiagnosticArray): standard diagnostic aggregation
  topic. One `DiagnosticStatus` (name `operation_manager: gpio_controllability`,
  hardware_id `gpio`) with `level` OK/ERROR and per-pin `KeyValue` entries
  (`pin_<N>_state`, `pin_<N>_expected`, `pin_<N>_received`,
  `pin_<N>_age_sec`). GPIO27 also includes `pin_27_signal_limit`, which
  records that a high input cannot distinguish permission from disconnected,
  client-unpowered, or primary-side-open states. Consumable by
  `rqt_runtime_monitor`.
- `/emergency_stop` (questix_msgs/EmergencyStop, reliable + transient_local, keep-last(1)):
  unified emergency stop state, `active = !controllable`, published on every
  controllability evaluation (each GPIO update plus the 100 ms watchdog timer).
  See `questix_msgs/README.md` for the full topic contract and recovery semantics.

Parameters:

- `safe_low_pins`: pins whose safe value is `false` (stop on `true`)
- `safe_high_pins`: pins whose safe value is `true` (stop on `false`)
- `timeout_seconds`: maximum allowed age of GPIO update before marking not controllable
- `emergency_stop_topic`: topic name for the unified emergency stop state (default `/emergency_stop`)

The two pin lists define the monitored pins; no separate parallel
`monitored_pins` array exists. Startup fails for an empty configuration,
duplicates, overlap between lists, BCM values outside 0--53, or a non-positive
timeout.

Profiles:

- `config/operation_manager.practice.yaml`: `safe_low_pins: [5]`,
  `safe_high_pins: []`
- `config/operation_manager.competition.yaml`: `safe_low_pins: [5]`,
  `safe_high_pins: [27]`
- `config/operation_manager.yaml`: backward-compatible safe practice default

GPIO5 is the raw indication from the physical emergency-stop circuit. The
circuit independently removes motor power through RLY1; GPIO5 reports its state
to ROS. RLY1 cuts power to both DDT drive motors, the roller ESC, Shot servo,
and Tilt servo while Raspberry Pi, 5 V I/O, and 3.3 V I/O remain powered. The
hardware cutoff and ROS software stop are independent, redundant safety paths.

GPIO27 is the competition-only AutoReferee `AR_in`. The client defeat output
is 5 V when defeated and 0 V otherwise; the HAT optocoupler inverts it, so
defeated is `false`/stop and R2 (10 kΩ) pulls the not-defeated state to
3.3 V/`true`. Disconnected AutoReferee, unpowered client, and primary-side
open circuit also read `true`. This hardware ambiguity cannot be detected by
operation_manager and is reported in diagnostics as `pin_27_signal_limit`.

No pin is considered safe until its first message has arrived. Every required
pin must be received, fresh, and equal to its configured safe value. Reasons
distinguish `not received`, `timeout`, and actual/expected value mismatch.
`/emergency_stop.active` is always the inverse of `/gpio/controllable`.

| Mode | GPIO5 physical E-stop | GPIO27 AutoReferee | Controllable |
|---|---:|---:|---:|
| practice | false | not monitored | true |
| practice | true | not monitored | false |
| competition | false | true | true |
| competition | true | any | false |
| competition | any | false | false |
| any | missing or stale required input | - | false |

Build:
- colcon build --packages-select operation_manager

Run (with config):
- `ros2 launch operation_manager operation_manager.launch.xml`
