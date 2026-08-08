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

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  list(APPEND AMENT_LINT_AUTO_EXCLUDE ament_cmake_cpplint ament_cmake_uncrustify)
  ament_lint_auto_find_test_dependencies()

  ament_auto_add_gtest(test_shot_angle test/test_shot_angle.cpp)
  ament_auto_add_gtest(test_shot_auto_start test/test_shot_auto_start.cpp)
  ament_auto_add_gtest(test_drive_watchdog test/test_drive_watchdog.cpp)
  ament_auto_add_gtest(test_drive_control_tick test/test_drive_control_tick.cpp)
  ament_auto_add_gtest(test_control_core test/test_control_core.cpp)
  ament_target_dependencies(test_control_core motor_control_lib)
  ament_auto_add_gtest(test_drive_param_policy test/test_drive_param_policy.cpp)
  target_link_libraries(test_drive_param_policy drive_component)
  ament_target_dependencies(test_drive_param_policy motor_control_lib)
  ament_auto_add_gtest(test_drive_slew test/test_drive_slew.cpp)
  ament_auto_add_gtest(test_odometry_integrator test/test_odometry_integrator.cpp)
  ament_auto_add_gtest(test_lifecycle_auto_start test/test_lifecycle_auto_start.cpp)
  ament_auto_add_gtest(test_motor_status_msg test/test_motor_status_msg.cpp)
  ament_target_dependencies(test_motor_status_msg motor_control_lib)

  ament_auto_add_gtest(test_ddt_feedback_format test/test_ddt_feedback_format.cpp)
endif()

ament_auto_package(INSTALL_TO_SHARE config launch)
