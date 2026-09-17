cmake_minimum_required(VERSION 3.16)
project(questix_blockly)

find_package(ament_cmake_auto REQUIRED)
ament_auto_find_build_dependencies()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
ament_auto_add_library(questix_control SHARED src/control_bridge.cpp)

install(PROGRAMS scripts/bridge.py scripts/drive_sim.py
  DESTINATION lib/${PROJECT_NAME})
install(FILES scripts/differential.py DESTINATION lib/${PROJECT_NAME})
# npm is an explicit frontend build step, never a network operation in colcon.
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/web/dist/index.html")
  install(DIRECTORY web/dist/ DESTINATION share/${PROJECT_NAME}/web)
else()
  message(STATUS "Blockly web assets absent: run npm ci && npm run build in questix_blockly/web, then rebuild this package")
endif()

if(BUILD_TESTING)
  find_package(ament_cmake_pytest REQUIRED)
  ament_add_pytest_test(control_mode test/test_control_mode.py
    # ROS_DOMAIN_ID is a scalar; appending to an inherited value produces e.g. 0:78.
    ENV ROS_DOMAIN_ID=78
    APPEND_ENV PYTHONPATH=${CMAKE_CURRENT_SOURCE_DIR}/scripts
    TIMEOUT 30)
  ament_add_pytest_test(differential test/test_differential.py
    APPEND_ENV PYTHONPATH=${CMAKE_CURRENT_SOURCE_DIR}/scripts TIMEOUT 30)
endif()

ament_auto_package(INSTALL_TO_SHARE launch config)
