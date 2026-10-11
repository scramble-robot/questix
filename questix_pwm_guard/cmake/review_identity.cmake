# Embed the reviewed source identity in every deployed ELF, forcing rebuild on source changes.
function(questix_review_identity target)
  find_package(Python3 REQUIRED COMPONENTS Interpreter)
  set(identity_tool "${CMAKE_CURRENT_SOURCE_DIR}/../questix_pwm_guard/deploy/review_manifest.py")
  execute_process(COMMAND "${Python3_EXECUTABLE}" -I "${identity_tool}" digest
    "${CMAKE_CURRENT_SOURCE_DIR}/.."
    OUTPUT_VARIABLE identity OUTPUT_STRIP_TRAILING_WHITESPACE
    RESULT_VARIABLE identity_result)
  if(NOT identity_result EQUAL 0)
    message(FATAL_ERROR "Cannot establish reviewed source identity")
  endif()
  # Reconfiguration follows changes in the review scope, including shared header dependencies.
  foreach(package questix_msgs questix_control_config questix_safety questix_pwm_guard esc_motor_control_cpp launcher)
    file(GLOB_RECURSE identity_inputs CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/../${package}/*")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${identity_inputs})
  endforeach()
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/../systemd/questix_robot_launcher.sh")
  set(marker "${CMAKE_CURRENT_BINARY_DIR}/${target}_review_identity.cpp")
  file(WRITE "${marker}" "extern \"C\" { __attribute__((used, visibility(\"default\"))) extern const char questix_review_identity_${target}[] = \"QUESTIX_RP1_REVIEW_V2:${identity}\"; }\n")
  target_sources(${target} PRIVATE "${marker}")
endfunction()
