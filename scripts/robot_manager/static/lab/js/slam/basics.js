import { toRpm, loadAngleText, loadAngleJson } from '../core/angle-units.js';
import { render } from '../vendor/lit-html.js';
import { lessonGuide, figureGuide } from '../shell/lesson-guide.js';
import {
  wheelExample,
  imuExample,
  beamHit,
  basicsScan,
  scanMismatch,
  matchBasicScan,
} from './basics-core.js';
import { basicsPage, figureArt } from './basics-view.js';
import { SLAM_CHAPTERS, SLAM_GROUPS, renderSlamConcept } from './concepts.js';

// Introductory SLAM chapters: state and behaviour. basics-view.js turns the model into markup and
// basics-core.js does the maths. The three sensor chapters (wheels, IMU, LiDAR) are rendered here;
// the four concept chapters draw themselves into the slots the page leaves for them, through
// renderSlamConcept(). Learner-facing sentences live in content/slam/basics.json.

const copy = await loadAngleJson('content/slam/basics.json');
const wheelsHelpHtml = await loadAngleText('content/slam/basics-wheels-help.html');

const SENSOR_CHAPTERS = ['wheels', 'imu', 'lidar'];
const SLIP_GRIP = 0.8; // one fifth of every wheel turn is lost when the wheels slip
const EXAMPLE_SECONDS = 2; // the wheel example always runs for two seconds
const ODOMETRY_SHIFT = 0.9; // metres the wheels claim the robot moved between the two scans
const SECOND_SCAN_FROM = 0.6; // metres the robot really moved between the two scans

// The controls use rad/s; the existing simulator continues to receive rpm.
const WHEEL_PRESETS = Object.fromEntries(
  Object.entries(copy.wheels.presets).map(([name, rates]) => [
    name,
    { leftRpm: toRpm(rates[0]), rightRpm: toRpm(rates[1]) },
  ]),
);

const toRadians = (degrees) => (degrees * Math.PI) / 180;

let chapterId = 'pose';
let chapterOpened = () => {};

const wheels = { ...WHEEL_PRESETS.straight, slipping: false };
const imu = { rate: 30, seconds: 3, distance: 0.6 }; // °/second, seconds, metres
const lidar = { beam: 30, mapping: false, shift: ODOMETRY_SHIFT, matched: false }; // °, …, metres

// The two demonstration scans never change: the same room, measured from two known places.
const firstScan = basicsScan();
const secondScan = basicsScan(SECOND_SCAN_FROM);

const page = () => document.getElementById('slamBasics');
const chapter = () => SLAM_CHAPTERS.find((entry) => entry.id === chapterId);

// The LiDAR chapter has two halves, each with its own lesson brief.
function lessonKey() {
  if (chapterId === 'lidar' && lidar.mapping) return 'slam-lidar-match';
  return 'slam-' + chapterId;
}

function wheelsModel() {
  return {
    ...wheels,
    estimate: wheelExample(wheels.leftRpm, wheels.rightRpm),
    actual: wheelExample(wheels.leftRpm, wheels.rightRpm, EXAMPLE_SECONDS, SLIP_GRIP),
  };
}

function imuModel() {
  return { ...imu, result: imuExample(imu.rate, imu.seconds, imu.distance) };
}

function lidarModel() {
  return {
    ...lidar,
    hit: beamHit(toRadians(lidar.beam)),
    firstScan,
    secondScan,
    error: Math.sqrt(scanMismatch(firstScan, secondScan, lidar.shift)),
  };
}

function buildModel() {
  const current = chapter();
  const key = lessonKey();
  const model = {
    topic: chapterId,
    concept: !SENSOR_CHAPTERS.includes(chapterId),
    groups: SLAM_GROUPS,
    group: current.group,
    groupTopics: SLAM_CHAPTERS.filter((entry) => entry.group === current.group),
    brief: lessonGuide(key),
    figureGuide: figureGuide(key),
    // Only "地図から位置を探す" shows the evidence card, and it reveals the card itself.
    evidenceShown: false,
  };
  if (chapterId === 'wheels') model.wheels = wheelsModel();
  if (chapterId === 'imu') model.imu = imuModel();
  if (chapterId === 'lidar') model.lidar = lidarModel();
  return model;
}

function update() {
  render(basicsPage(buildModel(), copy, wheelsHelpHtml, actions), page());
  if (SENSOR_CHAPTERS.includes(chapterId)) return;
  renderSlamConcept(chapterId, figureArt);
}

// Opening another chapter rebuilds the page, so details, focus and scroll start fresh; within a
// chapter update() patches in place.
function openChapter(id) {
  chapterId = id;
  render(null, page());
  update();
  chapterOpened(id);
}

const actions = {
  openGroup(index) {
    openChapter(SLAM_CHAPTERS.find((entry) => entry.group === index).id);
  },
  openTopic: openChapter,
  useWheelPreset(name) {
    Object.assign(wheels, WHEEL_PRESETS[name]);
    update();
  },
  setLeftRpm(rpm) {
    wheels.leftRpm = rpm;
    update();
  },
  setRightRpm(rpm) {
    wheels.rightRpm = rpm;
    update();
  },
  setSlipping(slipping) {
    wheels.slipping = slipping;
    update();
  },
  setTurnRate(degreesPerSecond) {
    imu.rate = degreesPerSecond;
    update();
  },
  setTurnSeconds(seconds) {
    imu.seconds = seconds;
    update();
  },
  setDriveDistance(metres) {
    imu.distance = metres;
    update();
  },
  setBeam(degrees) {
    lidar.beam = degrees;
    update();
  },
  startMapping() {
    lidar.mapping = true;
    lidar.shift = ODOMETRY_SHIFT;
    lidar.matched = false;
    update();
  },
  restartMeasuring() {
    lidar.mapping = false;
    lidar.matched = false;
    update();
  },
  setShift(metres) {
    lidar.shift = metres;
    lidar.matched = false;
    update();
  },
  matchScans() {
    lidar.shift = matchBasicScan(firstScan, secondScan).shift;
    lidar.matched = true;
    update();
  },
};

// ui.js assembles the whole SLAM page as one HTML string, so the course hands it an empty section
// and fills it with lit-html once initSlamBasics() runs.
const basicsTemplate = () => '<section id="slamBasics"></section>';

// `onChapter(id)` hears every chapter that opens, so ui.js can report where the learner is to the
// shared experiment footer (which also moves on to the 総合実験 after the last chapter).
function initSlamBasics(onChapter) {
  chapterOpened = onChapter;
  openChapter(chapterId);
}

function reviewSlamBasics(id) {
  if (!SLAM_CHAPTERS.some((entry) => entry.id === id)) return false;
  openChapter(id);
  return true;
}

export {
  wheelExample,
  imuExample,
  basicsScan,
  scanMismatch,
  matchBasicScan,
  basicsTemplate,
  initSlamBasics,
  reviewSlamBasics,
};
