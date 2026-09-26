^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
Changelog for package web_joy_driver
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Forthcoming
-----------
* feat: browser/smartphone virtual controller publishing sensor_msgs/Joy over WebSocket
* feat: relay a sensor_msgs/CompressedImage camera topic to the page and show it between the sticks
* feat: one operator at a time (later devices are refused and view read-only, may ask for a hand-over);
  any device may press 止める, which also stops a QUESTiX LAB run and roller via the lab bridge
* feat: show 「教材が走らせています」 from /twist_arbiter/status and the robot name in the header
* fix: close a wrong or missing token with 4401 so the page shows its auth screen
* fix: camera off by default; the camera panel appears only once a frame arrived
* fix: 44 px touch targets, no keyboard mode on touch-only devices, meters only in the phone footer
