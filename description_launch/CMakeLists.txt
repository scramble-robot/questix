cmake_minimum_required(VERSION 3.8)
project(description_launch)

find_package(ament_cmake REQUIRED)
find_package(ament_cmake_python REQUIRED)
find_package(ament_cmake_copyright REQUIRED)
find_package(ament_cmake_flake8 REQUIRED)
find_package(ament_cmake_pep257 REQUIRED)
find_package(ament_cmake_pytest REQUIRED)

ament_python_install_package(description_launch)

ament_cmake_copyright()
ament_cmake_flake8()
ament_cmake_pep257()
ament_cmake_pytest()

ament_package()