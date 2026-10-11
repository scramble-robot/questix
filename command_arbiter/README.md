# command_arbiter

Chooses which input reaches the drive and the launcher in a lesson (L3, input selection): the
controller (`joy_controller`) or a QUESTiX LAB run (`questix_lab_bridge`). One rule for both
mechanisms (`include/command_arbiter/source_selector.hpp`, ROS-free, `test/test_source_selector.cpp`):

| Situation | What reaches the actuator |
| --- | --- |
| No lab run | The controller's commands. |
| A lab run starts (a non-neutral command) while the teacher's lesson permission is on and the controller is idle | The lab's commands. |
| The controller is used while the lab has the actuator, or while the lab asks for it | The controller at once; the lab is locked out until its run ends. |
| The lab sends a neutral command (zero velocity, roller 0) | That command (the stop), then the controller again. |
| The lab goes silent, or the permission goes | A stop, then the controller again. |

"Idle" is per mechanism: the drive needs the stick neutral (or no controller command for 0.5 s),
the launcher needs its inputs unused for 1.0 s. The arbiter never looks at the E-stop or the
motion permission: drive_component, shot_component and esc_motor_control stop on those themselves.

## drive_arbiter

`launch/command_arbiter.launch.xml` (included by `questix_core.launch.xml` with
`robot_mode:=lesson` only; parameters in `config/command_arbiter.yaml`) starts `drive_arbiter`
(`drive_arbiter_node`, also a component `command_arbiter::DriveArbiterComponent`):

| Topic | Type | Direction |
| --- | --- | --- |
| `/target_twist/joy` | `geometry_msgs/Twist` | in: joy_controller (remapped by the lesson launch) |
| `/target_twist/lab` | `geometry_msgs/Twist` | in: questix_lab_bridge (a page's run) |
| `/lab_permission` | `questix_msgs/ActuationAuthority` | in: Robot Manager's 教材からの走行 (`drive_allowed`), a 1.0 s lease on the node's monotonic clock |
| `/target_twist` | `geometry_msgs/Twist` | out: drive_component |
| `/command_arbiter/status` | `questix_msgs/ArbiterStatus` | out: mechanism `drive`, 5 Hz and on a change (reliable + volatile, depth 10) |

A lab command is forwarded only while the lesson permission is fresh and on, clamped to
`lab_max_linear` / `lab_max_angular` (0.15 m/s, 0.5 rad/s); a non-finite one is never forwarded
(it ends a lab run with a stop). The controller's commands are forwarded as they come. When a lab
run ends without a stop of its own (silence for `lab_timeout_sec`, the permission gone), the
arbiter publishes one zero. The status tells the bridge which input has the drive, why, whether the
permission is on, why the last lab command was refused, how many lab commands arrived
(`lab_count`), and the caps.

Design: `design/safety_permission_input_refactor.md`, section 4.
