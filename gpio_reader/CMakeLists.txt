cmake_minimum_required(VERSION 3.8)
project(gpio_reader)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# find dependencies
find_package(ament_cmake_auto REQUIRED)
ament_auto_find_build_dependencies()

# Create the component library
ament_auto_add_library(gpio_reader_component SHARED
  src/gpio_reader_component.cpp
)

target_compile_definitions(gpio_reader_component
  PRIVATE "GPIO_READER_BUILDING_DLL")

# Link with gpiod library for Raspberry Pi 5
target_link_libraries(gpio_reader_component gpiod)

# Register the component
rclcpp_components_register_nodes(gpio_reader_component
  "gpio_reader::GpioReaderComponent")

# Create the executable
ament_auto_add_executable(gpio_reader_node
  src/gpio_reader_node.cpp
)

target_link_libraries(gpio_reader_node gpio_reader_component)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  list(APPEND AMENT_LINT_AUTO_EXCLUDE ament_cmake_uncrustify)
  ament_lint_auto_find_test_dependencies()
endif()

ament_auto_package(INSTALL_TO_SHARE launch config)
