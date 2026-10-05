cmake_minimum_required(VERSION 3.8)
project(motor_control_app)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# find dependencies
find_package(ament_cmake_auto REQUIRED)
find_package(motor_control_lib REQUIRED)  # Manual find for local library
ament_auto_find_build_dependencies()

# Drive Component (as a shared library for component loading)
ament_auto_add_library(drive_component SHARED
  src/drive_component.cpp
)
ament_target_dependencies(drive_component motor_control_lib)

# Register the component
rclcpp_components_register_nodes(drive_component "motor_control_app::DriveComponent")

# Single DDT Motor Component (as a shared library for component loading)
ament_auto_add_library(single_ddt_motor_component SHARED
  src/single_ddt_motor_component.cpp
)
ament_target_dependencies(single_ddt_motor_component motor_control_lib)

# Register the single DDT motor component
rclcpp_components_register_nodes(single_ddt_motor_component "motor_control_app::SingleDdtMotorComponent")

# Single DDT Motor Component Node (standalone executable)
ament_auto_add_executable(single_ddt_motor_node src/single_ddt_motor_node.cpp)
target_link_libraries(single_ddt_motor_node single_ddt_motor_component)
ament_target_dependencies(single_ddt_motor_node motor_control_lib)

# Joy Axis Drive Component (as a shared library for component loading)
ament_auto_add_library(joy_axis_drive_component SHARED
  src/joy_axis_drive_component.cpp
)
ament_target_dependencies(joy_axis_drive_component motor_control_lib)

# Register the joy axis drive component
rclcpp_components_register_nodes(joy_axis_drive_component "motor_control_app::JoyAxisDriveComponent")

# Joy Axis Drive Component Node (standalone executable)
ament_auto_add_executable(joy_axis_drive_node src/joy_axis_drive_node.cpp)
target_link_libraries(joy_axis_drive_node joy_axis_drive_component)
ament_target_dependencies(joy_axis_drive_node motor_control_lib)

# Drive Component Node (standalone executable)
ament_auto_add_executable(drive_component_node src/drive_component_node.cpp)
target_link_libraries(drive_component_node drive_component)
ament_target_dependencies(drive_component_node motor_control_lib)

# Shot Component (as a shared library for component loading)
ament_auto_add_library(shot_component SHARED
  src/shot_component.cpp
)
ament_target_dependencies(shot_component motor_control_lib)

# Register the shot component
rclcpp_components_register_nodes(shot_component "motor_control_app::ShotComponent")

# Shot Component Node (standalone executable)
ament_auto_add_executable(shot_component_node src/shot_component_node.cpp)
target_link_libraries(shot_component_node shot_component)
ament_target_dependencies(shot_component_node motor_control_lib)

# DDT Feedback Monitor (read-only CLI, subscribes to typed status topics)
ament_auto_add_executable(ddt_feedback_monitor src/ddt_feedback_monitor_node.cpp)

# Precompiled headers: every target here is a single translation unit that
# parses the rclcpp / rclcpp_lifecycle headers, which dominates build time.
# Parse them once per flavour and reuse the result. GCC rejects a PCH built with
# different -fPIC/-fPIE settings, so the shared libraries (PIC) and the
# executables (default, PIE) each get their own host. A rejected PCH falls back
# to normal parsing with a -Winvalid-pch warning, so it never changes the
# result, only the speed. Disable with -DMOTOR_CONTROL_APP_USE_PCH=OFF.
option(MOTOR_CONTROL_APP_USE_PCH "Use precompiled rclcpp headers" ON)
if(MOTOR_CONTROL_APP_USE_PCH)
  set(motor_control_app_pch_headers
    <rclcpp/rclcpp.hpp>
    <rclcpp_components/register_node_macro.hpp>
    <rclcpp_lifecycle/lifecycle_node.hpp>
  )
  set(motor_control_app_pch_source "${CMAKE_CURRENT_BINARY_DIR}/motor_control_app_pch.cpp")
  file(WRITE "${motor_control_app_pch_source}" "// PCH host, intentionally empty\n")

  add_library(motor_control_app_pch_shared OBJECT "${motor_control_app_pch_source}")
  set_target_properties(motor_control_app_pch_shared PROPERTIES POSITION_INDEPENDENT_CODE ON)
  add_library(motor_control_app_pch_exec OBJECT "${motor_control_app_pch_source}")
  foreach(pch_host motor_control_app_pch_shared motor_control_app_pch_exec)
    ament_target_dependencies(${pch_host} rclcpp rclcpp_components rclcpp_lifecycle)
    target_precompile_headers(${pch_host} PRIVATE ${motor_control_app_pch_headers})
  endforeach()

  foreach(target drive_component single_ddt_motor_component joy_axis_drive_component
      shot_component)
    target_precompile_headers(${target} REUSE_FROM motor_control_app_pch_shared)
  endforeach()
  foreach(target drive_component_node single_ddt_motor_node joy_axis_drive_node
      shot_component_node ddt_feedback_monitor)
    target_precompile_headers(${target} REUSE_FROM motor_control_app_pch_exec)
  endforeach()
endif()

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  list(APPEND AMENT_LINT_AUTO_EXCLUDE ament_cmake_cpplint ament_cmake_uncrustify)
  ament_lint_auto_find_test_dependencies()

  ament_auto_add_gtest(test_shot_angle test/test_shot_angle.cpp)
  ament_auto_add_gtest(test_tilt_input test/test_tilt_input.cpp)
  ament_auto_add_gtest(test_shot_auto_start test/test_shot_auto_start.cpp)
  ament_auto_add_gtest(test_shot_lab_logic test/test_shot_lab_logic.cpp)
  ament_auto_add_gtest(test_drive_watchdog test/test_drive_watchdog.cpp)
  ament_auto_add_gtest(test_drive_control_tick test/test_drive_control_tick.cpp)
  ament_auto_add_gtest(test_actuation_gate test/test_actuation_gate.cpp)
  ament_auto_add_gtest(test_control_core test/test_control_core.cpp)
  ament_target_dependencies(test_control_core motor_control_lib)
  ament_auto_add_gtest(test_drive_param_policy test/test_drive_param_policy.cpp)
  target_link_libraries(test_drive_param_policy drive_component)
  ament_target_dependencies(test_drive_param_policy motor_control_lib)
  if(MOTOR_CONTROL_APP_USE_PCH)
    target_precompile_headers(test_drive_param_policy REUSE_FROM motor_control_app_pch_exec)
  endif()
  ament_auto_add_gtest(test_drive_slew test/test_drive_slew.cpp)
  ament_auto_add_gtest(test_odometry_integrator test/test_odometry_integrator.cpp)
  ament_auto_add_gtest(test_lifecycle_auto_start test/test_lifecycle_auto_start.cpp)
  ament_auto_add_gtest(test_motor_status_msg test/test_motor_status_msg.cpp)
  ament_target_dependencies(test_motor_status_msg motor_control_lib)
  ament_auto_add_gtest(test_drive_control_sample_msg test/test_drive_control_sample_msg.cpp)
  ament_target_dependencies(test_drive_control_sample_msg motor_control_lib)

  ament_auto_add_gtest(test_ddt_feedback_format test/test_ddt_feedback_format.cpp)

  # The real DriveComponent on a fake motor (pseudo terminal), loaded with the integrated
  # hardware YAML and an operator profile from this source tree, as questix_core does.
  ament_auto_add_gtest(test_drive_component_node test/test_drive_component_node.cpp TIMEOUT 120)
  target_link_libraries(test_drive_component_node drive_component util)
  ament_target_dependencies(test_drive_component_node motor_control_lib)
  target_compile_definitions(test_drive_component_node PRIVATE
    QUESTIX_DRIVE_HARDWARE_YAML="${CMAKE_CURRENT_SOURCE_DIR}/../launcher/config/drive_component.yaml"
    QUESTIX_DRIVE_CONTROL_YAML="${CMAKE_CURRENT_SOURCE_DIR}/../questix_control_config/config/controls.dualshock.yaml")

  # The real ShotComponent on a fake servo bus (pseudo terminal): startup after an E-stop release
  # never blocks the executor (issue #175).
  ament_auto_add_gtest(test_shot_component_node test/test_shot_component_node.cpp TIMEOUT 120)
  target_link_libraries(test_shot_component_node shot_component util)
  ament_target_dependencies(test_shot_component_node motor_control_lib)
endif()

ament_auto_package(INSTALL_TO_SHARE config launch)
