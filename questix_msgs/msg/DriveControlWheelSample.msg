# One wheel of a DriveControlSample: what drive_component's control tick commanded this wheel
# and what came back from its DDT M0602C in that tick. Diagnostic only (see DriveControlSample).
#
# Sign convention: every rpm / current / position field is the motor's own (native) sign, exactly
# as on the wire. drive_component mounts the wheels mirrored, so moving forward is POSITIVE on the
# left wheel and NEGATIVE on the right wheel. Nothing here is converted to a chassis frame.

# --- what the tick asked for ---------------------------------------------------------------------
int32 ref_rpm              # [rpm] the wheel target before any feedback correction (slew-limited
                           # twist -> kinematics -> rounded to the nearest integer).
int32 command_rpm          # [rpm] the speed command handed to DdtMotorLib this tick (after the
                           # velocity RUN LQR correction when it is active; 0 on a stop frame).
                           # DdtMotorLib clamps it to max_motor_rpm before sending. In current
                           # mode this is the reference of the host PI loop, not a wire value.
int16 command_current_raw  # current mode: the last current command DdtMotorLib sent this motor
                           # successfully (-32767..32767 <-> -8..+8 A; equals what the driver
                           # holds when this tick sent nothing). Velocity mode: always 0.

# --- what came back --------------------------------------------------------------------------
bool feedback_new          # true when THIS tick's serial exchanges received a new valid feedback
                           # frame from this motor. false: the wire fields below are the previous
                           # frame repeated (do not count them twice in an analysis).
uint32 feedback_count      # valid feedback frames received from this motor since the library was
                           # created (wraps at 2^32). Consecutive samples with the same count carry
                           # the same frame. Exchanges outside a tick (the E-stop callback's
                           # immediate stop, configure/activate) also count, so a step of 2 or more
                           # with a contiguous seq is not a lost sample.
builtin_interfaces/Time feedback_stamp  # receipt time of the last valid feedback frame (node
                           # clock); 0 = never received. Not the tick time (see header.stamp).
float32 roundtrip_ms       # [ms] write start -> feedback frame complete, for this motor's last
                           # exchange in this tick. NaN when this tick had no exchange with this
                           # motor or the response timed out.
bool response_timeout      # true when this motor's last exchange in this tick got no valid
                           # response within serial_response_timeout_ms.

# --- the wire fields of the last valid feedback frame (Protocol 1 response, see MotorFeedback) ---
uint8 mode                 # firmware control mode (DATA[1]): 1 = current loop, 2 = velocity loop
int16 velocity_rpm_raw     # [rpm] measured speed, UNFILTERED integer wire value (DATA[4..5])
uint16 position_raw        # rotor position (DATA[6..7]): 0..32767 <-> 0..360 deg. The wire value
                           # moves in steps of 1 LSB (all eight residues mod 8 occur); the sensor's
                           # true resolution is not known. Observed on one robot (2026-10-05):
                           # unchanged (+-1 LSB) across a motor power cycle without moving the
                           # wheel, one wrap per turn while the motor drives it, but a hand-turned
                           # ~90 deg read as only ~9-17 deg (unexplained). Do not treat it as a
                           # calibrated absolute angle.
int16 current_raw          # torque current (DATA[2..3]): -32767..32767 <-> -8..+8 A
uint8 fault_code           # DATA[8]; 0 = no fault
