# Robot-wide emergency stop state, published latched on /emergency_stop.
#
# Publisher:   operation_manager (derived from GPIO controllability)
# Subscribers: drive_component, shot_component, esc_motor_control
#
# QoS contract: reliable + transient_local + keep-last(1); published on every
# controllability evaluation (each GPIO update plus a 1 s heartbeat timer).
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
string reason           # human-readable cause, e.g. "pin 27 is false; ";
                        # "released" when active=false
