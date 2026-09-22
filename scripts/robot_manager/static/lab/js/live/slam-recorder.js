import { recordStream, openRecordingFile, PAIR_FRESH_MS } from './capture.js';
import { wheelRpm, scanMount } from './capture-core.js';
import { pairByStamp, missingInRecording, RECORDING_FORMAT } from './recording-core.js';

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
  const start = samples[0].scan.stamp;
  const rangeMax = Math.min(LOG_RANGE_LIMIT, samples[0].scan.range_max);
  const frames = [];
  let previous = 0;
  let moved = false;
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
        // Where the LiDAR sits on the robot (TF via the bridge, or the QUESTiX default).
        lidar: { ...scanMount(samples[0].scan) },
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

// A rosbag from the robot (.mcap) or a recording this material saved: each scan paired with the
// wheel feedback of the same moment, exactly as a live recording pairs them.
const MCAP_FIRST_BYTE = 0x89;

async function isRobotRecording(file) {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  if (head[0] === MCAP_FIRST_BYTE || /\.mcap$/i.test(file.name)) return true;
  return new TextDecoder().decode(head).includes(`"${RECORDING_FORMAT}"`);
}

/**
 * Open `file` as a SLAM log. A rosbag or a questix-lab-recording is converted with buildSlamLog;
 * resolves with `{log, moved, assumedConfig}`, or with null for any other file, which the lesson
 * then reads as a robo-lab-sensors-v1 JSON itself.
 */
async function slamLogFromFile(file) {
  if (!(await isRobotRecording(file))) return null;
  const { recording, assumedConfig } = await openRecordingFile(file);
  const missing = missingInRecording(recording, ['scan', 'drive']);
  if (missing.length)
    throw Error('LiDAR（/scan）と車輪の状態（/drive_status）の両方が入った記録を選んでください。');
  const samples = pairByStamp(recording, 'scan', ['drive'], PAIR_FRESH_MS / 1000).filter(
    (sample) => sample.drive,
  );
  return { ...buildSlamLog(samples, recording.config), assumedConfig };
}

export { wheelRpm, buildSlamLog, recordSlamLog, slamLogFromFile };
