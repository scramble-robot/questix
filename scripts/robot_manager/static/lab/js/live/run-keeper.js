import { addDriveRun, isEmptyRun, markRunOnRobot } from './drive-history.js';
import { keepOnRobot } from './robot-records.js';
import { lessonName } from './records-core.js';
import { captureCopy } from './live-view.js';

// Where a 「記録だけする」 recording goes once it is finished, wherever it was made (a lesson's
// shared block, the SLAM course's own recorder): into this browser's run history — when the robot
// moved in it, as for every run there — and onto the robot, when the robot keeps records.

/** The history entry of a finished recording made for lesson `slot`; null when nothing moved. */
function addCaptureRun(recording, slot) {
  if (isEmptyRun(recording)) return null;
  return addDriveRun({
    slot,
    lesson: lessonName(slot),
    ended: captureCopy.recordedRun,
    reason: 'recorded',
    robot: recording.robot?.name ?? '',
    group: recording.group ?? '',
    cut: Boolean(recording.cut),
    recording,
  }).id;
}

/**
 * Keep `recording` on the robot and note the robot's id in history entry `runId` (or null).
 * Resolves with robot-records keepOnRobot's answer: `{state, message}`, or null when the robot
 * does not keep records.
 */
async function keepRunOnRobot(recording, runId) {
  const saved = await keepOnRobot(recording);
  if (saved?.state === 'saved' && runId !== null) markRunOnRobot(runId, saved.id);
  return saved;
}

/** Both of the above for a 「記録だけする」 recording; resolves like keepRunOnRobot. */
const keepCapture = (recording, slot) => keepRunOnRobot(recording, addCaptureRun(recording, slot));

export { addCaptureRun, keepRunOnRobot, keepCapture };
