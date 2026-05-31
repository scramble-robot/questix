# Questix Agent Guide

## Project overview

- Questix is a repository for robot control and ISO image builds targeting ROS 2 Jazzy on Ubuntu 24.04.
- The repository contains a mix of C++ ROS 2 packages, launch/config files, Ansible assets, systemd units, and the FastAPI-based `robot_manager`.

## Environment baseline

- AMD64 development environment: Ubuntu 24.04 + ROS 2 Jazzy.
- ARM64 Raspberry Pi 5 robotics kit: Ubuntu 24.04 + ROS 2 Jazzy.
- WSL and desktop environments are useful for reading, editing, static checks, and non-hardware tests.
- Raspberry Pi 5 hardware validation is authoritative for GPIO, UART, I2C, SPI, systemd, robot startup, and controller integration.

## Main directories

- `motor_control_lib/`: Shared library for motor control.
- `motor_control_app/`: ROS 2 nodes and components for drive, shot, single DDT, and related motor-control applications.
- `joy_controller/`, `uart_joy_driver/`, `joy_gate/`, `gpio_reader/`: Input, gating, and GPIO-related packages.
- `operation_manager/`: Operational state management.
- `launcher/`: Integrated entry point for ROS launch files. The ROS package name is `questix_launcher`.
- `description_launch/`: URDF, RViz, and xacro assets.
- `ansible/`, `scripts/`, `systemd/`: OS setup, ISO build tooling, and resident services.
- `scripts/robot_manager/`: FastAPI web management UI.

## Pre-work checks

- Always verify consistency across `package.xml`, `CMakeLists.txt`, `launch/`, and `config/` before and after changes.
- Do not assume directory names always match ROS package names. For example, `launcher/` maps to the ROS package name `questix_launcher`.
- Hardware-dependent code is likely impossible to validate fully without the physical robot or target hardware.

## C++ / ROS 2 implementation policy

- Use C++17 unless an existing package explicitly specifies a different standard.
- Follow `.clang-format`.
- Prefer `ament_cmake_auto` for ROS 2 packages.
- For component implementations, keep `rclcpp_components_register_nodes` and `RCLCPP_COMPONENTS_REGISTER_NODE` entries consistent, including registration names and class names.
- Update YAML parameters, launch arguments, and in-node `declare_parameter` / `get_parameter` usage together.

## Command safety

- Do not run ISO builds, QEMU tests, package installation, permission changes, systemd commands, or hardware-facing commands unless explicitly requested.
- Do not run destructive commands such as `rm -rf`, broad `chmod`, or broad `chown`.
- Explain the expected impact before changing Ansible, shell scripts, systemd units, UART/GPIO behavior, or ISO build behavior.
- Treat `systemd/questix_robot*`, `scripts/build-iso.sh`, and `ansible/playbooks/*.yaml` with extra care because they can have significant effects on real hardware or the OS.

## Validation commands

The following commands are standard validation candidates. Whether they can run depends on the local environment, including ROS 2 availability, Ansible/lint tooling, hardware access, and OS permissions. Hardware-dependent behavior still requires real robot/Raspberry Pi validation.

- `git diff --check`
- `colcon build --symlink-install` (run from the workspace root)
- `colcon test` (run from the workspace root)
- For Ansible changes: `make test-ansible`
- For Ansible/YAML changes: `yamllint ansible/`
- For GitHub Actions changes: `yamllint .github/workflows/` and `actionlint` if available.

## Cross-reference caution

- When changing package names, launch-file references to `find-pkg-share`, or dependency package names, perform a cross-package search within this repository and update all related references.
