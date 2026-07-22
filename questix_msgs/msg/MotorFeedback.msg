# Per-motor feedback decoded from the DDT M0602C Protocol 1 response frame.
#
# Publishers:  single_ddt_motor (standalone, /single_ddt_motor_feedback);
#              embedded as left/right inside DriveStatus (drive_component,
#              joy_axis_drive).
#
# Wire fields are big-endian (high, low); decoding is centralized in
# motor_control_lib/ddt_protocol. See questix_msgs/README.md for the full
# topic contract.

# Firmware-reported control mode (feedback DATA[1]).
uint8 MODE_CURRENT_LOOP=1
uint8 MODE_VELOCITY_LOOP=2

std_msgs/Header header  # stamp = receipt time of the last valid feedback frame.
                        # stamp == 0 -> no feedback received yet (every field
                        # except motor_id/target_rpm is 0). frame_id unused ("").
uint8 motor_id          # DDT motor ID (frame DATA[0])
uint8 mode              # firmware control mode (DATA[1]); see MODE_* constants
int16 current_raw       # torque current raw (DATA[2..3], signed):
                        # -32767..32767 <-> -8..+8 A
float32 current_amp     # current_raw * 8.0 / 32767.0 [A]
int16 velocity_rpm      # measured wheel speed [RPM] (DATA[4..5], signed)
int16 target_rpm        # last commanded target [RPM] (clamped to max_motor_rpm)
uint16 position_raw     # rotor position (DATA[6..7]): 0..32767 <-> 0..360 deg
uint8 temperature       # [deg C] CURRENTLY ALWAYS 0: requires DDT Protocol 2
                        # (0x74), not yet implemented. The field is kept so the
                        # interface does not change when Protocol 2 lands.
uint8 fault_code        # DATA[8]; 0 = no fault, nonzero = firmware fault bits
