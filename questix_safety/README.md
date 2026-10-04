# questix_safety

The one `/emergency_stop` check of the QUESTiX actuating nodes (`drive_component`,
`shot_component`, `esc_motor_control`). Header-only.

- `questix_safety/estop_check.hpp`: the rule, ROS-free and clock-injected. An E-stop that was
  never heard, or that went silent for longer than `emergency_stop_timeout_sec`, counts as
  pressed; a received `active=true` is pressed. `require_emergency_stop: false` (an explicit
  diagnostic run only) drops "never heard" and "silent", never "pressed".
- `questix_safety/emergency_stop_monitor.hpp`: `EmergencyStopMonitor` owns the parameters
  (`emergency_stop_topic`, `require_emergency_stop`, `emergency_stop_timeout_sec`; declared
  unless the node already did), the subscription with the contract QoS (reliable +
  transient_local + keep-last(1)) and the receive state on the node's steady clock. Nodes ask
  `state()` / `engaged()` / `inputs()` and react to messages through the callback
  (`Change{first, was_active}`); what they do about it (stop the wheels, tear down the servo
  bus, zero the roller) stays in the node.

`/emergency_stop` always has a publisher in `questix_core`: operation_manager, also without the
GPIO safety path (`released (no GPIO safety path)`). Contract: `questix_msgs/README.md`.

The teacher's permission (`/actuation_authority`) is a different concept and is not here.
