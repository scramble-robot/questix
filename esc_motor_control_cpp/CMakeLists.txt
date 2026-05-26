cmake_minimum_required(VERSION 3.8)
project(esc_motor_control_cpp)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# find dependencies
find_package(ament_cmake_auto REQUIRED)
ament_auto_find_build_dependencies()

# --- PWM backend detection ---
# pigpio
find_library(PIGPIO_LIB pigpio)
if(PIGPIO_LIB)
  message(STATUS "pigpio found: ${PIGPIO_LIB}")
  set(HAVE_PIGPIO TRUE)
else()
  message(STATUS "pigpio NOT found – pigpio backend disabled")
  set(HAVE_PIGPIO FALSE)
endif()

# lgpio
find_library(LGPIO_LIB lgpio)
if(LGPIO_LIB)
  message(STATUS "lgpio found: ${LGPIO_LIB}")
  set(HAVE_LGPIO TRUE)
else()
  message(STATUS "lgpio NOT found – lgpio backend disabled")
  set(HAVE_LGPIO FALSE)
endif()

# Component library
ament_auto_add_library(esc_motor_control_component SHARED
  src/esc_motor_control_component.cpp
)

target_compile_definitions(esc_motor_control_component
  PRIVATE "ESC_MOTOR_CONTROL_CPP_BUILDING_DLL")

if(HAVE_PIGPIO)
  target_compile_definitions(esc_motor_control_component PRIVATE HAVE_PIGPIO)
  target_link_libraries(esc_motor_control_component ${PIGPIO_LIB})
endif()

if(HAVE_LGPIO)
  target_compile_definitions(esc_motor_control_component PRIVATE HAVE_LGPIO)
  target_link_libraries(esc_motor_control_component ${LGPIO_LIB})
endif()

# Register the component
rclcpp_components_register_nodes(esc_motor_control_component
  "esc_motor_control_cpp::EscMotorControlComponent")

# Standalone executable
ament_auto_add_executable(esc_motor_control_node
  src/esc_motor_control_node.cpp
)
target_link_libraries(esc_motor_control_node esc_motor_control_component)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  list(APPEND AMENT_LINT_AUTO_EXCLUDE ament_cmake_uncrustify)
  ament_lint_auto_find_test_dependencies()
endif()

ament_auto_package(INSTALL_TO_SHARE launch config)
