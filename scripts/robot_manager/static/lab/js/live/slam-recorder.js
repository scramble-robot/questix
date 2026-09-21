import { onRobot, robotState } from './robot-link.js';

// Records live LiDAR scans and wheel feedback into the same "robo-lab-sensors-v1" JSON that the
// SLAM lesson imports from a file, so a real run goes through the identical validation and maths.

const DRIVE_FRESH_MS = 500;
const LOG_RANGE_LIMIT = 50; // validateSlamLog accepts rangeMax up to 50 m
const LOG_RPM_LIMIT = 1000;

// Forward-positive wheel speed [RPM] for both wheels. The raw DDT feedback cannot be used directly:
// the right motor is mirrored, so its wire RPM is negative when driving forward. The chassis
// velocity in /drive_status already has the robot's own sign convention applied, so invert the
// differential-drive kinematics instead: v_left = v - w*L/2, v_right = v + w*L/2.
function wheelRpm(drive, config) {
  const toRpm = (speed) => (speed / (2 * Math.PI * config.wheel_radius)) * 60,
    half = (drive.w * config.wheel_separation) / 2;
  return { left: toRpm(drive.v - half), right: toRpm(drive.v + half) };
}

// samples: [{scan, drive}] in arrival order. The first scan only fixes t = 0.
function buildSlamLog(samples, config) {
  if (!config || !(config.wheel_radius > 0) || !(config.wheel_separation > 0))
    throw Error('ロボットから車輪の寸法を受け取れませんでした。');
  if (samples.length < 4)
    throw Error('記録が短すぎます。LiDAR（/scan）が届いているか確かめてください。');
  const start = samples[0].scan.stamp,
    rangeMax = Math.min(LOG_RANGE_LIMIT, samples[0].scan.range_max),
    frames = [];
  let previous = 0,
    moved = false;
  for (const { scan, drive } of samples.slice(1)) {
    const t = scan.stamp - start;
    if (!(t > previous)) continue;
    if (!Number.isFinite(drive.v) || !Number.isFinite(drive.w))
      throw Error(
        '車体の速度を受け取れませんでした。drive_component の /drive_status が必要です。',
      );
    const rpm = wheelRpm(drive, config);
    if (Math.abs(rpm.left) > LOG_RPM_LIMIT || Math.abs(rpm.right) > LOG_RPM_LIMIT) continue;
    moved ||= Math.abs(drive.v) > 1e-3 || Math.abs(drive.w) > 1e-3;
    previous = t;
    // No IMU stream exists on the robot yet, so gyroZ stays 0: compare wheel-only and LiDAR conditions.
    frames.push({
      t: +t.toFixed(3),
      leftRpm: +rpm.left.toFixed(2),
      rightRpm: +rpm.right.toFixed(2),
      gyroZ: 0,
      angleMin: scan.angle_min,
      angleIncrement: scan.angle_increment,
      ranges: scan.ranges.map((r) => (r === null || r > rangeMax ? null : r)),
    });
  }
  return {
    log: {
      format: 'robo-lab-sensors-v1',
      config: {
        radius: config.wheel_radius,
        track: config.wheel_separation,
        rangeMax,
        lidar: { x: 0, y: 0, yaw: 0 },
      },
      stationarySeconds: 0,
      frames,
    },
    moved,
  };
}

// Resolves with {log, moved}; rejects with a learner-facing message. `signal` aborts early.
function recordSlamLog({ seconds = 12, onProgress = () => {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const state = robotState();
    if (state.phase !== 'open') {
      reject(Error('先に画面右上の「実機」からロボットに接続してください。'));
      return;
    }
    const samples = [];
    let drive = null,
      driveAt = 0,
      missedDrive = 0;
    const finish = (error) => {
      offScan();
      offDrive();
      offState();
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        reject(error);
        return;
      }
      try {
        if (!samples.length && missedDrive)
          throw Error(
            '車輪の回転数（/drive_status）が届いていません。走行用のノードが動いているか確かめてください。',
          );
        resolve(buildSlamLog(samples, state.hello.config));
      } catch (e) {
        reject(e);
      }
    };
    const abort = () => finish(Error('記録を中止しました。'));
    const offDrive = onRobot('drive', (message) => {
      drive = message;
      driveAt = performance.now();
    });
    const offScan = onRobot('scan', (scan) => {
      if (!drive || performance.now() - driveAt > DRIVE_FRESH_MS) {
        missedDrive++;
        return;
      }
      samples.push({ scan, drive });
      onProgress(samples.length);
    });
    const offState = onRobot('state', (next) => {
      if (next.phase !== 'open') finish(Error('記録の途中でロボットとの接続が切れました。'));
    });
    const timer = setTimeout(() => finish(), seconds * 1000);
    signal?.addEventListener('abort', abort);
  });
}

export { wheelRpm, buildSlamLog, recordSlamLog };
