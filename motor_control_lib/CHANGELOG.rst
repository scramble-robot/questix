^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
Changelog for package motor_control_lib
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

2.1.0 (2026-07-23)
------------------
* chore: remove unused legacy motor apps (`#123 <https://github.com/scramble-robot/questix/issues/123>`_)
* Contributors: Akihisa Nagata

2.0.1 (2026-07-22)
------------------
* fix: drain DDT serial output with tcdrain (`#116 <https://github.com/scramble-robot/questix/issues/116>`_)
* fix: reject non-finite control inputs (`#114 <https://github.com/scramble-robot/questix/issues/114>`_)
* fix: remove 50ms blocking sleep from ddt velocity send path (`#113 <https://github.com/scramble-robot/questix/issues/113>`_)
* Contributors: Akihisa Nagata, Yuichiroh Kobayashi

2.0.0 (2026-07-16)
------------------
* chore: unify package versions to 2.0.0 (`#108 <https://github.com/scramble-robot/questix/issues/108>`_)
* test: add feetech modbus protocol unit tests (`#104 <https://github.com/scramble-robot/questix/issues/104>`_)
* test: add ddt current-loop pi unit tests (`#103 <https://github.com/scramble-robot/questix/issues/103>`_)
* test: add ddt protocol pack/parse unit tests (`#102 <https://github.com/scramble-robot/questix/issues/102>`_)
* feat: add servo gui tool for calibration (`#76 <https://github.com/scramble-robot/questix/issues/76>`_)
* fix: resolve repository audit defects and harden ci checks (`#75 <https://github.com/scramble-robot/questix/issues/75>`_)
* fix: add brake on stop parameter for improved motor control
* fix: correct byte order in sendMotorVelocity function for proper protocol compliance
* fix: rename pan parameters to tilt in configuration and implementation (`#71 <https://github.com/scramble-robot/questix/issues/71>`_)
* fix: harden current-mode PI state handling (`#66 <https://github.com/scramble-robot/questix/issues/66>`_)
* feat: add current motor mode (`#57 <https://github.com/scramble-robot/questix/issues/57>`_)
* fix: fix ci fail (`#41 <https://github.com/scramble-robot/questix/issues/41>`_)
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
