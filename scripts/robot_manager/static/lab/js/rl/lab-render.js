import { SCENE_ROLE_COLORS } from '../core/palette.js';
import { drawOutcomeMark } from './outcome-marks.js';

// Outcome marks on the lab's test map. core/renderer.js draws the map itself (floor, shelves,
// goal); this module adds one mark per test run at its start, in the symbols the whole course uses
// (● arrived, × contact, △ timed out or stopped otherwise). Holds no state.

// Mirrors thumbnailBox() and START_MAP_PADDING of core/renderer.js's drawStartMap, which does not
// export them: the marks must land exactly where that map puts the room.
const START_MAP_PADDING = 22; // canvas pixels
const MARK_SIZE = 6; // canvas pixels: half the width of a mark on a full-size map
const MARK_GROWTH = 0.75; // how much of the shrinking a mark makes up for on a narrow screen
const OUTCOME_COLOURS = {
  arrived: SCENE_ROLE_COLORS.actual,
  contact: SCENE_ROLE_COLORS.danger,
  timeout: SCENE_ROLE_COLORS.target,
};

function mapBox(canvas, env) {
  const scale = Math.min(
    (canvas.width - START_MAP_PADDING * 2) / env.width,
    (canvas.height - START_MAP_PADDING * 2) / env.height,
  );
  return {
    scale,
    x: (canvas.width - env.width * scale) / 2,
    y: (canvas.height - env.height * scale) / 2,
  };
}

const outcomeOf = (result) => {
  if (result.success) return 'arrived';
  return result.collision ? 'contact' : 'timeout';
};

/** Draws the start mark of every test result on a map drawn by drawStartMap. */
function drawStartMarks(canvas, env, results) {
  const context = canvas.getContext('2d');
  const box = mapBox(canvas, env);
  const shown = canvas.getBoundingClientRect().width;
  const unitsPerPixel = shown > 0 ? canvas.width / shown : 1;
  const size = MARK_SIZE * Math.max(1, unitsPerPixel * MARK_GROWTH);
  for (const result of results) {
    const start = result.trace[0].state;
    const point = { x: box.x + start.x * box.scale, y: box.y + start.y * box.scale };
    const outcome = outcomeOf(result);
    drawOutcomeMark(context, point, outcome, size, OUTCOME_COLOURS[outcome]);
  }
}

export { drawStartMarks };
