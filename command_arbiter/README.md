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

Design: `design/safety_permission_input_refactor.md`, section 4.
