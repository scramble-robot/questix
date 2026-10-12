# A vote for the motion permission (L2): the teacher's permission for a lesson robot on
# /actuation_authority (Robot Manager), and the referee's on /motion_vote/referee (operation_manager's
# RefereeMonitor, GPIO27). The same type for every vote.
#
# Publishers:  Robot Manager (scripts/robot_manager/actuation.py, a heartbeat child process), only
#              while the teacher has switched something on and the robot runs a lesson launch;
#              RefereeMonitor in competition.
# Subscriber:  operation_manager's MotionPermissionManager only, for the votes the running mode
#              needs (operation_manager.permission.yaml). The actuators never read a vote: they obey
#              /motion_permission (questix_msgs/MotionPermission). This is a permission, not an
#              emergency stop.
#
# QoS contract: reliable + volatile + keep-last(1). NEVER transient_local: an "allowed" must not
# be latched for late joiners or outlive its publisher.
#
# Lease: the subscriber judges freshness by its own monotonic receive time, never by header.stamp.
# Published at about 5 Hz or faster; a vote silent for lease_sec (1.0 s), or never heard, counts as
# off. Losing it stops the actuators through /motion_permission; getting it back never restarts
# anything by itself (a fresh command is needed).
#
# See questix_msgs/README.md for the full contract.

std_msgs/Header header  # stamp = publish time (information only; not used for freshness)
bool drive_allowed      # this vote lets the wheels move
bool launcher_allowed   # this vote lets the roller / tilt / feeder move
string source           # publisher identifier, e.g. "robot_manager", "referee"
