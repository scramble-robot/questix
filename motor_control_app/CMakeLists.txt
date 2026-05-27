cmake_minimum_required(VERSION 3.8)
project(motor_control_app)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# find dependencies
find_package(ament_cmake_auto REQUIRED)
find_package(motor_control_lib REQUIRED)  # Manual find for local library
ament_auto_find_build_dependencies()

# Unified motor control node (コメントアウト)
# add_executable(unified_motor_control_node src/unified_motor_control_node.cpp)
# target_include_directories(unified_motor_control_node PUBLIC
#   $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
#   $<INSTALL_INTERFACE:include>
# )
# ament_target_dependencies(unified_motor_control_node
#   rclcpp
#   std_msgs
#   geometry_msgs
#   sensor_msgs
#   motor_control_lib
# )

# Simple test node
ament_auto_add_executable(simple_test_node src/simple_test_node.cpp)
ament_target_dependencies(simple_test_node motor_control_lib)

# Simple motor app
ament_auto_add_executable(simple_motor_app src/simple_motor_app.cpp)

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

# Unified Motor App (using MotorManager)
ament_auto_add_executable(unified_motor_app src/unified_motor_app.cpp)
ament_target_dependencies(unified_motor_app motor_control_lib)

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

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  list(APPEND AMENT_LINT_AUTO_EXCLUDE ament_cmake_cpplint ament_cmake_uncrustify)
  ament_lint_auto_find_test_dependencies()
endif()

ament_auto_package(INSTALL_TO_SHARE config launch)
