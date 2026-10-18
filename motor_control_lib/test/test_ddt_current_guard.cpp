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
//
// Each motor id has its own wheel. The clock advances one tick on each frame to the first motor
// (kLeft), so a test that drives two wheels commands kLeft then kRight once per tick, like
// drive_component. A motor can be silenced (no answers) or rebooted (it answers in the velocity
// loop again), and the clock can be moved on without any frame (a stalled host). Each answer
// reports the wheel's position (32767 = one turn, as ddt_protocol::kPositionRawPerTurn) and its
// speed; the reported speed can be delayed by whole ticks, as the real motor's is (Issue #222:
// 100-120 ms behind the position).
#include <gtest/gtest.h>
#include <pty.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "motor_control_lib/ddt_motor_lib.hpp"
#include "motor_control_lib/ddt_protocol.hpp"
#include "motor_control_lib/differential_drive.hpp"
#include "motor_control_lib/wheel_speed_estimator.hpp"

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

constexpr int kLeft = 4;
constexpr int kRight = 5;

struct Wheel {
  double speed_rpm{0.0};  // physical speed, positive = the direction of a positive current
  double position_turns{0.0};
  std::deque<double> reported_history;     // speeds at past answers (for report_delay_ticks)
  std::vector<double> true_rpm_at_answer;  // the physical speed at each answer
  double peak_abs_rpm{0.0};
  double applied_amp{0.0};
  std::vector<int16_t> currents;  // every current command value this motor received, in order
  int nonzero_in_velocity_mode{0};
};

class SimulatedWheelLib : public DdtMotorLib {
public:
  using DdtMotorLib::DdtMotorLib;

  // How the simulated firmware takes a Protocol 3 mode frame.
  enum class ModeFrames { kSpec, kLegacy, kNever };

  int master_fd{-1};
  bool answer{true};
  std::set<int> silent;    // motors that do not answer
  std::set<int> rebooted;  // motors that went back to the velocity loop on their own
  int fail_write_motor{-1};
  int fail_drain_motor{-1};
  int last_write_motor{-1};
  std::map<int, int> zero_attempts;
  ModeFrames mode_frames{ModeFrames::kSpec};
  int injected_position{-1};  // a CRC-valid but semantically invalid feedback position
  int report_delay_ticks{0};  // the reported speed lags the physical one by this many answers
  uint8_t mode{0x02};         // the reported mode: the power-on velocity loop until switched
  WheelModel model{kLifted};
  std::map<int, Wheel> wheels;
  // The left wheel (the one the single-wheel tests drive).
  Wheel& left() { return wheels[kLeft]; }
  int nonzeroInVelocityMode() {
    int n = 0;
    for (const auto& [id, w] : wheels) n += w.nonzero_in_velocity_mode;
    return n;
  }
  // Moves the clock (and the wheels) on without any frame: the host stalled.
  void stall(std::chrono::milliseconds duration) {
    for (auto& [id, w] : wheels)
      advance(w, w.applied_amp, std::chrono::duration<double>(duration).count());
    sim_time_ += duration;
  }

protected:
  ssize_t writeSerial(const void* data, size_t size) override {
    const auto* bytes = static_cast<const uint8_t*>(data);
    if (size == 10 && bytes[1] == 0xA0) {
      const std::vector<uint8_t> payload(bytes, bytes + 9);
      const bool legacy = bytes[9] == motor_control_lib::ddt_protocol::crc8Maxim(payload);
      if (mode_frames == ModeFrames::kSpec && (bytes[9] == 0x01 || bytes[9] == 0x02)) {
        mode = bytes[9];
        rebooted.erase(bytes[0]);
      } else if (mode_frames == ModeFrames::kLegacy && legacy &&
                 (bytes[8] == 0x01 || bytes[8] == 0x02)) {
        mode = bytes[8];
        rebooted.erase(bytes[0]);
      }
      return static_cast<ssize_t>(size);
    }
    if (size == 10 && bytes[1] == 0x64) {
      last_write_motor = bytes[0];
      if (bytes[2] == 0 && bytes[3] == 0) ++zero_attempts[bytes[0]];
      if (fail_write_motor == bytes[0]) return -1;
      Wheel& w = wheels[bytes[0]];
      const uint8_t reported_mode = rebooted.count(bytes[0]) != 0 ? 0x02 : mode;
      const auto raw = static_cast<int16_t>((static_cast<uint16_t>(bytes[2]) << 8) | bytes[3]);
      if (reported_mode != 0x01) {
        // A velocity-loop motor takes the value as a speed target: this is what a current
        // command does to a motor that did not switch. Count every nonzero one.
        w.nonzero_in_velocity_mode += raw != 0 ? 1 : 0;
      } else {
        w.currents.push_back(raw);
      }
      // The previous current acts for one tick, then the motor answers with the speed.
      advance(w, w.applied_amp, kTickSec);
      if (bytes[0] == kLeft) {
        sim_time_ += std::chrono::milliseconds(20);
      }
      w.applied_amp = reported_mode == 0x01 ? pi::rawToAmp(raw) : 0.0;
      if (answer && silent.count(bytes[0]) == 0 && master_fd >= 0) {
        w.reported_history.push_back(w.speed_rpm);
        while (static_cast<int>(w.reported_history.size()) > report_delay_ticks + 1) {
          w.reported_history.pop_front();
        }
        w.true_rpm_at_answer.push_back(w.speed_rpm);
        const auto speed = static_cast<int16_t>(std::lround(w.reported_history.front()));
        double turn = std::fmod(w.position_turns, 1.0);
        if (turn < 0.0) turn += 1.0;
        const auto position =
            injected_position >= 0
                ? static_cast<uint16_t>(injected_position)
                : static_cast<uint16_t>(
                      std::lround(turn * motor_control_lib::ddt_protocol::kPositionRawPerTurn) %
                      motor_control_lib::ddt_protocol::kPositionRawPerTurn);
        std::vector<uint8_t> frame = {bytes[0],
                                      reported_mode,
                                      bytes[2],
                                      bytes[3],
                                      static_cast<uint8_t>((static_cast<uint16_t>(speed) >> 8)),
                                      static_cast<uint8_t>(static_cast<uint16_t>(speed) & 0xFF),
                                      static_cast<uint8_t>(position >> 8),
                                      static_cast<uint8_t>(position & 0xFF),
                                      0};
        frame.push_back(motor_control_lib::ddt_protocol::crc8Maxim(frame));
        if (write(master_fd, frame.data(), frame.size()) != static_cast<ssize_t>(frame.size())) {
          return -1;
        }
      }
    }
    return static_cast<ssize_t>(size);
  }

  bool drainSerialOutput() override {
    return (fail_drain_motor < 0 || last_write_motor != fail_drain_motor) &&
           DdtMotorLib::drainSerialOutput();
  }

  std::chrono::steady_clock::time_point controlNow() const override { return sim_time_; }

private:
  void advance(Wheel& w, double amp, double seconds) {
    const double gain = kKt / model.inertia * kRpmPerRadPerSec;  // [rpm/s per A]
    constexpr int kSub = 20;
    const double h = seconds / kSub;
    for (int i = 0; i < kSub; ++i) {
      double friction = model.viscous_amp_per_rpm * w.speed_rpm;
      if (std::abs(w.speed_rpm) > 0.5) {
        friction += std::copysign(model.coulomb_amp, w.speed_rpm);
      } else {
        friction += std::clamp(amp, -model.coulomb_amp, model.coulomb_amp);  // stiction
      }
      w.speed_rpm += h * gain * (amp - friction);
      w.position_turns += w.speed_rpm / 60.0 * h;
    }
    w.peak_abs_rpm = std::max(w.peak_abs_rpm, std::abs(w.speed_rpm));
  }

  std::chrono::steady_clock::time_point sim_time_{std::chrono::seconds(1000)};
};

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

  int16_t lastCurrentRaw(int motor_id = kLeft) {
    DdtMotorLib::MotorTransactionStats stats;
    EXPECT_TRUE(lib_->getMotorTransactionStats(motor_id, stats));
    return stats.last_current_raw_sent;
  }

  // Both wheels in current mode with the default gains, lifted.
  void startBoth() {
    start(0.0015, 0.004, /*invert=*/false, kLifted);
    ASSERT_TRUE(lib_->initializeMotor(kRight, ControlMode::Current));
  }

  // One control tick: the same reference to the left then the right wheel, as drive_component.
  void tick(int rpm_ref) {
    lib_->setMotorVelocity(kLeft, rpm_ref);
    lib_->setMotorVelocity(kRight, rpm_ref);
  }

  // Number of nonzero current commands a wheel received from index `from` on.
  int nonzeroCurrentsSince(int motor_id, size_t from) {
    const auto& currents = lib_->wheels[motor_id].currents;
    int n = 0;
    for (size_t i = from; i < currents.size(); ++i) n += currents[i] != 0 ? 1 : 0;
    return n;
  }
  size_t currentCount(int motor_id) { return lib_->wheels[motor_id].currents.size(); }

  int master_{-1};
  int slave_{-1};
  std::shared_ptr<SimulatedWheelLib> lib_;
};

// The default gains with the right sign on a lifted wheel: the wheel follows, nothing trips.
TEST_F(DdtCurrentGuard, LiftedWheelWithTheDefaultGainsFollowsWithoutTripping) {
  start(0.0015, 0.004, /*invert=*/false, kLifted);
  EXPECT_EQ(run(100, 150), -1);  // 3 s
  EXPECT_NEAR(lib_->left().speed_rpm, 100.0, 10.0);
  EXPECT_TRUE(lib_->isHealthy());
}

// A wrong sign (positive feedback) on a lifted wheel: stopped within a few ticks, at low speed, and
// latched at 0 A. The speed from the position is centred 20 ms back, so the wheel is about one
// tick faster than what the guard saw when it trips (about 110 rpm here). With the reported speed,
// which on the robot is 100 ms late, the same wheel reaches about 170 rpm before the trip (see
// WrongSignWithTheLateReportedSpeedTripsLater).
TEST_F(DdtCurrentGuard, WrongSignOnALiftedWheelTripsAndLatchesAtZero) {
  lib_->setCurrentMeasuredSource(motor_control_lib::CurrentMeasuredSource::Reported);
  start(0.0015, 0.004, /*invert=*/true, kLifted);
  const int tripped_at = run(100, 100);
  ASSERT_GE(tripped_at, 0);
  EXPECT_LT(tripped_at, 25);  // within 0.5 s
  EXPECT_EQ(lib_->currentGuardTrip(kLeft), GuardTrip::kAccelAgainstCurrent);
  EXPECT_LT(lib_->left().peak_abs_rpm, 100.0);
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
  EXPECT_NEAR(lib_->left().speed_rpm, 100.0, 10.0);
}

TEST_F(DdtCurrentGuard, PositionWrongSignOnALiftedWheelTripsAndLatchesAtZero) {
  lib_->setCurrentMeasuredSource(motor_control_lib::CurrentMeasuredSource::Position);
  // 120 rpm is a bound of this wheel model, not a safe speed for hardware.
  start(0.0015, 0.004, /*invert=*/true, kLifted);
  const int tripped_at = run(100, 100);
  ASSERT_GE(tripped_at, 0);
  EXPECT_LT(tripped_at, 25);  // within 0.5 s
  EXPECT_EQ(lib_->currentGuardTrip(kLeft), GuardTrip::kAccelAgainstCurrent);
  EXPECT_LT(lib_->left().peak_abs_rpm, 120.0);
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
  EXPECT_NEAR(lib_->left().speed_rpm, 100.0, 10.0);
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
  EXPECT_NEAR(lib_->left().speed_rpm, 100.0, 10.0);
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

// P0-2 (Issue #222): one wheel's answers stop while driving. The library latches: both wheels get
// 0 A (not only the silent one), and the library reports itself unhealthy, which is what sends
// drive_component down its "Motor not healthy" fault stop.
TEST_F(DdtCurrentGuard, OneWheelLosingItsAnswersStopsBothWheels) {
  startBoth();
  for (int i = 0; i < 25; ++i) tick(100);
  ASSERT_NE(lastCurrentRaw(kLeft), 0);
  ASSERT_NE(lastCurrentRaw(kRight), 0);
  ASSERT_TRUE(lib_->isHealthy());

  lib_->silent.insert(kRight);
  for (int i = 0; i < 3; ++i) tick(100);  // at most two more exchanges go out on stale answers
  EXPECT_FALSE(lib_->isHealthy());
  EXPECT_EQ(lastCurrentRaw(kLeft), 0);
  EXPECT_EQ(lastCurrentRaw(kRight), 0);
  motor_control_lib::DifferentialDrive drive(lib_, kLeft, kRight, 0.05, 0.5);
  EXPECT_FALSE(drive.isHealthy());

  // The command stays nonzero while the wheel is silent: nothing but 0 A to either wheel.
  const size_t left_from = currentCount(kLeft);
  const size_t right_from = currentCount(kRight);
  for (int i = 0; i < 25; ++i) tick(100);
  EXPECT_EQ(nonzeroCurrentsSince(kLeft, left_from), 0);
  EXPECT_EQ(nonzeroCurrentsSince(kRight, right_from), 0);
  EXPECT_FALSE(lib_->isHealthy());
}

// P0-2: the answers come back while the command is still nonzero (the operator still holds the
// stick). The latch stays: answers returning is not a reason to resume.
TEST_F(DdtCurrentGuard, AnswersReturningUnderANonzeroCommandDoNotClear) {
  startBoth();
  for (int i = 0; i < 25; ++i) tick(100);
  lib_->silent.insert(kRight);
  for (int i = 0; i < 5; ++i) tick(100);
  ASSERT_FALSE(lib_->isHealthy());

  lib_->silent.clear();
  const size_t left_from = currentCount(kLeft);
  const size_t right_from = currentCount(kRight);
  for (int i = 0; i < 50; ++i) tick(100);  // 1 s of fresh, valid answers under a nonzero command
  EXPECT_FALSE(lib_->isHealthy());
  EXPECT_EQ(nonzeroCurrentsSince(kLeft, left_from), 0);
  EXPECT_EQ(nonzeroCurrentsSince(kRight, right_from), 0);
}

// P0-2: only stop commands, and three fresh valid answers from each wheel after them, clear the
// latch. After that a nonzero command drives again.
TEST_F(DdtCurrentGuard, StopFramesWithThreeValidAnswersFromBothWheelsClear) {
  startBoth();
  for (int i = 0; i < 25; ++i) tick(100);
  lib_->silent.insert(kRight);
  for (int i = 0; i < 5; ++i) tick(100);
  ASSERT_FALSE(lib_->isHealthy());
  lib_->silent.clear();

  tick(0);
  tick(0);
  EXPECT_FALSE(lib_->isHealthy());  // two answers each are not enough
  tick(100);                        // a nonzero command restarts the count (and sends 0 A)
  EXPECT_EQ(lastCurrentRaw(kLeft), 0);
  EXPECT_EQ(lastCurrentRaw(kRight), 0);
  tick(0);
  tick(0);
  EXPECT_FALSE(lib_->isHealthy());
  tick(0);
  EXPECT_TRUE(lib_->isHealthy());
  EXPECT_FALSE(lib_->currentLinkLatched());

  tick(100);
  EXPECT_NE(lastCurrentRaw(kLeft), 0);
  EXPECT_NE(lastCurrentRaw(kRight), 0);
}

// P0-2: a wheel whose answers keep failing while the drive is stopped still latches (three silent
// exchanges), and a wheel that answers with a fault does not count towards clearing.
TEST_F(DdtCurrentGuard, SilentStopFramesLatchToo) {
  startBoth();
  lib_->silent.insert(kLeft);
  for (int i = 0; i < DdtMotorLib::kCurrentMaxConsecutiveTimeouts; ++i) tick(0);
  EXPECT_FALSE(lib_->isHealthy());
  const size_t from = currentCount(kRight);
  tick(100);
  EXPECT_EQ(nonzeroCurrentsSince(kRight, from), 0);
}

// The freshness gate: the host stalls for longer than 50 ms while current flows (e.g. a scheduling
// hiccup, or both answers lost). The next nonzero command sends 0 A and latches.
TEST_F(DdtCurrentGuard, StaleAnswerWhileDrivingLatchesAtZero) {
  startBoth();
  for (int i = 0; i < 25; ++i) tick(100);
  ASSERT_NE(lastCurrentRaw(kLeft), 0);
  lib_->stall(std::chrono::milliseconds(60));
  const size_t from = currentCount(kLeft);
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 100));
  EXPECT_EQ(nonzeroCurrentsSince(kLeft, from), 0);
  EXPECT_EQ(lastCurrentRaw(kLeft), 0);
  EXPECT_EQ(lastCurrentRaw(kRight), 0);  // the other wheel too
  EXPECT_FALSE(lib_->isHealthy());
}

// A stall shorter than the limit (one lost answer's worth) does not latch.
TEST_F(DdtCurrentGuard, OneLostAnswerDoesNotLatch) {
  startBoth();
  for (int i = 0; i < 25; ++i) tick(100);
  // About one lost answer's worth: the right wheel's answer is 35 ms old at its next command (and
  // the position intervals 35 ms long, under the estimator's 40 ms limit).
  lib_->stall(std::chrono::milliseconds(15));
  tick(100);
  EXPECT_TRUE(lib_->isHealthy());
  EXPECT_NE(lastCurrentRaw(kLeft), 0);
}

// At rest (0 A) the answers are refreshed only every stop_resend_interval_ms, so they are old when
// the drive starts. That is not a lost link: the first command sends 0 A to get a fresh answer
// (re-prime). With the position feedback (the default) the speed needs two valid 20 ms intervals
// after that, so the drive starts on the fourth command; with the reported speed, on the second.
// Nothing latches.
TEST_F(DdtCurrentGuard, OldAnswerAtRestIsRefreshedWithZeroFirst) {
  for (const auto source : {motor_control_lib::CurrentMeasuredSource::Position,
                            motor_control_lib::CurrentMeasuredSource::Reported}) {
    lib_->wheels.clear();  // both wheels at rest
    lib_->setCurrentMeasuredSource(source);
    startBoth();
    tick(0);
    lib_->stall(std::chrono::milliseconds(300));
    const size_t from = currentCount(kLeft);
    const int zeros = source == motor_control_lib::CurrentMeasuredSource::Position ? 3 : 1;
    for (int i = 0; i < zeros; ++i) {
      ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 100));
    }
    EXPECT_EQ(nonzeroCurrentsSince(kLeft, from), 0);
    EXPECT_TRUE(lib_->isHealthy());
    ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 100));
    EXPECT_NE(lastCurrentRaw(kLeft), 0);
    EXPECT_TRUE(lib_->isHealthy());
  }
}

// A motor that never answered: current mode does not start, and no nonzero current ever reaches it.
TEST_F(DdtCurrentGuard, NeverAnsweredMotorGetsNoCurrent) {
  lib_->answer = false;
  lib_->setCurrentControlParams(0.0015, 0.004, 1.0, 0.3);
  EXPECT_FALSE(lib_->initializeMotor(kLeft, ControlMode::Current));
  EXPECT_EQ(nonzeroCurrentsSince(kLeft, 0), 0);
  EXPECT_EQ(lib_->nonzeroInVelocityMode(), 0);
}

// P0-3: one motor reboots on its own (back in the velocity loop) while driving. If the stop frame
// before the next command already brought the new mode, nothing nonzero reaches it; both wheels
// latch at 0 A and the mode guard trips on that wheel.
TEST_F(DdtCurrentGuard, RebootSeenBeforeTheSendNeverSendsACurrentAsASpeed) {
  startBoth();
  for (int i = 0; i < 25; ++i) tick(100);
  lib_->rebooted.insert(kRight);
  // Stop frames (0 A) whose answers report the velocity loop.
  ASSERT_TRUE(lib_->stopMotorNow(kLeft));
  ASSERT_TRUE(lib_->stopMotorNow(kRight));
  ASSERT_TRUE(lib_->isHealthy());  // a zero frame alone does not judge the mode
  tick(100);
  EXPECT_EQ(lib_->wheels[kRight].nonzero_in_velocity_mode, 0);
  EXPECT_EQ(lib_->currentGuardTrip(kRight), GuardTrip::kModeMismatch);
  EXPECT_FALSE(lib_->isHealthy());
  const size_t from = currentCount(kLeft);
  for (int i = 0; i < 10; ++i) tick(100);
  EXPECT_EQ(nonzeroCurrentsSince(kLeft, from), 0);
  EXPECT_EQ(lib_->wheels[kRight].nonzero_in_velocity_mode, 0);
}

// P0-3: the reboot happens between the last answer and the send (the race software cannot close):
// one current command is read as a speed target, its answer reports the velocity loop, and from
// the next command on both wheels get 0 A.
TEST_F(DdtCurrentGuard, RebootJustBeforeTheSendLatchesBothWheelsOnTheNextCommand) {
  startBoth();
  for (int i = 0; i < 25; ++i) tick(100);
  lib_->rebooted.insert(kRight);
  tick(100);
  EXPECT_LE(lib_->wheels[kRight].nonzero_in_velocity_mode, 1);  // the race, at most one frame
  EXPECT_EQ(lib_->currentGuardTrip(kRight), GuardTrip::kModeMismatch);
  EXPECT_EQ(lastCurrentRaw(kLeft), 0);
  EXPECT_FALSE(lib_->isHealthy());
  const int before = lib_->wheels[kRight].nonzero_in_velocity_mode;
  const size_t from = currentCount(kLeft);
  for (int i = 0; i < 10; ++i) tick(100);
  EXPECT_EQ(lib_->wheels[kRight].nonzero_in_velocity_mode, before);
  EXPECT_EQ(nonzeroCurrentsSince(kLeft, from), 0);
}

// Velocity mode is unchanged: lost answers neither latch nor stop the velocity frames.
TEST_F(DdtCurrentGuard, VelocityModeIsNotLatchedByLostAnswers) {
  ASSERT_TRUE(lib_->initializeMotor(kLeft, ControlMode::Velocity));
  lib_->answer = false;
  for (int i = 0; i < 10; ++i) EXPECT_TRUE(lib_->setMotorVelocity(kLeft, 100));
  EXPECT_FALSE(lib_->currentLinkLatched());
  EXPECT_TRUE(lib_->isHealthy());
}

// G1 (Issue #222): with the reported speed 100 ms (5 ticks) behind the wheel, as on the robot,
// the speed from the position follows the wheel about one tick behind (the two-interval estimate
// is centred 20 ms back), and the reported speed five. Measured as the shift that best matches the
// wheel's physical speed during a step to 200 rpm and down to 50 rpm.
TEST_F(DdtCurrentGuard, PositionFeedbackFollowsTheWheelWhileTheReportedSpeedLags) {
  lib_->report_delay_ticks = 5;
  start(0.0015, 0.004, /*invert=*/false, kLifted);
  constexpr int kTicks = 100;  // 2 s
  std::vector<double> position;
  std::vector<double> reported;
  std::vector<double> actual;
  for (int i = 0; i < kTicks; ++i) {
    ASSERT_TRUE(lib_->setMotorVelocity(kLeft, i < kTicks / 2 ? 200 : 50));
    DdtMotorLib::MotorFeedbackData fb;
    ASSERT_TRUE(lib_->getMotorFeedbackData(kLeft, fb));
    position.push_back(fb.position_rpm_valid ? fb.position_rpm : std::nan(""));
    reported.push_back(fb.velocity_rpm_raw);
    actual.push_back(lib_->left().true_rpm_at_answer.back());
  }
  auto rms_at = [&](const std::vector<double>& est, int shift) {
    double sum = 0.0;
    int n = 0;
    for (int i = 10; i < kTicks; ++i) {
      if (std::isnan(est[i])) continue;
      const double e = est[i] - actual[i - shift];
      sum += e * e;
      ++n;
    }
    return n > 0 ? std::sqrt(sum / n) : INFINITY;
  };
  auto best_shift = [&](const std::vector<double>& est) {
    int best = 0;
    for (int k = 1; k <= 8; ++k) {
      if (rms_at(est, k) < rms_at(est, best)) best = k;
    }
    return best;
  };
  const int position_lag = best_shift(position);
  const int reported_lag = best_shift(reported);
  std::printf(
      "lag [ticks of 20 ms]: position %d, reported %d; rms error at zero shift [rpm]: "
      "position %.1f, reported %.1f\n",
      position_lag, reported_lag, rms_at(position, 0), rms_at(reported, 0));
  EXPECT_LE(position_lag, 1);
  EXPECT_EQ(reported_lag, 5);
  EXPECT_LT(rms_at(position, 0), 0.5 * rms_at(reported, 0));
  EXPECT_EQ(lib_->currentGuardTrip(kLeft), GuardTrip::kNone);
}

// The same wheels closed on each feedback, the reported speed 100 ms late (as on the robot). On the
// position the default gains settle on a lifted wheel and the floor gains on the floor; on the late
// reported speed both overshoot and keep swinging, and no guard notices (Issue #222, R3). The
// numbers are from the estimated model, not from the robot.
TEST_F(DdtCurrentGuard, LateReportedFeedbackSwingsWhereThePositionSettles) {
  struct Case {
    double kp;
    double ki;
    WheelModel model;
    const char* name;
  };
  const Case cases[] = {{0.0015, 0.004, kLifted, "lifted, default gains"},
                        {0.02, 0.05, kFloor6kg, "floor 6 kg, 0.02 / 0.05"}};
  for (const auto& c : cases) {
    double peak[2] = {0.0, 0.0};
    double final_rpm[2] = {0.0, 0.0};
    const motor_control_lib::CurrentMeasuredSource sources[2] = {
        motor_control_lib::CurrentMeasuredSource::Position,
        motor_control_lib::CurrentMeasuredSource::Reported};
    for (int i = 0; i < 2; ++i) {
      lib_->report_delay_ticks = 5;
      lib_->wheels.clear();
      lib_->setCurrentMeasuredSource(sources[i]);
      start(c.kp, c.ki, /*invert=*/false, c.model);
      run(100, 150);  // 3 s
      peak[i] = lib_->left().peak_abs_rpm;
      final_rpm[i] = lib_->left().speed_rpm;
    }
    std::printf(
        "100 rpm step, %s: peak / after 3 s [rpm]: position %.1f / %.1f, reported (100 ms "
        "late) %.1f / %.1f\n",
        c.name, peak[0], final_rpm[0], peak[1], final_rpm[1]);
    EXPECT_LT(peak[0], 110.0) << c.name;
    EXPECT_NEAR(final_rpm[0], 100.0, 5.0) << c.name;
    EXPECT_GT(peak[1], peak[0] + 20.0) << c.name;
  }
}

// A wrong sign with the reported speed 100 ms late: the guard still trips, but later than on the
// position, at a higher speed.
TEST_F(DdtCurrentGuard, WrongSignWithTheLateReportedSpeedTripsLater) {
  double peak[2] = {0.0, 0.0};
  const motor_control_lib::CurrentMeasuredSource sources[2] = {
      motor_control_lib::CurrentMeasuredSource::Position,
      motor_control_lib::CurrentMeasuredSource::Reported};
  for (int i = 0; i < 2; ++i) {
    lib_->report_delay_ticks = 5;
    lib_->wheels.clear();
    lib_->setCurrentMeasuredSource(sources[i]);
    start(0.0015, 0.004, /*invert=*/true, kLifted);
    ASSERT_GE(run(100, 100), 0);
    EXPECT_EQ(lib_->currentGuardTrip(kLeft), GuardTrip::kAccelAgainstCurrent);
    peak[i] = lib_->left().peak_abs_rpm;
  }
  std::printf(
      "wrong sign, lifted: peak before the trip [rpm]: position %.1f, reported (100 ms "
      "late) %.1f\n",
      peak[0], peak[1]);
  EXPECT_LT(peak[0], peak[1]);
}

// Friction feedforward: with the model's own friction, the steady error is smaller than with the
// integral alone after the same short time.
TEST_F(DdtCurrentGuard, FrictionFeedforwardShortensTheApproach) {
  start(0.0015, 0.004, /*invert=*/false, kLifted);
  run(100, 15);  // 0.3 s
  const double without_ff = std::abs(100.0 - lib_->left().speed_rpm);
  lib_->left().speed_rpm = 0.0;
  lib_->setCurrentFeedforward(kLifted.coulomb_amp, kLifted.viscous_amp_per_rpm);
  ASSERT_TRUE(lib_->initializeMotor(kLeft, ControlMode::Current));
  EXPECT_EQ(run(100, 15), -1);
  const double with_ff = std::abs(100.0 - lib_->left().speed_rpm);
  EXPECT_LT(with_ff, without_ff);
}

// A motor that takes the legacy mode frame layout (mode in DATA[8], CRC in DATA[9]) is switched by
// the fallback, and current mode starts.
TEST_F(DdtCurrentGuard, LegacyModeFrameIsTriedWhenTheSpecFrameDoesNotSwitch) {
  lib_->mode_frames = SimulatedWheelLib::ModeFrames::kLegacy;
  start(0.0015, 0.004, /*invert=*/false, kLifted);
  EXPECT_EQ(lib_->mode, 0x01);
  EXPECT_EQ(run(100, 50), -1);
  EXPECT_EQ(lib_->nonzeroInVelocityMode(), 0);
}

// A motor that never reports the current loop: current mode does not start, and no current
// command ever reaches it (it would read the raw value as a speed target).
TEST_F(DdtCurrentGuard, MotorThatStaysInTheVelocityLoopIsRefused) {
  lib_->mode_frames = SimulatedWheelLib::ModeFrames::kNever;
  lib_->setCurrentControlParams(0.0015, 0.004, 1.0, 0.3);
  EXPECT_FALSE(lib_->initializeMotor(kLeft, ControlMode::Current));
  EXPECT_EQ(lib_->nonzeroInVelocityMode(), 0);
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
  const int before = lib_->nonzeroInVelocityMode();
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 100));
  EXPECT_EQ(lib_->nonzeroInVelocityMode(), before);
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

// M1: a nonzero target must reset every count before its response can clear the latch.
TEST_F(DdtCurrentGuard, NonzeroTargetCannotCompleteAsymmetricRecovery) {
  startBoth();
  for (int scenario = 0; scenario < 3; ++scenario) {
    const int first = scenario == 1 ? kRight : kLeft;
    const int second = scenario == 1 ? kLeft : kRight;
    const int command_first = scenario == 2 ? second : first;
    const int command_second = scenario == 2 ? first : second;
    lib_->silent.insert(first);
    for (int i = 0; i < 5; ++i) tick(100);
    ASSERT_TRUE(lib_->currentLinkLatched());
    lib_->silent.clear();
    for (int i = 0; i < 2; ++i) {
      ASSERT_TRUE(lib_->setMotorVelocity(command_first, 0));
      ASSERT_TRUE(lib_->setMotorVelocity(command_second, 0));
    }
    ASSERT_TRUE(lib_->setMotorVelocity(second, 0));
    ASSERT_TRUE(lib_->currentLinkLatched());
    ASSERT_TRUE(lib_->setMotorVelocity(first, 100));
    EXPECT_TRUE(lib_->currentLinkLatched());
    for (int i = 0; i < 2; ++i) {
      ASSERT_TRUE(lib_->setMotorVelocity(command_first, 0));
      ASSERT_TRUE(lib_->setMotorVelocity(command_second, 0));
      EXPECT_TRUE(lib_->currentLinkLatched());
    }
    ASSERT_TRUE(lib_->setMotorVelocity(first, 0));
    EXPECT_TRUE(lib_->currentLinkLatched());
    ASSERT_TRUE(lib_->setMotorVelocity(second, 0));
    EXPECT_FALSE(lib_->currentLinkLatched());
  }
}

TEST_F(DdtCurrentGuard, FailedNonzeroWriteLatchesAndAttemptsBothZeros) {
  lib_->setCurrentMeasuredSource(motor_control_lib::CurrentMeasuredSource::Reported);
  startBoth();
  tick(100);
  lib_->zero_attempts.clear();
  lib_->fail_write_motor = kLeft;
  EXPECT_FALSE(lib_->setMotorVelocity(kLeft, 100));
  EXPECT_TRUE(lib_->currentLinkLatched());
  EXPECT_FALSE(lib_->isHealthy());
  EXPECT_GT(lib_->zero_attempts[kLeft], 0);
  EXPECT_GT(lib_->zero_attempts[kRight], 0);
}

TEST_F(DdtCurrentGuard, FailedNonzeroDrainLatchesAndAttemptsBothZeros) {
  lib_->setCurrentMeasuredSource(motor_control_lib::CurrentMeasuredSource::Reported);
  startBoth();
  tick(100);
  lib_->zero_attempts.clear();
  lib_->fail_drain_motor = kLeft;
  EXPECT_FALSE(lib_->setMotorVelocity(kLeft, 100));
  EXPECT_TRUE(lib_->currentLinkLatched());
  EXPECT_FALSE(lib_->isHealthy());
  EXPECT_GT(lib_->zero_attempts[kLeft], 0);
  EXPECT_GT(lib_->zero_attempts[kRight], 0);
}

TEST_F(DdtCurrentGuard, FailureStoppingTheOtherWheelIsReported) {
  lib_->setCurrentMeasuredSource(motor_control_lib::CurrentMeasuredSource::Reported);
  startBoth();
  tick(100);
  lib_->stall(std::chrono::milliseconds(60));
  lib_->fail_write_motor = kRight;
  EXPECT_FALSE(lib_->setMotorVelocity(kLeft, 100));
  EXPECT_TRUE(lib_->currentLinkLatched());
  EXPECT_FALSE(lib_->isHealthy());
  EXPECT_GT(lib_->zero_attempts[kRight], 0);
}

TEST_F(DdtCurrentGuard, ZeroPiOutputUnderNonzeroTargetDoesNotMeanRest) {
  lib_->setCurrentMeasuredSource(motor_control_lib::CurrentMeasuredSource::Reported);
  startBoth();
  tick(100);
  // Cancel the output for one tick without sending a stop target.
  lib_->setCurrentControlParams(0.0, 0.0, 1.0, 0.3);
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 100));
  ASSERT_EQ(lastCurrentRaw(), 0);
  lib_->stall(std::chrono::milliseconds(60));
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 100));
  EXPECT_TRUE(lib_->currentLinkLatched());
  EXPECT_FALSE(lib_->isHealthy());
}

TEST_F(DdtCurrentGuard, RebootWithFirstAnswerLostSendsTwoSpeedTargetsThenLatches) {
  startBoth();
  for (int i = 0; i < 25; ++i) tick(100);
  lib_->rebooted.insert(kRight);
  lib_->silent.insert(kRight);
  tick(100);
  EXPECT_EQ(lib_->wheels[kRight].nonzero_in_velocity_mode, 1);
  EXPECT_FALSE(lib_->currentLinkLatched());
  lib_->silent.clear();
  tick(100);
  EXPECT_EQ(lib_->wheels[kRight].nonzero_in_velocity_mode, 2);
  EXPECT_TRUE(lib_->currentLinkLatched());
  EXPECT_EQ(lastCurrentRaw(kLeft), 0);
  EXPECT_EQ(lastCurrentRaw(kRight), 0);
  for (int i = 0; i < 10; ++i) tick(100);
  EXPECT_EQ(lib_->wheels[kRight].nonzero_in_velocity_mode, 2);
}

TEST_F(DdtCurrentGuard, InvalidCrcValidPositionsLatchWhileDriving) {
  for (int position : {32768, 40000, 65535}) {
    SCOPED_TRACE(position);
    lib_->injected_position = -1;
    startBoth();
    // Recover the previous iteration's link latch using stop responses only.
    for (int i = 0; i < 5; ++i) tick(0);
    ASSERT_FALSE(lib_->currentLinkLatched());
    for (int i = 0; i < 10; ++i) tick(100);
    ASSERT_NE(lastCurrentRaw(kLeft), 0);
    lib_->injected_position = position;
    EXPECT_TRUE(lib_->setMotorVelocity(kLeft, 100));
    EXPECT_TRUE(lib_->currentLinkLatched());
    EXPECT_FALSE(lib_->isHealthy());
    EXPECT_EQ(lastCurrentRaw(kLeft), 0);
    EXPECT_EQ(lastCurrentRaw(kRight), 0);
    DdtMotorLib::MotorFeedbackData fb;
    ASSERT_TRUE(lib_->getMotorFeedbackData(kLeft, fb));
    EXPECT_FALSE(fb.position_rpm_valid);
  }
}

TEST_F(DdtCurrentGuard, PositionZeroPiOutputStillLatchesOnStaleFeedback) {
  start(0.0015, 0.0, false, kLifted);
  ASSERT_EQ(run(100, 10), -1);
  lib_->setCurrentControlParams(0.0, 0.0, 1.0, 0.3);
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 100));
  ASSERT_EQ(lastCurrentRaw(), 0);
  lib_->stall(std::chrono::milliseconds(60));
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 100));
  EXPECT_TRUE(lib_->currentLinkLatched());
}

TEST_F(DdtCurrentGuard, PositionZeroPiOutputStillLatchesOnInvalidEstimate) {
  start(0.0015, 0.0, false, kLifted);
  ASSERT_EQ(run(100, 10), -1);
  lib_->setCurrentControlParams(0.0, 0.0, 1.0, 0.3);
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 100));
  ASSERT_EQ(lastCurrentRaw(), 0);
  lib_->injected_position = 40000;
  lib_->refreshMotorFeedback(kLeft, 0.0);  // replay only the zero, without a stop target
  ASSERT_TRUE(lib_->setMotorVelocity(kLeft, 100));
  EXPECT_TRUE(lib_->currentLinkLatched());
  EXPECT_FALSE(lib_->isHealthy());
}

}  // namespace
