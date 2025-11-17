^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
Changelog for package shr_launcher
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

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
* feat: add launch files and scripts for SHR Core system components
* Contributors: Akihisa Nagata, asa-naki
