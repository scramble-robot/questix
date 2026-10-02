cmake_minimum_required(VERSION 3.8)
project(twist_arbiter)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

find_package(ament_cmake_auto REQUIRED)
ament_auto_find_build_dependencies()

ament_auto_add_library(twist_arbiter_component SHARED
  src/twist_arbiter_component.cpp
)

ament_auto_add_executable(twist_arbiter_node
  src/twist_arbiter_node.cpp
)
target_link_libraries(twist_arbiter_node twist_arbiter_component)

rclcpp_components_register_node(twist_arbiter_component
  PLUGIN "twist_arbiter::TwistArbiterComponent"
  EXECUTABLE twist_arbiter_component_node
)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  list(APPEND AMENT_LINT_AUTO_EXCLUDE ament_cmake_uncrustify)
  ament_lint_auto_find_test_dependencies()

  ament_auto_add_gtest(test_arbiter_logic test/test_arbiter_logic.cpp)
endif()

ament_auto_package(INSTALL_TO_SHARE launch config)
