# Differential-drive status: per-wheel MotorFeedback plus chassis velocity.
#
# Publishers: drive_component (/drive_status, status_publish_rate Hz),
#             joy_axis_drive (joy_axis_drive_status).
#
# joy_axis_drive has no wheel-geometry parameters, so it publishes
# linear_velocity = angular_velocity = 0.0 (only the per-wheel MotorFeedback is
# meaningful there). See questix_msgs/README.md for the full topic contract.
#
# Overall health is derivable as left.fault_code == 0 && right.fault_code == 0.

std_msgs/Header header      # stamp = publish time; frame_id unused ("")
MotorFeedback left          # left wheel (per-wheel stamp = its feedback time)
MotorFeedback right         # right wheel
float64 linear_velocity     # [m/s]  computed from measured wheel RPM
float64 angular_velocity    # [rad/s] computed from measured wheel RPM
bool emergency_stop         # publishing node's emergency-stop flag
