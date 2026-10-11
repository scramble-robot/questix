// Copyright 2026 scramble-robot
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.
//
// DdtMotorLib in current mode against a simulated wheel, with no motor and no hardware: a pseudo
// terminal stands in for /dev/ttyACM0 and a subclass answers each current frame like an M0602C
// would, from a one-wheel model (J dω/dt = Kt i - friction). Each frame is one 20 ms control tick:
// the answer reports the speed after the previous tick's current has acted, then the new current
// applies. The library's control clock (PI dt, guard time) is the same simulated clock. The model
// values are estimates (Kt 0.44 Nm/A from the spec sheet, a lifted wheel of about 4.7e-4 kg·m², a 6
// kg robot on the floor); they check that the guard acts, not the tuning.
#include <gtest/gtest.h>
#include <pty.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "motor_control_lib/ddt_motor_lib.hpp"
#include "motor_control_lib/ddt_protocol.hpp"
#include "motor_control_lib/differential_drive.hpp"

namespace {

using motor_control_lib::ControlMode;
using motor_control_lib::DdtMotorLib;
using motor_control_lib::ddt_current_pi::GuardTrip;
namespace pi = motor_control_lib::ddt_current_pi;

constexpr double kTickSec = 0.02;
constexpr double kKt = 0.44;  // [Nm/A] M0602C spec sheet
constexpr double kRpmPerRadPerSec = 60.0 / (2.0 * M_PI);

struct WheelModel {
  double inertia;      // [kg m^2]
  double coulomb_amp;  // [A] friction expressed as the current that balances it
  double viscous_amp_per_rpm;
};

constexpr WheelModel kLifted{4.7e-4, 0.08, 3.6e-4};
constexpr WheelModel kFloor6kg{3.0 * 0.05 * 0.05 + 4.7e-4, 0.15, 3.6e-4};

class SimulatedWheelLib : public DdtMotorLib {
public:
  using DdtMotorLib::DdtMotorLib;

  // How the simulated firmware takes a Protocol 3 mode frame.
  enum class ModeFrames { kSpec, kLegacy, kNever };

  int master_fd{-1};
  bool answer{true};
  ModeFrames mode_frames{ModeFrames::kSpec};
  uint8_t mode{0x02};  // the reported mode: the power-on velocity loop until switched
  WheelModel model{kLifted};
  double speed_rpm{0.0};  // physical speed, positive = the direction of a positive current
  double peak_abs_rpm{0.0};
  int nonzero_in_velocity_mode{0};

protected:
  ssize_t writeSerial(const void* data, size_t size) override {
    const auto* bytes = static_cast<const uint8_t*>(data);
    if (size == 10 && bytes[1] == 0xA0) {
      const std::vector<uint8_t> payload(bytes, bytes + 9);
      const bool legacy = bytes[9] == motor_control_lib::ddt_protocol::crc8Maxim(payload);
      if (mode_frames == ModeFrames::kSpec && (bytes[9] == 0x01 || bytes[9] == 0x02)) {
        mode = bytes[9];
      } else if (mode_frames == ModeFrames::kLegacy && legacy &&
                 (bytes[8] == 0x01 || bytes[8] == 0x02)) {
        mode = bytes[8];
      }
      return static_cast<ssize_t>(size);
    }
    if (size == 10 && bytes[1] == 0x64) {
      if (mode != 0x01) {
        // A velocity-loop motor takes the value as a speed target: this is what a current
        // command does to a motor that did not switch. Count every nonzero one.
        const auto value = static_cast<int16_t>((static_cast<uint16_t>(bytes[2]) << 8) | bytes[3]);
        nonzero_in_velocity_mode += value != 0 ? 1 : 0;
      }
      // The previous current acts for one tick, then the motor answers with the speed.
      advance(applied_amp_, kTickSec);
      sim_time_ += std::chrono::milliseconds(20);
      const auto raw = static_cast<int16_t>((static_cast<uint16_t>(bytes[2]) << 8) | bytes[3]);
      applied_amp_ = pi::rawToAmp(raw);
      if (answer && master_fd >= 0) {
        const auto speed = static_cast<int16_t>(std::lround(speed_rpm));
        std::vector<uint8_t> frame = {bytes[0],
                                      mode,
                                      bytes[2],
                                      bytes[3],
                                      static_cast<uint8_t>((static_cast<uint16_t>(speed) >> 8)),
                                      static_cast<uint8_t>(static_cast<uint16_t>(speed) & 0xFF),
                                      0,
                                      0,
                                      0};
        frame.push_back(motor_control_lib::ddt_protocol::crc8Maxim(frame));
        if (write(master_fd, frame.data(), frame.size()) != static_cast<ssize_t>(frame.size())) {
          return -1;
        }
      }
    }
    return static_cast<ssize_t>(size);
  }

  std::chrono::steady_clock::time_point controlNow() const override { return sim_time_; }

private:
  void advance(double amp, double seconds) {
    const double gain = kKt / model.inertia * kRpmPerRadPerSec;  // [rpm/s per A]
    constexpr int kSub = 20;
    const double h = seconds / kSub;
    for (int i = 0; i < kSub; ++i) {
      double friction = model.viscous_amp_per_rpm * speed_rpm;
      if (std::abs(speed_rpm) > 0.5) {
        friction += std::copysign(model.coulomb_amp, speed_rpm);
      } else {
        friction += std::clamp(amp, -model.coulomb_amp, model.coulomb_amp);  // stiction
      }
      speed_rpm += h * gain * (amp - friction);
    }
    peak_abs_rpm = std::max(peak_abs_rpm, std::abs(speed_rpm));
  }

  double applied_amp_{0.0};
  std::chrono::steady_clock::time_point sim_time_{std::chrono::seconds(1000)};
};

constexpr int kLeft = 4;

class DdtCurrentGuard : public ::testing::Test {
protected:
  void SetUp() override {
    char name[256] = {};
    ASSERT_EQ(openpty(&master_, &slave_, name, nullptr, nullptr), 0);
    lib_ = std::make_shared<SimulatedWheelLib>(name, 115200);
    lib_->master_fd = master_;
    lib_->setMaxRpm(475);
    lib_->setStopResendIntervalMs(0);
    lib_->setResponseTimeoutMs(5);
    ASSERT_TRUE(lib_->initialize());
  }
  void TearDown() override {
    lib_.reset();
    close(slave_);
    close(master_);
  }

  void start(double kp, double ki, bool invert, const WheelModel& model) {
    lib_->model = model;
    lib_->setCurrentControlParams(kp, ki, /*max_current_amp=*/1.0, /*integral_limit_amp=*/0.3);
    lib_->setCurrentInvertMeasured(invert);
    ASSERT_TRUE(lib_->initializeMotor(kLeft, ControlMode::Current));
  }

  // Runs `ticks` control ticks at a constant reference; returns the tick the guard tripped at, or
  // -1.
  int run(int rpm_ref, int ticks) {
    for (int i = 0; i < ticks; ++i) {
      EXPECT_TRUE(lib_->setMotorVelocity(kLeft, rpm_ref));
      if (lib_->currentGuardTrip(kLeft) != GuardTrip::kNone) {
        return i;
      }
    }
    return -1;
  }

  int16_t lastCurrentRaw() {
    DdtMotorLib::MotorTransactionStats stats;
    EXPECT_TRUE(lib_->getMotorTransactionStats(kLeft, stats));
    return stats.last_current_raw_sent;
  }

  int master_{-1};
  int slave_{-1};
  std::shared_ptr<SimulatedWheelLib> lib_;
};

// The default gains with the right sign on a lifted wheel: the wheel follows, nothing trips.
TEST_F(DdtCurrentGuard, LiftedWheelWithTheDefaultGainsFollowsWithoutTripping) {
  start(0.0015, 0.004, /*invert=*/false, kLifted);
  EXPECT_EQ(run(100, 150), -1);  // 3 s
  EXPECT_NEAR(lib_->speed_rpm, 100.0, 10.0);
  EXPECT_TRUE(lib_->isHealthy());
}

// A wrong sign (positive feedback) on a lifted wheel: stopped within a few ticks, at low speed, and
// latched at 0 A.
TEST_F(DdtCurrentGuard, WrongSignOnALiftedWheelTripsAndLatchesAtZero) {
  start(0.0015, 0.004, /*invert=*/true, kLifted);
  const int tripped_at = run(100, 100);
  ASSERT_GE(tripped_at, 0);
  EXPECT_LT(tripped_at, 25);  // within 0.5 s
  EXPECT_EQ(lib_->currentGuardTrip(kLeft), GuardTrip::kAccelAgainstCurrent);
  EXPECT_LT(lib_->peak_abs_rpm, 100.0);
  EXPECT_EQ(lastCurrentRaw(), 0);
  EXPECT_FALSE(lib_->isHealthy());

  // Latched: further commands send 0 A only.
  EXPECT_TRUE(lib_->setMotorVelocity(kLeft, 100));
  EXPECT_EQ(lastCurrentRaw(), 0);

  // The operator fixes the sign: the latch clears and the wheel follows.
  lib_->setCurrentInvertMeasured(false);
  EXPECT_EQ(lib_->currentGuardTrip(kLeft), GuardTrip::kNone);
  EXPECT_TRUE(lib_->isHealthy());
  EXPECT_EQ(run(100, 150), -1);
  EXPECT_NEAR(lib_->speed_rpm, 100.0, 10.0);
}

// Floor-sized gains on a lifted wheel (or a robot picked up while driving): stopped.
TEST_F(DdtCurrentGuard, FloorGainsOnALiftedWheelTrip) {
  start(0.02, 0.05, /*invert=*/false, kLifted);
  const int tripped_at = run(100, 100);
  ASSERT_GE(tripped_at, 0);
  EXPECT_LT(tripped_at, 30);
  EXPECT_EQ(lastCurrentRaw(), 0);
}

TEST_F(DdtCurrentGuard, PickedUpWhileDrivingWithFloorGainsTrips) {
  start(0.02, 0.05, /*invert=*/false, kFloor6kg);
  EXPECT_EQ(run(100, 100), -1);  // on the floor these gains are fine
  EXPECT_NEAR(lib_->speed_rpm, 100.0, 10.0);
  lib_->model = kLifted;  // picked up
  const int tripped_at = run(100, 100);
  ASSERT_GE(tripped_at, 0);
  EXPECT_LT(tripped_at, 30);
}

// A wrong sign on the floor is stopped as well.
TEST_F(DdtCurrentGuard, WrongSignOnTheFloorTrips) {
  start(0.02, 0.05, /*invert=*/true, kFloor6kg);
  ASSERT_GE(run(100, 100), 0);
  EXPECT_EQ(lib_->currentGuardTrip(kLeft), GuardTrip::kAccelAgainstCurrent);
}

// Lost answers: after kCurrentMaxConsecutiveTimeouts silent exchanges only 0 A goes out, and the
// loop resumes when answers come back (no latch: this is not the controller's fault).
TEST_F(DdtCurrentGuard, LostFeedbackSendsZeroUntilAnswersReturn) {
  start(0.0015, 0.004, /*invert=*/false, kLifted);
  ASSERT_EQ(run(100, 50), -1);
  ASSERT_NE(lastCurrentRaw(), 0);
  lib_->answer = false;
  for (int i = 0; i < DdtMotorLib::kCurrentMaxConsecutiveTimeouts; ++i) {
    ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 100));
  }
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 100));
  EXPECT_EQ(lastCurrentRaw(), 0);
  lib_->answer = true;
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 100));  // this exchange is answered again
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 100));
  EXPECT_NE(lastCurrentRaw(), 0);
  EXPECT_EQ(lib_->currentGuardTrip(kLeft), GuardTrip::kNone);
}

// Friction feedforward: with the model's own friction, the steady error is smaller than with the
// integral alone after the same short time.
TEST_F(DdtCurrentGuard, FrictionFeedforwardShortensTheApproach) {
  start(0.0015, 0.004, /*invert=*/false, kLifted);
  run(100, 15);  // 0.3 s
  const double without_ff = std::abs(100.0 - lib_->speed_rpm);
  lib_->speed_rpm = 0.0;
  lib_->setCurrentFeedforward(kLifted.coulomb_amp, kLifted.viscous_amp_per_rpm);
  ASSERT_TRUE(lib_->initializeMotor(kLeft, ControlMode::Current));
  EXPECT_EQ(run(100, 15), -1);
  const double with_ff = std::abs(100.0 - lib_->speed_rpm);
  EXPECT_LT(with_ff, without_ff);
}

// A motor that takes the legacy mode frame layout (mode in DATA[8], CRC in DATA[9]) is switched by
// the fallback, and current mode starts.
TEST_F(DdtCurrentGuard, LegacyModeFrameIsTriedWhenTheSpecFrameDoesNotSwitch) {
  lib_->mode_frames = SimulatedWheelLib::ModeFrames::kLegacy;
  start(0.0015, 0.004, /*invert=*/false, kLifted);
  EXPECT_EQ(lib_->mode, 0x01);
  EXPECT_EQ(run(100, 50), -1);
  EXPECT_EQ(lib_->nonzero_in_velocity_mode, 0);
}

// A motor that never reports the current loop: current mode does not start, and no current
// command ever reaches it (it would read the raw value as a speed target).
TEST_F(DdtCurrentGuard, MotorThatStaysInTheVelocityLoopIsRefused) {
  lib_->mode_frames = SimulatedWheelLib::ModeFrames::kNever;
  lib_->setCurrentControlParams(0.0015, 0.004, 1.0, 0.3);
  EXPECT_FALSE(lib_->initializeMotor(kLeft, ControlMode::Current));
  EXPECT_EQ(lib_->nonzero_in_velocity_mode, 0);
}

// The motor falls back to the velocity loop while driving (e.g. its power was cycled): latched at
// zero at once.
TEST_F(DdtCurrentGuard, ModeChangeWhileDrivingTripsAtZero) {
  start(0.0015, 0.004, /*invert=*/false, kLifted);
  ASSERT_EQ(run(100, 25), -1);
  lib_->mode = 0x02;
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 100));  // this answer reports the velocity loop
  EXPECT_EQ(lib_->currentGuardTrip(kLeft), GuardTrip::kModeMismatch);
  EXPECT_EQ(lastCurrentRaw(), 0);
  const int before = lib_->nonzero_in_velocity_mode;
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 100));
  EXPECT_EQ(lib_->nonzero_in_velocity_mode, before);
}

// The drive treats a tripped wheel as unhealthy, so drive_component stops both wheels.
TEST_F(DdtCurrentGuard, DifferentialDriveReportsATrippedWheelAsUnhealthy) {
  start(0.0015, 0.004, /*invert=*/true, kLifted);
  ASSERT_TRUE(lib_->initializeMotor(5, ControlMode::Current));  // the other wheel exists too
  motor_control_lib::DifferentialDrive drive(lib_, kLeft, 5, 0.05, 0.5);
  EXPECT_TRUE(drive.isHealthy());
  ASSERT_GE(run(100, 100), 0);
  EXPECT_FALSE(drive.isHealthy());
}

}  // namespace
