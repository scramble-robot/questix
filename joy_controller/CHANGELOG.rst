^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
Changelog for package joy_controller
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

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
* Refactor/controller (`#10 <https://github.com/asa-naki/questy/issues/10>`_)
  * Add motor control library with DDT motor support and differential drive functionality
  * feat: add servo
  * move motor_app
  * fix: update servo IDs in shot_config.yaml and enhance servo control with current position reading
  * fix: remove tilt servo references and adjust shot component logic for single servo control
  * fix: update drive component configuration and adjust servo communication parameters
  * Feat/joy pan (`#11 <https://github.com/asa-naki/questy/issues/11>`_)
  * fix: add pan control buttons and update current pan position handling
  * fix: rename pan control buttons to axes and update joyCallback logic for axis input
  * fix: consolidate pan control axis handling by renaming variables and updating logic
  * fix: update joy controller parameters for improved movement control and remove unused servo functionality
  * fix: update pan axis parameter and step size for improved control
  ---------
  ---------
* feat: update launcher for robot moving (`#9 <https://github.com/asa-naki/questy/issues/9>`_)
  * feat: add LiDAR configuration files and update launch files for joystick and LiDAR integration
  * add shot joy control
  * fix: delete unused publisher and timer callback (`#8 <https://github.com/asa-naki/questy/issues/8>`_)
  * feat: update ESC motor control configuration and launch files for joystick integration
  * fix: remove unused dependencies from dependency.repos
  ---------
* feat: add launch files and scripts for Questix system components
* Add joy_controller package with core functionality and configuration files
* Contributors: Akihisa Nagata, asa-naki
