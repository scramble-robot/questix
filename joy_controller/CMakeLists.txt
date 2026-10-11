cmake_minimum_required(VERSION 3.8)
project(joy_controller)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# find dependencies
find_package(ament_cmake_auto REQUIRED)
ament_auto_find_build_dependencies()

# Create the component library
ament_auto_add_library(joy_controller_component SHARED
  src/joy_controller_component.cpp
)

target_compile_definitions(joy_controller_component
  PRIVATE "JOY_CONTROLLER_BUILDING_DLL")

# Register the component
rclcpp_components_register_nodes(joy_controller_component
  "joy_controller::JoyControllerComponent")

# Create the dual stick component library
ament_auto_add_library(joy_controller_dual_stick_component SHARED
  src/joy_controller_dual_stick_component.cpp
)

target_compile_definitions(joy_controller_dual_stick_component
  PRIVATE "JOY_CONTROLLER_BUILDING_DLL")

# Register the dual stick component
rclcpp_components_register_nodes(joy_controller_dual_stick_component
  "joy_controller::JoyControllerDualStickComponent")

# The controller's launcher buttons as questix_msgs/LauncherCommand (joy_launcher)
ament_auto_add_library(joy_launcher_component SHARED
  src/joy_launcher_component.cpp
)
rclcpp_components_register_nodes(joy_launcher_component
  "joy_controller::JoyLauncherComponent")

ament_auto_add_executable(joy_launcher_node
  src/joy_launcher_node.cpp
)
target_link_libraries(joy_launcher_node joy_launcher_component)

# Create the executable
ament_auto_add_executable(joy_controller_node
  src/joy_controller_node.cpp
)

target_link_libraries(joy_controller_node joy_controller_component)

# Create the dual stick executable
ament_auto_add_executable(joy_controller_dual_stick_node
  src/joy_controller_dual_stick_node.cpp
)

target_link_libraries(joy_controller_dual_stick_node joy_controller_dual_stick_component)

if(BUILD_TESTING)
  ament_auto_add_gtest(test_launcher_mapping test/test_launcher_mapping.cpp)
  ament_auto_add_gtest(test_tilt_input test/test_tilt_input.cpp)
  find_package(ament_cmake_pytest REQUIRED)
  ament_add_pytest_test(test_launch_config_contract test/test_launch_config_contract.py)
  find_package(ament_lint_auto REQUIRED)
  list(APPEND AMENT_LINT_AUTO_EXCLUDE ament_cmake_cpplint ament_cmake_uncrustify)
  ament_lint_auto_find_test_dependencies()
endif()

ament_auto_package(INSTALL_TO_SHARE launch config)
