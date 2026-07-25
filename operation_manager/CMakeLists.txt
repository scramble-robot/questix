cmake_minimum_required(VERSION 3.5)
project(operation_manager)

find_package(ament_cmake_auto REQUIRED)
ament_auto_find_build_dependencies()

ament_auto_add_library(operation_manager_safety_logic SHARED
  src/gpio_safety_evaluator.cpp
)

ament_auto_add_library(operation_manager_component SHARED
  src/operation_manager_component.cpp
)
target_link_libraries(operation_manager_component operation_manager_safety_logic)

rclcpp_components_register_nodes(operation_manager_component
  "operation_manager::OperationManagerComponent")

ament_auto_add_executable(operation_manager_node
  src/operation_manager_node.cpp
)

target_link_libraries(operation_manager_node operation_manager_component)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  list(APPEND AMENT_LINT_AUTO_EXCLUDE ament_cmake_uncrustify)
  ament_lint_auto_find_test_dependencies()

  ament_auto_add_gtest(test_gpio_safety_evaluator test/test_gpio_safety_evaluator.cpp)
  target_link_libraries(test_gpio_safety_evaluator operation_manager_safety_logic)

  ament_auto_add_gtest(test_operation_manager_node test/test_operation_manager_node.cpp)
  target_link_libraries(test_operation_manager_node operation_manager_component)
endif()

ament_auto_package(INSTALL_TO_SHARE launch config)
