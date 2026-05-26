cmake_minimum_required(VERSION 3.8)
project(motor_control_lib)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# find dependencies
find_package(ament_cmake_auto REQUIRED)
ament_auto_find_build_dependencies()

# Create shared library with implementation
ament_auto_add_library(motor_control_lib SHARED
  src/ddt_motor_lib.cpp
  src/differential_drive.cpp
  src/motor_manager.cpp
  src/servo_control.cpp
)

# Create servo control node executable
ament_auto_add_executable(servo_control_node src/servo_control_node.cpp)
target_link_libraries(servo_control_node motor_control_lib)

# Create servo test node executable
ament_auto_add_executable(servo_test_node src/servo_test_node.cpp)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  list(APPEND AMENT_LINT_AUTO_EXCLUDE
    ament_cmake_cpplint
    ament_cmake_uncrustify)
  ament_lint_auto_find_test_dependencies()
endif()

ament_auto_package(INSTALL_TO_SHARE)
