// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
#include <gtest/gtest.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <thread>

#include "questix_pwm_guard/sysfs.hpp"
namespace fs = std::filesystem;
namespace q = questix_pwm_guard;
// Test-only kernel constraint model. Never installed or linked into the daemon.
// Linux rejects every PWM apply with period=0, even a duty=0 update while disabled.
static std::atomic<bool> enforce_kernel_period{false};
extern "C" ssize_t __real_write(int fd, const void* buf, size_t count);
extern "C" ssize_t __wrap_write(int fd, const void* buf, size_t count) {
  if (enforce_kernel_period) {
    char path[4096];
    auto n = readlink(("/proc/self/fd/" + std::to_string(fd)).c_str(), path, sizeof(path));
    if (n > 0) {
      fs::path p(std::string(path, size_t(n)));
      if (p.filename() == "duty_cycle") {
        std::ifstream period(p.parent_path() / "period");
        int value = 0;
        period >> value;
        if (value == 0) {
          errno = EINVAL;
          return -1;
        }
      }
    }
  }
  return __real_write(fd, buf, count);
}
struct SysfsTest : testing::Test {
  fs::path base;
  q::HardwareConfig cfg;
  void SetUp() override {
    char name[] = "/tmp/questix-sysfs-XXXXXX";
    base = mkdtemp(name);
    cfg.root = base / "pwm";
    cfg.owner_file = base / "owner";
    cfg.boot_id_file = base / "boot";
    fs::create_directories(cfg.root / "pwmchip7/pwm1");
    fs::create_directories(cfg.root / "pwmchip7/device");
    fs::create_directories(base / "dt/rp1/pwm@98000");
    fs::create_directory_symlink(base / "dt/rp1/pwm@98000", cfg.root / "pwmchip7/device/of_node");
    put(base / "dt/rp1/pwm@98000/compatible", "raspberrypi,rp1-pwm");
    put(base / "boot", "boot-test\n");
    put(cfg.root / "pwmchip7/npwm", "4\n");
    put(channel() / "period", "20000000\n");
    put(channel() / "polarity", "normal\n");
    put(channel() / "enable", "1\n");
    put(channel() / "duty_cycle", "1800000\n");
  }
  void TearDown() override { fs::remove_all(base); }  // Only private mkdtemp fixture.
  fs::path channel() { return cfg.root / "pwmchip7/pwm1"; }
  void put(const fs::path& p, const std::string& v) { std::ofstream(p) << v; }
  std::string read(const fs::path& p) {
    std::ifstream f(p);
    return std::string(std::istreambuf_iterator<char>(f), {});
  }
  void own() {
    put(cfg.owner_file,
        fs::canonical(base / "dt/rp1/pwm@98000").string() + "\n1\n20000000\nboot-test\n");
    fs::permissions(cfg.owner_file, fs::perms::owner_read | fs::perms::owner_write);
  }
};
TEST_F(SysfsTest, UnknownOwnerIsRejectedWithoutMutation) {
  q::SysfsOutput o(cfg);
  EXPECT_FALSE(o.initialize());
  EXPECT_EQ(read(channel() / "duty_cycle"), "1800000\n");
}
TEST_F(SysfsTest, OwnedStateStartsLowAndHoldsExport) {
  own();
  {
    q::SysfsOutput o(cfg);
    ASSERT_TRUE(o.initialize());
    EXPECT_TRUE(o.write_pulse(1000));
    EXPECT_EQ(read(channel() / "duty_cycle"), "1000000");
    EXPECT_TRUE(o.write_pulse(0));
  }
  EXPECT_TRUE(fs::exists(channel()));
  EXPECT_EQ(read(channel() / "duty_cycle"), "0");
  EXPECT_EQ(read(channel() / "enable"), "1\n");
}
TEST_F(SysfsTest, InversePolarityCannotBeCalledLow) {
  own();
  put(channel() / "polarity", "inversed\n");
  q::SysfsOutput o(cfg);
  EXPECT_FALSE(o.initialize(true));
  EXPECT_EQ(read(channel() / "duty_cycle"), "1800000\n");
}
TEST_F(SysfsTest, DifferentBootOwnershipIsRejected) {
  own();
  put(base / "boot", "other-boot\n");
  q::SysfsOutput o(cfg);
  EXPECT_FALSE(o.initialize());
}
TEST_F(SysfsTest, MissingOfNodeOtherChipIsSkipped) {
  own();
  fs::create_directories(cfg.root / "pwmchip0/device");
  q::SysfsOutput o(cfg);
  EXPECT_TRUE(o.initialize());
}
TEST_F(SysfsTest, LowWriteFailureAndExternalStateChangeAreReported) {
  own();
  q::SysfsOutput o(cfg);
  ASSERT_TRUE(o.initialize());
  fs::remove(channel() / "duty_cycle");
  EXPECT_FALSE(o.write_pulse(0));
  put(channel() / "duty_cycle", "1000000");
  put(channel() / "enable", "0\n");
  EXPECT_FALSE(o.write_pulse(1000));
  EXPECT_EQ(o.error(), -ESTALE);
}
TEST_F(SysfsTest, AmbiguousPwm0IsRejected) {
  own();
  fs::create_directories(cfg.root / "pwmchip8/device");
  fs::create_directory_symlink(base / "dt/rp1/pwm@98000", cfg.root / "pwmchip8/device/of_node");
  q::SysfsOutput o(cfg);
  EXPECT_FALSE(o.initialize());
}

TEST_F(SysfsTest, FreshExportRecordsOwnerAndStartsLow) {
  enforce_kernel_period = true;
  fs::remove_all(channel());
  put(cfg.root / "pwmchip7/export", "");
  std::thread kernel([&] {
    for (int n = 0; n < 100 && read(cfg.root / "pwmchip7/export") != "1"; ++n)
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    fs::create_directories(channel());
    put(channel() / "duty_cycle", "0");
    put(channel() / "period", "0");
    put(channel() / "polarity", "normal");
    put(channel() / "enable", "0");
  });
  q::SysfsOutput o(cfg);
  const bool ok = o.initialize();
  kernel.join();
  enforce_kernel_period = false;
  ASSERT_TRUE(ok);
  EXPECT_TRUE(fs::exists(cfg.owner_file));
  EXPECT_EQ(read(channel() / "duty_cycle"), "0");
  EXPECT_EQ(read(channel() / "period"), "20000000");
  EXPECT_EQ(read(channel() / "enable"), "1");
}
TEST_F(SysfsTest, OwnershipSymlinkAndWorldWritableMarkerAreRejected) {
  own();
  fs::permissions(cfg.owner_file, fs::perms::others_write, fs::perm_options::add);
  q::SysfsOutput first(cfg);
  EXPECT_FALSE(first.initialize());
  fs::rename(cfg.owner_file, base / "old-owner");
  fs::create_symlink(base / "old-owner", cfg.owner_file);
  q::SysfsOutput second(cfg);
  EXPECT_FALSE(second.initialize());
}
