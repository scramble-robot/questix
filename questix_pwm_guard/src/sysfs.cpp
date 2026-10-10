// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include "questix_pwm_guard/sysfs.hpp"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <fstream>
#include <thread>
namespace questix_pwm_guard {
namespace fs = std::filesystem;
namespace {
std::string read_file(const fs::path& p) {
  std::ifstream f(p, std::ios::binary);
  if (!f) throw std::runtime_error("cannot read " + p.string());
  return std::string(std::istreambuf_iterator<char>(f), {});
}
bool write_file(const fs::path& p, const std::string& s, int& error) {
  int fd = open(p.c_str(), O_WRONLY | O_CLOEXEC | O_TRUNC);
  if (fd < 0) {
    error = -errno;
    return false;
  }
  ssize_t n;
  do {
    n = write(fd, s.data(), s.size());
  } while (n < 0 && errno == EINTR);
  error = n == ssize_t(s.size()) ? 0 : -(n < 0 ? errno : EIO);
  if (close(fd) < 0 && !error) error = -errno;
  return error == 0;
}
}  // namespace
std::string SysfsOutput::get(const std::string& name) const {
  auto s = read_file(channel_ / name);
  while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
  return s;
}
bool SysfsOutput::put(const std::string& name, const std::string& value) {
  return write_file(channel_ / name, value, error_);
}
bool SysfsOutput::initialize(bool recovery_only) {
  try {
    if (config_.channel != 1 || config_.period_ns != 20000000 ||
        config_.of_node_suffix != "/rp1/pwm@98000")
      throw std::runtime_error("unsupported pin/channel/period");
    for (const auto& e : fs::directory_iterator(config_.root)) {
      if (e.path().filename().string().rfind("pwmchip", 0) != 0) continue;
      if (!fs::exists(e.path() / "device/of_node")) continue;
      auto node = fs::canonical(e.path() / "device/of_node").string();
      const auto& suffix = config_.of_node_suffix;
      if (node.size() < suffix.size() ||
          node.compare(node.size() - suffix.size(), suffix.size(), suffix) != 0)
        continue;
      auto compatible = read_file(e.path() / "device/of_node/compatible");
      if (compatible.find("raspberrypi,rp1-pwm") == std::string::npos) continue;
      if (!chip_.empty()) throw std::runtime_error("ambiguous PWM0 controller");
      chip_ = e.path();
    }
    if (chip_.empty() || std::stoi(read_file(chip_ / "npwm")) <= config_.channel)
      throw std::runtime_error("RP1 PWM0 channel unavailable");
    channel_ = chip_ / ("pwm" + std::to_string(config_.channel));
    bool existing = fs::exists(channel_);
    const std::string owner = fs::canonical(chip_ / "device/of_node").string() + "\n1\n20000000\n" +
                              read_file(config_.boot_id_file);
    if (existing) {
      int fd = open(config_.owner_file.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
      struct stat st {};
      if (fd < 0 || fstat(fd, &st) < 0 || !S_ISREG(st.st_mode) || st.st_uid != geteuid() ||
          (st.st_mode & 0022)) {
        if (fd >= 0) close(fd);
        throw std::runtime_error("unknown export owner");
      }
      char b[1024];
      auto n = read(fd, b, sizeof(b));
      close(fd);
      if (n < 0 || std::string(b, size_t(n)) != owner)
        throw std::runtime_error("export ownership mismatch");
    }
    if (!existing) {
      if (recovery_only) throw std::runtime_error("no exported output to recover");
      // Only a fresh kernel export can establish ownership. Never overwrite an existing marker.
      int marker = open(config_.owner_file.c_str(),
                        O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
      if (marker < 0) {
        error_ = -errno;
        return false;
      }
      auto n = write(marker, owner.data(), owner.size());
      bool saved = n == ssize_t(owner.size()) && fsync(marker) == 0;
      close(marker);
      if (!saved) {
        error_ = -EIO;
        return false;
      }
      if (!write_file(chip_ / "export", std::to_string(config_.channel), error_)) return false;
      for (int n = 0; n < 50 && !fs::exists(channel_ / "enable"); ++n)
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
      if (!fs::exists(channel_ / "enable")) throw std::runtime_error("export not ready");
    }
    // Existing state must match before any mutation. Inverse polarity duty=0 would be High.
    if (existing && (get("polarity") != "normal" ||
                     get("period") != std::to_string(config_.period_ns) || get("enable") != "1"))
      throw std::runtime_error("refusing unknown existing PWM state");
    if (!existing) {
      // Linux PWM core rejects all applies with period=0, including duty=0.
      // A fresh RP1 export starts disabled with zero duty. Refuse unexpected
      // state, establish a nonzero period, then prepare duty/polarity before enable.
      if (get("enable") != "0" || get("duty_cycle") != "0")
        throw std::runtime_error("unexpected fresh PWM state");
      if (!put("period", std::to_string(config_.period_ns)) || !put("duty_cycle", "0") ||
          !put("polarity", "normal") || !put("enable", "1"))
        return false;
    } else if (!put("duty_cycle", "0")) {
      return false;
    }
    initialized_ = true;
    return write_pulse(0);
  } catch (const std::exception&) {
    error_ = -EINVAL;
    return false;
  }
}
bool SysfsOutput::write_pulse(int us) {
  if (!initialized_) {
    error_ = -ENODEV;
    return false;
  }
  if (us != 0 && (us < 500 || us > 2500)) {
    error_ = -EINVAL;
    return false;
  }
  try {
    if (get("period") != std::to_string(config_.period_ns) || get("polarity") != "normal" ||
        get("enable") != "1") {
      error_ = -ESTALE;
      return false;
    }
    if (!put("duty_cycle", std::to_string(us * 1000))) return false;
    expected_us_ = us;
    return check();
  } catch (const std::exception&) {
    error_ = -EIO;
    return false;
  }
}
bool SysfsOutput::check() {
  if (!initialized_) {
    error_ = -ENODEV;
    return false;
  }
  try {
    if (get("period") != std::to_string(config_.period_ns) || get("polarity") != "normal" ||
        get("enable") != "1" || get("duty_cycle") != std::to_string(expected_us_ * 1000)) {
      error_ = -ESTALE;
      return false;
    }
    error_ = 0;
    return true;
  } catch (const std::exception&) {
    error_ = -EIO;
    return false;
  }
}
}  // namespace questix_pwm_guard
