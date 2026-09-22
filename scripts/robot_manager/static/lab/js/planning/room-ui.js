import { fillSentence as fill } from '../core/content.js';
import { pairByStamp } from '../live/recording-core.js';
import { createLiveSession } from '../live/live-session.js';
import { PLAN_ROBOT, planningClearance } from './core.js';
import { ROOM_SIZE, measuredRoom } from './room-core.js';
import { readScan, floorHeight, sliceScan, scanRoom } from './scan3d-core.js';

// The measured room of the path-planning course (topic `room`): where its map comes from and how
// the learner adjusts it. Two sources, one map:
// - the robot itself (`/scan` + `/odom`, live or from a recording / rosbag), room-core.js;
// - a 3D scan of the room taken with a phone, cut at the height of the robot's 2D LiDAR,
//   scan3d-core.js.
// ui.js owns the page; this module owns the room and tells ui.js when the map changed.

// A scan is placed with the odometry of the same moment; an older pose would put the points where
// the robot no longer was.
const ODOM_FRESH_SECONDS = 0.2;
const MAX_SCAN_BYTES = 500 * 1024 * 1024;
const CM = 100;
const KEPT_ROOM = 'questix-lab-planning-room';
const KEPT_SETTINGS = 'questix-lab-planning-scan-settings';
// Where the scan is cut; remembered per browser. By default, the height range a wheeled robot
// cannot pass through: from just above the floor to the top of the robot. The LiDAR's height above
// the floor is not in the robot's TF (base_link has no floor frame), so for the LiDAR band it is
// measured with a ruler and typed in.
const SCAN_DEFAULTS = {
  up: 'y', // ARKit / glTF
  band: 'body', // 'body': floor to the top of the robot; 'lidar': the LiDAR's plane only
  lowest: 0.03, // m above the floor: lower things are rolled over (and the scan's floor is uneven)
  bodyHeight: 0.4, // m, floor to the top of the robot
  lidarHeight: 0.15, // m, floor to the LiDAR's scanning plane
  thickness: 0.03, // m either side of that plane
  rotate: 'auto',
  offset: { x: null, y: null }, // m, which part of a larger room is in the frame
};

function readStored(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked or full: the room simply does not survive a reload */
  }
}

// A fresh scan gets its start and goal at the nearest spot, from the usual left and right ends of
// the frame, where the robot fits with a little room to spare; the learner can move both.
const FREE_MARGIN = 0.05; // m beyond the robot's radius
const SEARCH_STEP = 0.1; // m

function nearestFree(map, wanted) {
  let best = null;
  for (let y = SEARCH_STEP; y < ROOM_SIZE.height; y += SEARCH_STEP)
    for (let x = SEARCH_STEP; x < ROOM_SIZE.width; x += SEARCH_STEP) {
      const point = { x: Math.round(x * CM) / CM, y: Math.round(y * CM) / CM };
      if (planningClearance(point, map) <= PLAN_ROBOT.radius + FREE_MARGIN) continue;
      const distance = Math.hypot(point.x - wanted.x, point.y - wanted.y);
      if (!best || distance < best.distance) best = { point, distance };
    }
  return best?.point ?? wanted;
}

/**
 * `copy` is content/planning.json; `changed(key)` is called whenever the map changes, with a key
 * that identifies it (ui.js stores it in the run's conditions); `update()` redraws the page.
 */
function createRoom({ copy, changed, update }) {
  const text = copy.room;
  let room = null; // {map, trajectory, source, name, …}
  let scan = null; // {geometry, name, floor, triangles, points}: only while the file is open
  // Settings kept before 'lowest' existed still work: missing keys take the defaults.
  let settings = { ...SCAN_DEFAULTS, ...readStored(KEPT_SETTINGS) };
  let placing = null; // 'start' | 'goal' | null
  let note = '';

  function setRoom(next, key) {
    room = next;
    store(KEPT_ROOM, { ...room, key });
    changed(key);
  }

  // --- from the robot ---

  function applyRecording(recording) {
    const samples = pairByStamp(recording, 'scan', ['odom'], ODOM_FRESH_SECONDS).filter(
      (sample) => sample.odom,
    );
    const measured = measuredRoom(samples);
    if (!measured) return { ok: false, note: text.tooFew };
    scan = null;
    const notes = [
      fill(text.built, { scans: measured.scans, obstacles: measured.map.obstacles.length }),
    ];
    if (measured.tooLarge) notes.push(text.tooLarge);
    else if (measured.outside) notes.push(text.outside);
    note = '';
    setRoom(
      { map: measured.map, trajectory: measured.trajectory, source: 'robot', name: recording.name },
      `robot ${recording.recordedAt} ${recording.name}`,
    );
    return { ok: true, note: notes.join(' ') };
  }

  const session = createLiveSession({
    slot: 'planning-room',
    lesson: 'planning-room',
    needs: ['scan', 'odom'],
    seconds: text.seconds,
    countStream: 'scan',
    finishOnStop: true,
    applyOnRestore: false, // the room itself is kept (KEPT_ROOM)
    recordLabel: text.recordLabel,
    stopLabel: text.stopLabel,
    failed: text.failed,
    apply: applyRecording,
    update,
  });

  // --- from a phone's 3D scan ---

  function cutScan() {
    const slice = sliceScan(scan.geometry, { ...settings, floor: scan.floor });
    const keep = room?.source === 'scan' ? { start: room.map.start, goal: room.map.goal } : {};
    const cut = scanRoom(slice, { ...keep, rotate: settings.rotate, offset: settings.offset });
    if (!keep.start) {
      cut.map.start = nearestFree(cut.map, cut.map.start);
      cut.map.goal = nearestFree(cut.map, cut.map.goal);
    }
    note = fill(text.scan.built, {
      name: scan.name,
      width: cut.extent.width.toFixed(1),
      height: cut.extent.height.toFixed(1),
      obstacles: cut.map.obstacles.length,
    });
    if (cut.maxOffset.x > 0 || cut.maxOffset.y > 0) note += ' ' + text.scan.larger;
    setRoom(
      {
        map: cut.map,
        trajectory: null,
        source: 'scan',
        name: scan.name,
        maxOffset: cut.maxOffset,
        offset: cut.offset,
        rotated: cut.rotated,
      },
      `scan ${scan.name} ${JSON.stringify(settings)} ${JSON.stringify(keep)}`,
    );
  }

  async function openScan(file) {
    if (!file) return;
    try {
      if (file.size > MAX_SCAN_BYTES) throw new Error(text.scan.tooLarge);
      const geometry = readScan(await file.arrayBuffer(), file.name);
      scan = {
        geometry,
        name: file.name,
        floor: floorHeight(geometry, settings.up),
        triangles: geometry.indices ? geometry.indices.length / 3 : 0,
        points: geometry.positions.length / 3,
      };
      settings = { ...settings, offset: { x: null, y: null } };
      if (room?.source === 'scan') room = { ...room, source: 'replaced' }; // new file: defaults
      cutScan();
    } catch (error) {
      note = fill(text.scan.failed, { reason: error.message });
    }
    update();
  }

  function setSetting(key, value) {
    settings = { ...settings, [key]: value };
    // A new vertical axis moves the floor; the other settings keep it.
    if (scan && key === 'up') scan.floor = floorHeight(scan.geometry, value);
    store(KEPT_SETTINGS, { ...settings, offset: undefined });
    if (scan) cutScan();
    update();
  }

  // --- start and goal ---

  function place(point) {
    if (!room || !placing) return false;
    const inside =
      point.x > 0 && point.y > 0 && point.x < ROOM_SIZE.width && point.y < ROOM_SIZE.height;
    if (!inside || planningClearance(point, room.map) <= PLAN_ROBOT.radius) {
      note = text.placeBlocked;
      update();
      return true;
    }
    const rounded = { x: Math.round(point.x * CM) / CM, y: Math.round(point.y * CM) / CM };
    const map = { ...room.map, [placing]: rounded };
    note = fill(text.placed, { what: text.placeNames[placing] });
    placing = null;
    setRoom(
      { ...room, map },
      `${room.source} ${room.name} ${JSON.stringify([map.start, map.goal])}`,
    );
    update();
    return true;
  }

  function restore() {
    const kept = readStored(KEPT_ROOM);
    if (kept?.map?.obstacles) {
      room = kept;
      changed(kept.key);
      if (kept.source === 'scan') note = fill(text.scan.restored, { name: kept.name });
    }
    session.restore();
  }

  function model() {
    return {
      ready: Boolean(room),
      source: room?.source ?? null,
      note,
      live: { ...session.model(), note: session.note },
      scan: {
        open: Boolean(scan),
        shown: room?.source === 'scan',
        settings,
        floor: scan?.floor ?? null,
        triangles: scan?.triangles ?? 0,
        points: scan?.points ?? 0,
        maxOffset: room?.maxOffset ?? { x: 0, y: 0 },
        offset: room?.offset ?? { x: 0, y: 0 },
      },
      placing,
    };
  }

  return {
    get map() {
      return room?.map ?? null;
    },
    // What render.js draws for the room: the map and, for a robot recording, the driven path.
    get drawing() {
      return room ? { map: room.map, trajectory: room.trajectory } : null;
    },
    get placing() {
      return placing;
    },
    model,
    restore,
    place,
    actions: {
      ...session.actions,
      openScan,
      setScanSetting: setSetting,
      setScanOffset: (axis, value) => setSetting('offset', { ...settings.offset, [axis]: value }),
      startPlacing(what) {
        placing = placing === what ? null : what;
        note = placing ? text.placeHint : '';
        update();
      },
    },
  };
}

export { createRoom, SCAN_DEFAULTS };
