# Whether the robot may move now: the motion permission (L2), on /motion_permission.
#
# Publisher:   operation_manager's MotionPermissionManager. It combines the votes its YAML lists
#              for the running mode (operation_manager/config/operation_manager.permission.yaml):
#              lesson needs the teacher's vote (/actuation_authority, Robot Manager), competition
#              the referee's (/motion_vote/referee, RefereeMonitor on GPIO27), practice none.
# Subscribers: drive_component (drive_allowed), shot_component and esc_motor_control
#              (launcher_allowed), through questix_safety::PermissionMonitor.
#
# A permission, not an emergency stop (/emergency_stop is the safety function, L1): it is never
# latched and it does not cut power. Losing it stops the actuator; getting it back never restarts
# anything by itself (a fresh command is needed).
#
# QoS contract: reliable + volatile + keep-last(1). NEVER transient_local: an "allowed" must not be
# latched for late joiners or outlive its publisher. Published at 20 Hz and at once on a change.
#
# Lease: subscribers judge freshness by their own monotonic receive time, never by header.stamp;
# silence for motion_permission_timeout_sec (0.5 s) and "never heard" both mean not allowed.
#
# See questix_msgs/README.md for the full contract.

std_msgs/Header header       # stamp = decision time (information only; not used for freshness)
bool drive_allowed           # the wheels may move
bool launcher_allowed        # the roller, tilt and feeder may move
string mode                  # the running mode: lesson / practice / competition (display only)
string[] drive_blockers      # why drive_allowed is false, e.g. "referee:off", "teacher:stale";
                             # empty when allowed (display only: actuators read the bool)
string[] launcher_blockers   # the same for launcher_allowed
