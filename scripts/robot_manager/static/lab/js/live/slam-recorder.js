import { recordStream } from './capture.js';
import { wheelRpm } from './capture-core.js';

// Records live LiDAR scans and wheel feedback into the same "robo-lab-sensors-v1" JSON that the
// SLAM lesson imports from a file, so a real run goes through the identical validation and maths.
// Collecting the samples is the shared job of capture.js; this module only shapes the log.

const LOG_RANGE_LIMIT = 50; // validateSlamLog accepts rangeMax up to 50 m
const LOG_RPM_LIMIT = 1000;

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
async function recordSlamLog({ seconds = 12, onProgress = () => {}, signal } = {}) {
  const { samples, missed, config } = await recordStream({
    trigger: 'scan',
    pair: ['drive'],
    seconds,
    onProgress,
    signal,
  });
  if (!samples.length && missed)
    throw Error(
      '車輪の回転数（/drive_status）が届いていません。走行用のノードが動いているか確かめてください。',
    );
  return buildSlamLog(samples, config);
}

export { wheelRpm, buildSlamLog, recordSlamLog };
