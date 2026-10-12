# questix_safety

The shared checks of the QUESTiX actuating nodes (`drive_component`, `shot_component`,
`esc_motor_control`). Header-only. Two separate concepts, each with one rule:

## L1: the emergency stop (`/emergency_stop`)

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
GPIO safety path (`released (no GPIO safety path)`).

## L2: the motion permission (`/motion_permission`)

- `questix_safety/permission_check.hpp`: the rule. A permission is a lease: never heard, silent
  for longer than `motion_permission_timeout_sec` (0.5 s; an invalid value falls back to it, a
  lease always expires) or a received "not allowed" all mean "do not move".
  `require_motion_permission: false` (an explicit diagnostic run only) drops the whole check.
- `questix_safety/permission_monitor.hpp`: `PermissionMonitor` owns the parameters
  (`motion_permission_topic`, `require_motion_permission`, `motion_permission_timeout_sec`), the
  subscription with the contract QoS (reliable + volatile + keep-last(1); never latched) and the
  receive state. Each node obeys one flag: the drive `drive_allowed`, the launcher nodes
  `launcher_allowed`.
- `questix_safety/motion_permission_rule.hpp`: how operation_manager's MotionPermissionManager
  combines the votes the running mode needs (`<name>:unknown` / `:stale` / `:off` blockers).

A node that has both judges the permission first and the E-stop last: the E-stop is the last
gate before the motors and wins (its reaction, its reason) when both block.

Contracts: `questix_msgs/README.md`.
