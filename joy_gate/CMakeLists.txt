cmake_minimum_required(VERSION 3.8)
project(joy_gate)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# find dependencies
find_package(ament_cmake_auto REQUIRED)
ament_auto_find_build_dependencies()

# Create library for component first
ament_auto_add_library(joy_gate_component SHARED
  src/joy_gate_component.cpp
)

# Create the executable and link with the component library
ament_auto_add_executable(joy_gate_node
  src/joy_gate_node.cpp
)
target_link_libraries(joy_gate_node joy_gate_component)

# Register the component
rclcpp_components_register_node(joy_gate_component
  PLUGIN "joy_gate::JoyGateComponent"
  EXECUTABLE joy_gate_component_node
)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  list(APPEND AMENT_LINT_AUTO_EXCLUDE ament_cmake_uncrustify)
  ament_lint_auto_find_test_dependencies()
endif()

ament_auto_package(INSTALL_TO_SHARE launch config)