# Robot-wide emergency stop state, published latched on /emergency_stop.
#
# The emergency stop (L1), a safety function: the physical E-stop circuit (GPIO5) only. The
# AutoReferee's defeat is not an emergency stop (it is the referee's vote for /motion_permission).
#
# Publisher:   operation_manager's EmergencyStopManager (source "operation_manager")
# Subscribers: drive_component, shot_component, esc_motor_control, QUESTiX LAB bridge
#
# QoS contract: reliable + transient_local + keep-last(1); published on every
# evaluation (each GPIO update plus a 100 ms timer).
#
# active=true  -> emergency stop engaged; each subscriber performs its own stop
# active=false -> released; subscribers resume accepting commands, motors stay
#                 stopped until the next operator command (auto recovery)
#
# See questix_msgs/README.md for the full topic contract and per-subscriber
# recovery semantics.

std_msgs/Header header  # stamp = evaluation time; frame_id unused ("")
bool active             # true = emergency stop engaged
string source           # origin identifier, e.g. "operation_manager"
string reason           # human-readable cause, e.g. "pin 5 is true, expected false; ";
                        # "released" when active=false
