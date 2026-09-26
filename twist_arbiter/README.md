# twist_arbiter

Chooses which velocity command reaches `drive_component` (`/target_twist`): the controller's
(`joy_controller`, remapped to `/target_twist/joy`) or a QUESTiX LAB driving experiment's
(`questix_lab_bridge`, `/target_twist/lab`). It lets a class switch between driving by hand and
the lessons' experiments without relaunching anything.

| Situation | What reaches `/target_twist` |
| --- | --- |
| Nobody runs a lab experiment | The controller's commands. |
| A lab run starts while the stick is neutral (or no controller runs) | The lab's commands. |
| A lab run starts while the stick is held | Still the controller; the bridge ends the run. |
| The stick moves during a lab run | The controller at once; the lab is locked out until its run has ended. |
| The lab stops sending for `lab_timeout_sec` | The controller again. |

Status: `/twist_arbiter/status` (`std_msgs/String`, latched) holds
`{"active": "joy"|"lab", "reason": "start"|"lab"|"controller"|"lab_idle", "lab_locked": bool}`;
`questix_lab_bridge` reads it to end a run the controller took over.

Started by practice launches only: `questix_launcher/launch/questix_core.launch.xml` passes
`enable_twist_arbiter` to `drive_component.launch.xml` unless `enable_autoreferee` is set, so a
competition run keeps `joy_controller` → `/target_twist` exactly as before.

- Rules: `include/twist_arbiter/arbiter_logic.hpp` (ROS-free, `test/test_arbiter_logic.cpp`).
- Parameters: `config/twist_arbiter.yaml` (topics, what counts as a neutral stick, timeouts).
- Standalone: `ros2 launch twist_arbiter twist_arbiter.launch.xml`.

Validated on an AMD64 development machine with a fake drive node; Raspberry Pi 5 validation with
the real controller, drive and E-stop is pending and authoritative.
