# The teacher's runtime actuation authority for a practice robot (QUESTiX classroom use).
#
# Publisher:   Robot Manager (scripts/robot_manager/actuation.py, a heartbeat child process),
#              only while the teacher has switched something on in practice mode.
# Subscribers: drive_component, shot_component, esc_motor_control, only when their parameter
#              require_runtime_actuation_authority is true (a practice opt-in of questix_core,
#              default false; competition launches always set it false). This is a permission,
#              not an emergency stop: by default Robot Manager only uses it as the precondition
#              for QUESTiX LAB's lesson permissions.
#
# QoS contract: reliable + volatile + keep-last(1). NEVER transient_local: an "allowed" must not
# be latched for late joiners or outlive its publisher.
#
# Lease: subscribers judge freshness by their own monotonic receive time, never by header.stamp.
# Published at about 5 Hz; a subscriber treats it as off after runtime_authority_timeout_sec
# (1.0 s) of silence, and as unknown (off) before the first message. Losing it stops the
# actuator; getting it back never restarts anything by itself (a fresh command is needed).
#
# See questix_msgs/README.md for the full contract.

std_msgs/Header header  # stamp = publish time (information only; not used for freshness)
bool drive_allowed      # drive may move the wheels (enforced on the controller only when opted in)
bool launcher_allowed   # roller / tilt / feeder may move (likewise)
string source           # publisher identifier, e.g. "robot_manager"
