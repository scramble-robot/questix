^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
Changelog for package motor_control_app
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

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
* Feat/add joy drive (`#18 <https://github.com/asa-naki/questy/issues/18>`_)
  * feat: add Joy Axis Drive component and related launch/config files
  * update paramter
  ---------
* Feat/single ddt (`#16 <https://github.com/asa-naki/questy/issues/16>`_)
  * feat: add Single DDT Motor component and configuration files
  * add setting
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
* Contributors: Akihisa Nagata
