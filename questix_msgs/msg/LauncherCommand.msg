# One command for the disc launcher (roller, tilt, fire), the launcher's counterpart of the drive's
# geometry_msgs/Twist on /target_twist (L3, design/safety_permission_input_refactor.md section 4.1).
#
# Topics: /launcher_command (what the launcher obeys), and per input /launcher_command/joy
# (joy_controller) and /launcher_command/lab (QUESTiX LAB bridge). In a lesson launch
# command_arbiter's LauncherArbiter picks one input for /launcher_command; in practice and
# competition joy_controller publishes /launcher_command directly.
# Subscribers of /launcher_command: esc_motor_control (roller_power) and shot_component
# (tilt_deg, tilt_steps, fire_seq). Each uses its own fields only, and both still obey
# /emergency_stop and /motion_permission: this message never overrides them.
#
# QoS: reliable + volatile + keep-last(1). Publishers send it continuously while in use (the
# controller at its joy rate, the lab at 20 Hz): the roller stops when commands stop for
# esc_motor_control's command timeout. The events (a shot, a tilt step, a new tilt target) are
# counters and targets, not pulses, so a dropped or repeated message never loses or repeats one.
#
# Event semantics: one counter space per publisher (command_arbiter's output keeps its own, so a
# change of input never replays or loses an event; source is for display only). The first
# message, one after silence longer than the receiver's command timeout, and one whose fire_seq
# went backwards (the publisher restarted) only set the baseline and move nothing:
#   fire_seq    each increase over the previous message fires one disc (one per message at most)
#   tilt_steps  each change moves the tilt by that many tilt_step_angle (+ up, - down)
#   tilt_deg    a finite value that differs from the previous message's (NaN before, also on the
#               baseline: it is the current wish) moves the tilt there (clamped to the range)
# One publisher per topic: esc_motor_control and shot_component move nothing while more than one
# node publishes /launcher_command (their counters and levels would mix).

std_msgs/Header header  # stamp = publish time (information only)
float32 roller_power    # 0..1 of the roller's full power; 0 = stop
float32 tilt_deg        # absolute tilt target [deg]; NaN = no target (the controller uses steps)
int32 tilt_steps        # cumulative tilt steps (the controller: +1 per up press, -1 per down press)
uint32 fire_seq         # cumulative shot requests: each increase fires one disc
string source           # "joy" / "lab" (display, and the receivers' per-source baselines)
