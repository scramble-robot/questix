^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
Changelog for package gpio_reader
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

2.0.1 (2026-07-22)
------------------
* Version bump only for package gpio_reader

2.0.0 (2026-07-16)
------------------
* chore: unify package versions to 2.0.0 (`#108 <https://github.com/scramble-robot/questix/issues/108>`_)
* fix: resolve repository audit defects and harden ci checks (`#75 <https://github.com/scramble-robot/questix/issues/75>`_)
* fix: improve launch parameter consistency after controller profiles (`#48 <https://github.com/scramble-robot/questix/issues/48>`_)
* fix: fix launch files and parameters for consistency and clarity (`#45 <https://github.com/scramble-robot/questix/issues/45>`_)
* fix: fix ci fail (`#41 <https://github.com/scramble-robot/questix/issues/41>`_)
* feat: Ubuntu 24.04 / ROS 2 Jazzy 前提のベースラインへ統一 (`#39 <https://github.com/scramble-robot/questix/issues/39>`_)
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
* Contributors: Akihisa Nagata
