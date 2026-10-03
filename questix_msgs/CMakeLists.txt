cmake_minimum_required(VERSION 3.8)
project(questix_msgs)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# Interface packages use plain ament_cmake + rosidl instead of the
# ament_cmake_auto pattern used by the node packages in this repository.
find_package(ament_cmake REQUIRED)
find_package(rosidl_default_generators REQUIRED)
find_package(builtin_interfaces REQUIRED)
find_package(std_msgs REQUIRED)

rosidl_generate_interfaces(${PROJECT_NAME}
  "msg/ActuationAuthority.msg"
  "msg/DriveControlSample.msg"
  "msg/DriveControlWheelSample.msg"
  "msg/DriveStatus.msg"
  "msg/EmergencyStop.msg"
  "msg/MotorFeedback.msg"
  DEPENDENCIES builtin_interfaces std_msgs
)

ament_export_dependencies(rosidl_default_runtime)

ament_package()
