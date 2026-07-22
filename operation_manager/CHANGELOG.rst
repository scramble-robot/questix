^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
Changelog for package operation_manager
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

2.0.1 (2026-07-22)
------------------
* Version bump only for package operation_manager

2.0.0 (2026-07-16)
------------------
* chore: unify package versions to 2.0.0 (`#108 <https://github.com/scramble-robot/questix/issues/108>`_)
* fix: resolve repository audit defects and harden ci checks (`#75 <https://github.com/scramble-robot/questix/issues/75>`_)
* feat: update licenses to MIT across all packages and add LICENSE file (`#46 <https://github.com/scramble-robot/questix/issues/46>`_)
* Contributors: Akihisa Nagata

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
* Contributors: Akihisa Nagata
