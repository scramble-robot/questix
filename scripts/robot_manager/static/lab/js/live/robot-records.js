import { robotState, onRobot, robotRecordsSupport, saveRecordOnRobot } from './robot-link.js';
import { serializeRecording } from './recording-core.js';
import { recordsBaseUrl, recordsClient, recordsCopy } from './records-core.js';
import { fillSentence as fill } from '../core/content.js';

// The records kept on the connected robot, as the rest of the page uses them: saving a finished
// run there (every lab run and every 「記録だけする」 capture goes through keepOnRobot), and the
// client of the bridge's /api/records for the records view and the picker. No DOM.

const listeners = new Set();
// Whether the robot this page was last connected to keeps records: a run cut off by a lost link
// is then reported as not saved, instead of silently staying on this device only.
let lastRobotSaves = false;

/**
 * What the connected robot offers: `{connected, save, list, rosbags}` (all false without a
 * connection or on a bridge older than records).
 */
function robotRecordsInfo() {
  const support = robotRecordsSupport();
  return {
    connected: robotState().phase === 'open',
    save: Boolean(support?.save),
    list: Boolean(support?.list),
    rosbags: Boolean(support?.rosbags),
  };
}

/** The client of the connected bridge's records API, or null while not connected. */
function robotRecordsClient() {
  const link = robotState();
  if (link.phase !== 'open') return null;
  const base = recordsBaseUrl(link.url);
  return base ? recordsClient(base) : null;
}

function notify() {
  for (const fn of listeners) fn();
}

// Subscribe to "the robot's records may have changed" (a save, a new connection); returns the
// unsubscribe function.
function onRobotRecords(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Keep a finished recording on the robot. Resolves (never rejects) with
 * `{state: 'saved', id, message}`, `{state: 'failed', message}` — the sentence the lesson block
 * shows — or null when the robot does not keep records (older bridge, saving switched off), in
 * which case nothing is said: the recording stays in this browser as before.
 */
async function keepOnRobot(recording) {
  const text = recordsCopy.save;
  const info = robotRecordsInfo();
  if (info.connected ? !info.save : !lastRobotSaves) return null;
  try {
    const id = await saveRecordOnRobot(serializeRecording(recording));
    notify();
    return { state: 'saved', id, message: text.saved };
  } catch (error) {
    return { state: 'failed', message: fill(text.failed, { reason: error.message }) };
  }
}

// A new hello is a new connection (the state is also emitted for every status message).
let greeted = null;
onRobot('state', (link) => {
  if (link.phase === 'idle') lastRobotSaves = false;
  if (link.phase !== 'open' || link.hello === greeted) return;
  greeted = link.hello;
  lastRobotSaves = robotRecordsInfo().save;
  notify();
});

export { robotRecordsInfo, robotRecordsClient, onRobotRecords, keepOnRobot };
