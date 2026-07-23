^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
Changelog for package questix_launcher
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

3.1.0 (2026-07-23)
------------------
* feat: publish wheel odometry and odom->base_link tf from drive component (`#132 <https://github.com/scramble-robot/questix/issues/132>`_)
* refactor: unify drive_component config to launcher single source (`#133 <https://github.com/scramble-robot/questix/issues/133>`_)
* Contributors: Akihisa Nagata

3.0.0 (2026-07-23)
------------------
* refactor: remove deprecated string status topics and esc bool mirror (`#130 <https://github.com/scramble-robot/questix/issues/130>`_)
* Contributors: Akihisa Nagata

2.2.0 (2026-07-23)
------------------
* refactor: migrate string status topics to typed messages (`#127 <https://github.com/scramble-robot/questix/issues/127>`_)
* Contributors: Akihisa Nagata

2.1.0 (2026-07-23)
------------------
* feat: link drive, shot, and esc components to /emergency_stop (`#125 <https://github.com/scramble-robot/questix/issues/125>`_)
* Contributors: Akihisa Nagata

2.0.1 (2026-07-22)
------------------
* feat: convert drive_component to a lifecycle node (`#118 <https://github.com/scramble-robot/questix/issues/118>`_)
* fix: remove 50ms blocking sleep from ddt velocity send path (`#113 <https://github.com/scramble-robot/questix/issues/113>`_)
* fix: add command timeout watchdog and fault stop to drive_component (`#111 <https://github.com/scramble-robot/questix/issues/111>`_)
* Contributors: Akihisa Nagata

2.0.0 (2026-07-16)
------------------
* chore: unify package versions to 2.0.0 (`#108 <https://github.com/scramble-robot/questix/issues/108>`_)
* fix: resolve repository audit defects and harden ci checks (`#75 <https://github.com/scramble-robot/questix/issues/75>`_)
* fix: add brake on stop parameter for improved motor control
* fix: questix_launcher の esc 依存名を修正 (`#64 <https://github.com/scramble-robot/questix/issues/64>`_)
* fix: remove unnecessary dependency on servo_control_ros2 from package.xml (`#63 <https://github.com/scramble-robot/questix/issues/63>`_)
* feat: add current motor mode (`#57 <https://github.com/scramble-robot/questix/issues/57>`_)
* fix(launcher): restore fire_button=5 and add per-controller YAML profiles (`#47 <https://github.com/scramble-robot/questix/issues/47>`_)
* fix: fix launch files and parameters for consistency and clarity (`#45 <https://github.com/scramble-robot/questix/issues/45>`_)
* feat: Ubuntu 24.04 / ROS 2 Jazzy 前提のベースラインへ統一 (`#39 <https://github.com/scramble-robot/questix/issues/39>`_)
* fix: correct angular input ratio and update launch arguments for joy controller (`#37 <https://github.com/scramble-robot/questix/issues/37>`_)
* feat: add controller type configuration for UART and DualShock support
* feat: add UART Switch2 joy driver and stabilize robot control path (`#30 <https://github.com/scramble-robot/questix/issues/30>`_)
* merge feature test in 0411 (`#29 <https://github.com/scramble-robot/questix/issues/29>`_)
* refactor: rename project from shr to Questix and add auto_start script (`#28 <https://github.com/scramble-robot/questix/issues/28>`_)
* Contributors: Akihisa Nagata, Yuichiroh Kobayashi

1.0.0 (2025-11-17)
------------------
* refactor: add ref system and delete unused packages (`#21 <https://github.com/asa-naki/questy/issues/21>`_)
  * feat: Add GPIO Reader and Safety Gate packages for Raspberry Pi 5
  * feat: add joy_gate and operation_manager components
  * feat: update CMakeLists.txt to install launch and config files, and remove deprecated launch files
  * feat: update package.xml
  * feat: add joy_topic and debug_mode parameters to joy_controller launch and component
  * feat: update joy_topic parameter handling across multiple components
  * feat: add dual stick support with configuration and launch files (`#20 <https://github.com/asa-naki/questy/issues/20>`_)
  * feat: update dual stick parameters for improved control and debugging
  * feat: update joy subscription topic from '/joy_gated' to '/joy'
  ---------
* feat: update 0920-0922 (`#14 <https://github.com/asa-naki/questy/issues/14>`_)
  * feat: add pan limit and change cmd angle
  * Fix/high cmd (`#13 <https://github.com/asa-naki/questy/issues/13>`_)
  * feat: add command rate limiting and improve command handling
  * feat: update launch files for motor control components and add shot component
  * feat: update addtional setting of test/0926 (`#12 <https://github.com/asa-naki/questy/issues/12>`_)
  * feat: update ESC motor control parameters and add configuration files for drive and shot components
  * add :setting
  ---------
  ---------
  ---------
* feat: update launcher for robot moving (`#9 <https://github.com/asa-naki/questy/issues/9>`_)
  * feat: add LiDAR configuration files and update launch files for joystick and LiDAR integration
  * add shot joy control
  * fix: delete unused publisher and timer callback (`#8 <https://github.com/asa-naki/questy/issues/8>`_)
  * feat: update ESC motor control configuration and launch files for joystick integration
  * fix: remove unused dependencies from dependency.repos
  ---------
* refactor: remove script installation from CMakeLists.txt
* refactor: remove symbolic link creation from CMakeLists.txt and update servo configuration in launch file
* feat: update servo control launch files and integrate into main launch configuration
* refactor: remove unused launch files
* feat: add launch files and scripts for Questix system components
* Contributors: Akihisa Nagata, asa-naki
