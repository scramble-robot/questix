import { render, nothing } from '../vendor/lit-html.js';
import { loadJson } from '../core/content.js';
import {
  pointInRobot,
  measureRoom,
  MAPPING_ROOM,
  MAPPING_POSES,
  occupancyFromScans,
  localizationRoom,
  localizeOnKnownMap,
  rangeMismatch,
  loopFixture,
  closeLoop,
} from './concepts-core.js';
import {
  poseParts,
  mapParts,
  localizationParts,
  loopParts,
  conceptQuestion,
} from './concepts-view.js';

// The four concept chapters of the SLAM course: state and behaviour. Each one estimates from
// measurements only, never from a reference pose. concepts-view.js turns the model into markup and
// concepts-core.js does the maths. basics.js renders the page frame and leaves a set of empty
// slots, which renderSlamConcept() fills here. Sentences live in content/slam/concepts.json.

const copy = await loadJson('content/slam/concepts.json');

// The chapters of the introductory course, in the order learners work through them. `group` is the
// index of the stage in SLAM_GROUPS.
const SLAM_CHAPTERS = [
  { id: 'pose', title: '位置と向き', group: 0 },
  { id: 'wheels', title: '車輪で移動を測る', group: 0 },
  { id: 'imu', title: 'IMUで向きを測る', group: 0 },
  { id: 'lidar', title: 'LiDARの点を重ねる', group: 1 },
  { id: 'map', title: '見えた範囲を地図にする', group: 1 },
  { id: 'ambiguity', title: '地図から位置を探す', group: 1 },
  { id: 'loop', title: '戻った場所から直す', group: 2 },
];
// Kept in its original tuple form because other modules read it as [id, title, group].
const SLAM_TOPICS = SLAM_CHAPTERS.map(({ id, title, group }) => [id, title, group]);
const SLAM_GROUPS = ['位置と移動を知る', '周囲から地図と位置を求める', 'ずれを確かめて直す'];

// The page frame basics-view.js renders; each chapter fills the same set of slots.
const SLOTS = {
  figureStep: 'basicsFigureStep',
  figureTitle: 'basicsFigureTitle',
  figure: 'basicsFigure',
  calculation: 'basicsCalculation',
  observation: 'basicsObservation',
  controls: 'basicsControls',
  summary: 'basicsSummary',
};

// --- 位置と向き -------------------------------------------------------------------------------

const ROBOT_PLACE = { x: 1, y: 1, theta: 0 }; // metres and radians on the small demonstration map
const LANDMARK_PLACE = { x: 3, y: 1 };
const QUARTER_TURN = Math.PI / 2;

const pose = { turned: false, answer: null };

function poseModel() {
  const theta = pose.turned ? QUARTER_TURN : 0;
  const relative = pointInRobot(LANDMARK_PLACE, { ...ROBOT_PLACE, theta });
  return {
    pose: ROBOT_PLACE,
    landmark: LANDMARK_PLACE,
    turned: pose.turned,
    answer: pose.answer,
    theta,
    relative,
    distance: Math.hypot(relative.x, relative.y),
  };
}

const poseActions = {
  turn() {
    pose.turned = true;
    pose.answer = null;
    show('pose');
  },
  resetPose() {
    pose.turned = false;
    pose.answer = null;
    show('pose');
  },
  answer(choice) {
    pose.answer = choice;
    show('pose');
  },
};

// --- 見えた範囲を地図にする --------------------------------------------------------------------

const DEFAULT_CELL_SIZE = 0.1; // metres per occupancy cell

const map = { view: 0, resolution: DEFAULT_CELL_SIZE, frames: [], note: null };

// The note under the figure explains the learner's last action; on opening the chapter it says
// whether a map from an earlier visit is still there.
function openingMapNote() {
  return map.frames.length ? copy.map.observation.kept : copy.map.observation.opening;
}

function mapModel() {
  return {
    ...map,
    grid: occupancyFromScans(map.frames, { resolution: map.resolution }),
    note: map.note ?? openingMapNote(),
  };
}

const mapActions = {
  setView(view) {
    map.view = view;
    map.note = copy.map.observation.moved;
    show('map');
  },
  setResolution(resolution) {
    map.resolution = resolution;
    map.note = copy.map.observation.resized;
    show('map');
  },
  scanHere() {
    const place = MAPPING_POSES[map.view];
    const repeated = map.frames.some((frame) => frame.view === map.view);
    if (!repeated)
      map.frames.push({
        view: map.view,
        pose: place,
        scan: measureRoom(MAPPING_ROOM, place),
      });
    map.note = repeated ? copy.map.observation.repeated : copy.map.observation.added;
    show('map');
  },
  clearMap() {
    map.frames = [];
    map.note = copy.map.observation.cleared;
    show('map');
  },
  inspectCell(type) {
    map.note = copy.map.cells[type];
    show('map');
  },
};

// --- 地図から位置を探す ------------------------------------------------------------------------

const MEASURED_FROM = { x: 3.7, y: 1.2, theta: 0 }; // where the robot really is, in metres
const CANDIDATE_Y = 1.2; // metres: every candidate sits on the corridor's centre line
const CORRIDOR_RAYS = 72;
const CORRIDOR_RANGE = 2; // metres the LiDAR reaches in this chapter

// `preview` follows the slider while it is dragged; `guess` only moves when it is released, so the
// figure and the chart are not recomputed mid-drag.
const localization = { feature: false, guess: 2.5, preview: 2.5, checked: false };

function localizationModel() {
  const scene = localizationRoom(localization.feature);
  const observed = measureRoom(scene, MEASURED_FROM, CORRIDOR_RAYS, CORRIDOR_RANGE);
  const candidate = { x: localization.guess, y: CANDIDATE_Y, theta: 0 };
  const predicted = measureRoom(scene, candidate, CORRIDOR_RAYS, CORRIDOR_RANGE);
  return {
    feature: localization.feature,
    guess: localization.guess,
    guessInput: localization.preview,
    checked: localization.checked,
    scene,
    observed,
    predicted,
    fit: localizeOnKnownMap(observed, scene),
    error: rangeMismatch(observed, predicted),
  };
}

const localizationActions = {
  searchCandidates() {
    localization.checked = true;
    show('ambiguity');
  },
  previewGuess(metres) {
    localization.preview = metres;
    show('ambiguity');
  },
  setGuess(metres) {
    localization.guess = metres;
    localization.preview = metres;
    show('ambiguity');
  },
  setFeature(present) {
    localization.feature = present;
    localization.checked = false;
    show('ambiguity');
  },
};

// --- 戻った場所から直す ------------------------------------------------------------------------

const START_NODE = 0; // the pose the last measurement really belongs to
const WRONG_NODE = 4; // a corner that looks similar, to show a mistaken correspondence

const fixture = loopFixture();
const loop = { result: null, match: START_NODE };

const loopModel = () => ({ fixture, result: loop.result, match: loop.match });

function adjustLoop(node) {
  loop.match = node;
  loop.result = closeLoop(fixture, node);
  show('loop');
}

const loopActions = {
  closeLoop: () => adjustLoop(START_NODE),
  closeOnWrongCorner: () => adjustLoop(WRONG_NODE),
  resetLoop() {
    loop.result = null;
    loop.match = START_NODE;
    show('loop');
  },
};

// --- rendering --------------------------------------------------------------------------------

const CHAPTERS = {
  pose: () => poseParts(poseModel(), copy.pose, poseActions),
  map: () => mapParts(mapModel(), copy.map, mapActions),
  ambiguity: () => localizationParts(localizationModel(), copy.ambiguity, localizationActions),
  loop: () => loopParts(loopModel(), copy.loop, loopActions),
};

function show(topic) {
  const parts = CHAPTERS[topic]();
  for (const [name, id] of Object.entries(SLOTS)) render(parts[name], document.getElementById(id));
  render(
    conceptQuestion(parts.question, copy.hintSummary),
    document.getElementById('basicsQuestion'),
  );
  // Only 地図から位置を探す has supporting evidence; for the other chapters the card stays folded.
  const evidence = document.getElementById('basicsEvidence');
  evidence.hidden = !parts.evidence;
  render(parts.evidence ?? nothing, evidence);
}

// Entry point used by basics.js when it opens a concept chapter. `art` is the figure toolkit the
// caller renders with; the concept templates take it from basics-view.js themselves.
function renderSlamConcept(topic, art) {
  if (topic === 'map') map.note = null;
  if (topic === 'ambiguity') localization.preview = localization.guess;
  show(topic);
}

export { SLAM_CHAPTERS, SLAM_TOPICS, SLAM_GROUPS, renderSlamConcept };
