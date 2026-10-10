# What command_arbiter decided for one mechanism (L3), on /command_arbiter/status: which input
# reaches the actuators and why QUESTiX LAB is refused, so that the lab bridge and Robot Manager
# never have to guess (design/safety_permission_input_refactor.md section 4.4).
#
# Publishers: command_arbiter's DriveArbiter (mechanism "drive") and LauncherArbiter ("launcher"),
#             lesson launches only. Both on the same topic: keep the latest per mechanism.
# QoS: reliable + volatile + keep-last(10); 5 Hz and at once on a change.
#
# The arbiter never stops anything for the E-stop or the motion permission: the actuators do.

std_msgs/Header header       # stamp = publish time
string mechanism             # "drive" or "launcher"
string active_source         # "joy" (the controller) or "lab" (QUESTiX LAB)
string switch_reason         # why active_source is what it is: "start", "lab", "controller",
                             # "lab_ended", "lab_idle", "not_permitted"
bool lab_permitted           # the teacher's lesson permission (/lab_permission) is fresh and on
bool lab_locked              # the controller took over: QUESTiX LAB waits until its run ends
string lab_refusal           # why the last lab command was refused ("" = accepted): "not_permitted",
                             # "controller", "locked", "invalid", "not_spinning", "interval"
uint32 lab_count             # lab commands received since start (ties a status to a lab run)

# QUESTiX LAB's limits in effect (the arbiter's caps, narrowed by the mechanism's own limits).
# drive
float32 max_linear           # [m/s]
float32 max_angular          # [rad/s]
# launcher
float32 max_power            # roller power 0..1
float32 tilt_min_deg
float32 tilt_max_deg
float32 min_fire_power       # the roller must run at this power or more ...
float32 spin_up_sec          # ... for this long before the lab may fire
float32 fire_interval_sec    # shortest time between two lab shots
float32 next_fire_in_sec     # until the lab may fire again (0 = now)
float32 spin_ready_in_sec    # until the roller has spun long enough (NaN = not spinning)
