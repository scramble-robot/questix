cmake_minimum_required(VERSION 3.8)
project(uart_joy_driver)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# find dependencies
find_package(ament_cmake_auto REQUIRED)
ament_auto_find_build_dependencies()

# Create the component library
ament_auto_add_library(uart_joy_driver_component SHARED
  src/uart_joy_driver_component.cpp
)

target_compile_definitions(uart_joy_driver_component
  PRIVATE "UART_JOY_DRIVER_BUILDING_DLL")

# Register the component
rclcpp_components_register_nodes(uart_joy_driver_component
  "uart_joy_driver::UartJoyDriverComponent")

# Create the executable
ament_auto_add_executable(uart_joy_driver_node
  src/uart_joy_driver_node.cpp
)

target_link_libraries(uart_joy_driver_node uart_joy_driver_component)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  list(APPEND AMENT_LINT_AUTO_EXCLUDE ament_cmake_cpplint ament_cmake_uncrustify)
  ament_lint_auto_find_test_dependencies()
endif()

ament_auto_package(INSTALL_TO_SHARE launch config)
