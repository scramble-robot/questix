cmake_minimum_required(VERSION 3.8)
project(command_arbiter)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

find_package(ament_cmake_auto REQUIRED)
ament_auto_find_build_dependencies()

# The rule shared by the drive and the launcher is header-only
# (include/command_arbiter/source_selector.hpp); each mechanism is its own component with no
# shared state, also run as its own process (the generated *_node executables).
ament_auto_add_library(drive_arbiter_component SHARED
  src/drive_arbiter_component.cpp
)
rclcpp_components_register_node(drive_arbiter_component
  PLUGIN "command_arbiter::DriveArbiterComponent"
  EXECUTABLE drive_arbiter_node
)
ament_auto_add_library(launcher_arbiter_component SHARED
  src/launcher_arbiter_component.cpp
)
rclcpp_components_register_node(launcher_arbiter_component
  PLUGIN "command_arbiter::LauncherArbiterComponent"
  EXECUTABLE launcher_arbiter_node
)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  list(APPEND AMENT_LINT_AUTO_EXCLUDE ament_cmake_cpplint ament_cmake_uncrustify)
  ament_lint_auto_find_test_dependencies()

  ament_auto_add_gtest(test_source_selector test/test_source_selector.cpp)
  ament_auto_add_gtest(test_drive_arbiter_node test/test_drive_arbiter_node.cpp)
  target_link_libraries(test_drive_arbiter_node drive_arbiter_component)
  ament_auto_add_gtest(test_launcher_flow test/test_launcher_flow.cpp)
  ament_auto_add_gtest(test_launcher_arbiter_node test/test_launcher_arbiter_node.cpp)
  target_link_libraries(test_launcher_arbiter_node launcher_arbiter_component)
endif()

ament_auto_package(INSTALL_TO_SHARE launch config)
