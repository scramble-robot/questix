cmake_minimum_required(VERSION 3.8)
project(questix_launcher)

# Default to C++17
if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 17)
endif()

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# Find dependencies
find_package(ament_cmake_auto REQUIRED)
ament_auto_find_build_dependencies()

# Install documentation
install(FILES
  README.md
  DESTINATION share/${PROJECT_NAME}
)


if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  find_package(ament_cmake_pytest REQUIRED)
  # the following line skips the linter which checks for copyrights
  # comment the line when a copyright and license is added to all source files
  set(ament_cmake_copyright_FOUND TRUE)
  # the following line skips cpplint (only works in a git repo)
  # comment the line when this package is in a git repo and when
  # a copyright and license is added to all source files
  set(ament_cmake_cpplint_FOUND TRUE)
  ament_lint_auto_find_test_dependencies()

  ament_add_pytest_test(test_gpio_safety_launch test/test_gpio_safety_launch.py
    ENV "QUESTIX_SOURCE_ROOT=${CMAKE_CURRENT_SOURCE_DIR}/.."
  )
  ament_add_pytest_test(test_gpio_safety_runtime test/test_gpio_safety_runtime.py
    TIMEOUT 90
  )
endif()

# INSTALL_TO_SHARE + colcon --symlink-install で config/launch が symlink になり、
# ソース YAML の編集が再ビルド無しで実機に反映される（旧 install(DIRECTORY) は
# コピーになるため、編集済みソースと実行時 config が乖離する事故があった）。
ament_auto_package(INSTALL_TO_SHARE launch config)
