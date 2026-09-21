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
  src/ddt_current_pi.cpp
  src/ddt_motor_lib.cpp
  src/ddt_protocol.cpp
  src/differential_drive.cpp
  src/feetech_protocol.cpp
  src/motor_manager.cpp
  src/servo_control.cpp
)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  list(APPEND AMENT_LINT_AUTO_EXCLUDE
    ament_cmake_cpplint
    ament_cmake_uncrustify)
  ament_lint_auto_find_test_dependencies()

  ament_auto_add_gtest(test_ddt_protocol test/test_ddt_protocol.cpp)
  ament_auto_add_gtest(test_ddt_current_pi test/test_ddt_current_pi.cpp)
  ament_auto_add_gtest(test_drive_stop_gate test/test_drive_stop_gate.cpp)
  ament_auto_add_gtest(test_drive_mode_fsm test/test_drive_mode_fsm.cpp)
  ament_auto_add_gtest(test_wheel_observer test/test_wheel_observer.cpp)
  ament_auto_add_gtest(test_wheel_velocity_lqr test/test_wheel_velocity_lqr.cpp)
  ament_auto_add_gtest(test_differential_kinematics test/test_differential_kinematics.cpp)
  ament_auto_add_gtest(test_feetech_protocol test/test_feetech_protocol.cpp)
endif()

ament_auto_package(INSTALL_TO_SHARE)
