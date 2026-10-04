cmake_minimum_required(VERSION 3.8)
project(questix_safety)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

find_package(ament_cmake_auto REQUIRED)
ament_auto_find_build_dependencies()

# Header-only: include/questix_safety/{estop_check,emergency_stop_monitor}.hpp.

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  list(APPEND AMENT_LINT_AUTO_EXCLUDE
    ament_cmake_cpplint
    ament_cmake_uncrustify)
  ament_lint_auto_find_test_dependencies()

  ament_auto_add_gtest(test_estop_check test/test_estop_check.cpp)
  find_package(rclcpp_lifecycle REQUIRED)
  ament_auto_add_gtest(test_emergency_stop_monitor test/test_emergency_stop_monitor.cpp)
  ament_target_dependencies(test_emergency_stop_monitor rclcpp_lifecycle)
endif()

ament_auto_package()
