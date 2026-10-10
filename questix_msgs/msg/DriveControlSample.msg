# One control tick of drive_component (diagnostic only): what the host controller decided and
# what each wheel's DDT M0602C answered in that tick. Published once per tick on
# /drive_control_sample (rate = control_rate) while drive_component is ACTIVE and
# publish_control_sample is true (the default).
#
# DIAGNOSTIC ONLY: use it to record and analyse the drive (rosbag); never base a control or safety
# decision on it. /drive_status (DriveStatus) is unchanged and remains the status contract.
# See questix_msgs/README.md for the topic contract.

# drive_mode: the host drive state machine (motor_control_lib/drive_mode_fsm.hpp)
uint8 DRIVE_MODE_STOP=0
uint8 DRIVE_MODE_CREEP=1
uint8 DRIVE_MODE_RUN=2

# tick_action: what the tick did (motor_control_app/drive_control_tick.hpp)
uint8 TICK_IDLE=0          # unarmed or actuation blocked: no command (an idle tick may re-send the
                           # last successful zero frame only to refresh stale feedback)
uint8 TICK_DRIVE=1         # a drive command or a stop frame from the control core
uint8 TICK_TIMEOUT_STOP=2  # /target_twist timed out: safety stop
uint8 TICK_FAULT_STOP=3    # a motor reported a fault: safety stop

std_msgs/Header header     # stamp = start of this control tick (node clock); frame_id unused ("")
uint32 seq                 # +1 every tick from 0 at node start (a gap = lost samples)
float64 control_period_sec # [s] the nominal tick period 1 / control_rate
float64 tick_duration_sec  # [s] time this tick took (serial exchanges included); above
                           # control_period_sec = overrun
string control_mode        # "velocity" or "current"
uint8 drive_mode           # DRIVE_MODE_* after this tick
uint8 tick_action          # TICK_*
bool lqr_active            # the velocity RUN LQR+FF correction was applied this tick
float64 shaped_linear      # [m/s] chassis command after the acceleration limit and taper
float64 shaped_angular     # [rad/s] (REP-103: counter-clockwise positive)
bool command_sent          # the tick's command (drive, stop or safety stop) was handled for both
                           # wheels without a failed write. NOT proof that a frame went out: while
                           # a wheel stays stopped, DdtMotorLib skips re-sending the stop frame for
                           # stop_resend_interval_ms and still reports success (then that wheel's
                           # feedback_new is false and roundtrip_ms is NaN). false when a write
                           # failed, and on an idle tick unless that tick made a safety stop (the
                           # actuation gate closed, or a stop-fault retry); an idle feedback
                           # refresh is not a command
bool stop_frame            # the tick's command was a stop frame (target 0)

DriveControlWheelSample left
DriveControlWheelSample right
