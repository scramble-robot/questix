// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#pragma once
#include <filesystem>
#include <string>
#include <utility>

#include "questix_pwm_guard/core.hpp"
namespace questix_pwm_guard {
struct HardwareConfig {
  std::filesystem::path root{"/sys/class/pwm"};
  std::string of_node_suffix{"/rp1/pwm@98000"};
  std::filesystem::path owner_file{"/run/questix_pwm_guard/owner"};
  std::filesystem::path boot_id_file{"/proc/sys/kernel/random/boot_id"};
  int channel{1};
  int period_ns{20000000};
};
class SysfsOutput : public Output {
public:
  explicit SysfsOutput(HardwareConfig config = {}) : config_(std::move(config)) {}
  bool initialize(bool recovery_only = false);
  bool write_pulse(int us) override;
  bool check() override;
  int error() const override { return error_; }
  const std::filesystem::path& chip() const { return chip_; }
  // Never unexport in destructor: exported enabled duty=0 is the Low-hold contract.
private:
  bool put(const std::string& name, const std::string& value);
  std::string get(const std::string& name) const;
  HardwareConfig config_;
  std::filesystem::path chip_;
  std::filesystem::path channel_;
  int error_{0};
  bool initialized_{false};
  int expected_us_{0};
};
}  // namespace questix_pwm_guard
