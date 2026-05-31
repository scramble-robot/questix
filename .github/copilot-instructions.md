# Copilot Instructions for QUESTiX

## Precedence

- Follow `AGENTS.md` first when it exists.
- Use this file as lightweight Copilot completion guidance.
- When instructions conflict, prefer the more specific file for the edited path.

## Baseline

- Target Ubuntu 24.04 LTS and ROS 2 Jazzy.
- Use C++17 unless an existing package explicitly specifies a different standard.
- Keep AMD64 development and ARM64 Raspberry Pi 5 robotics-kit assumptions aligned unless the user explicitly requests otherwise.

## C++ / ROS 2 completions

- Follow `.clang-format`.
- Match existing `rclcpp` logging style, node names, topic names, parameter names, YAML, and launch conventions.
- When changing ROS 2 packages, keep `package.xml`, `CMakeLists.txt`, component registration, launch files, config files, and runtime parameters consistent.

## CMake / install guidance

- Prefer the existing CMake style used by the package being edited.
- For packages using `ament_cmake_auto`, confirm existing share-resource installation patterns such as `ament_auto_package(INSTALL_TO_SHARE launch config)` before changing them.
- For packages not using that pattern, use the package's existing CMake style, such as `install(DIRECTORY launch config DESTINATION share/${PROJECT_NAME})`.

## Launch and config completions

- `launcher/launch/questix_core.launch.xml` is the integrated launch entry point.
- The ROS package name for `launcher/` is `questix_launcher`.
- Verify `find-pkg-share`, package names, launch arguments, YAML parameters, and systemd / robot_manager references together when changing launch or package paths.
- Treat `ENABLE_LIDAR`, `ENABLE_SHOT`, `ENABLE_DRIVE`, `ENABLE_GPIO_REF`, `ENABLE_RVIZ`, and `CONTROLLER_TYPE` as launch-flow and robot-startup related variables.

## High-caution areas

- Do not generate broad edits to Ansible, shell scripts, systemd units, ISO build scripts, GPIO, UART, or robot startup behavior unless explicitly requested.
- When completing code in these areas, preserve existing behavior and explain the expected validation.
