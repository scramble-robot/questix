// The teaching images of the vision course, drawn from numbers so that every experiment starts
// from the same picture: one coloured object (a box or a ball) on a floor with a perspective grid,
// plus the ten test images the classifier is measured on. No DOM, no randomness.

const WIDTH = 320;
const HEIGHT = 220;
const OPAQUE = 255;

const OBJECT_COLORS = {
  red: [213, 77, 53],
  blue: [46, 113, 209],
  green: [63, 158, 103],
};
const KIND_BOX = 0; // 荷箱: a square seen head on. Any other kind is a ball (ボール).

// The object moves and grows a little with the variant, so the learner never sees twice the same
// picture while the task stays the same.
const CENTER_X = 155;
const CENTER_Y = 126;
const CENTER_STEP_X = 14; // px between variants, left/centre/right
const CENTER_STEP_Y = 4;
const BASE_SIZE = 48; // px, half the width of the box / the radius of the ball
const SIZE_STEP = 3;

const HORIZON_Y = 80; // px; below this line the picture shows the floor
const FLOOR_LEVEL = 179;
const FLOOR_GRID_LEVEL = 159;
const WALL_LEVEL = 204;
const GRID_SPACING_Y = 35; // px between the floor lines running across the picture
const GRID_VANISH_Y = 50; // px; the lines running away from the camera meet here
const GRID_SPREAD = 70;
const GRID_SPACING_X = 50;
const GRID_LINE_WIDTH = 1.2;

const BOX_SHADED_SIDE = 0.6; // fraction of the box width that is lit; the rest is the shaded side
const BOX_SIDE_SHADE = 0.8;
const BOX_EDGE_SHADE = 0.8; // the painted edges of the box
const BOX_EDGE_WIDTH = 4; // px either side of the centre line
const BOX_LID_HEIGHT = 7; // px of lid visible at the top
const BALL_MIN_SHADE = 0.55;
const BALL_SHADE_RANGE = 0.4;

// A second red thing in the corner, for "背景にも赤い物を置く".
const CLUTTER = { left: 258, right: 298, top: 42, bottom: 76, color: [200, 68, 50] };

// A fixed pattern that stands in for sensor noise; it must not change between runs.
const NOISE_PERIOD = 7;
const NOISE_AMPLITUDE = 0.5;

const TEST_SET_SIZE = 10;
const TEST_SAME_COLOR = 4; // the first entries keep the colours the learner was taught
const TEST_DARK_FROM = 8; // the last entries are photographed in a darker room
const TEST_DARK_LIGHT = 0.6;
const TEST_FIRST_VARIANT = 10; // variants the learner has not been shown while labelling

const floorLevel = (x, y) => {
  if (y <= HORIZON_Y) return WALL_LEVEL;
  const onCrossLine = y % GRID_SPACING_Y === 0;
  const awayLine = Math.abs(((x - WIDTH / 2) / (y - GRID_VANISH_Y)) * GRID_SPREAD) % GRID_SPACING_X;
  if (onCrossLine || awayLine < GRID_LINE_WIDTH) return FLOOR_GRID_LEVEL;
  return FLOOR_LEVEL;
};

// How brightly the object is lit at this point: the box has one shaded side and painted edges,
// the ball is shaded round its rim.
function objectShade(kind, dx, dy, size) {
  if (kind !== KIND_BOX)
    return (
      BALL_MIN_SHADE +
      BALL_SHADE_RANGE * Math.sqrt(Math.max(0, 1 - (dx * dx + dy * dy) / (size * size)))
    );
  return dx > size * BOX_SHADED_SIDE ? BOX_SIDE_SHADE : 1;
}

const isInsideObject = (kind, dx, dy, size) =>
  kind === KIND_BOX ? Math.abs(dx) < size && Math.abs(dy) < size : dx * dx + dy * dy < size * size;

const isBoxEdge = (kind, dx, dy, size) =>
  kind === KIND_BOX && (Math.abs(dx) < BOX_EDGE_WIDTH || dy < -size + BOX_LID_HEIGHT);

function makeVisionImage({
  kind = 0,
  color = 'red',
  light = 1,
  variant = 0,
  clutter = false,
} = {}) {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  const centerX = CENTER_X + ((variant % 3) - 1) * CENTER_STEP_X;
  const centerY = CENTER_Y + (variant % 2) * CENTER_STEP_Y;
  const size = BASE_SIZE + (variant % 4) * SIZE_STEP;
  const paint = (x, y) => {
    const dx = x - centerX;
    const dy = y - centerY;
    const level = floorLevel(x, y);
    let rgb = [level, level + 3, level + 4];
    if (isInsideObject(kind, dx, dy, size)) {
      const shade = objectShade(kind, dx, dy, size);
      rgb = (OBJECT_COLORS[color] || OBJECT_COLORS.red).map((value) => value * shade);
      if (isBoxEdge(kind, dx, dy, size)) rgb = rgb.map((value) => value * BOX_EDGE_SHADE);
    }
    if (clutter && x > CLUTTER.left && x < CLUTTER.right && y > CLUTTER.top && y < CLUTTER.bottom)
      rgb = CLUTTER.color;
    return rgb;
  };
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const pixel = (y * WIDTH + x) * 4;
      const noise = (((x * 13 + y * 7 + variant) % NOISE_PERIOD) - 3) * NOISE_AMPLITUDE;
      paint(x, y).forEach((value, channel) => {
        data[pixel + channel] = Math.max(0, Math.min(255, value * light + noise));
      });
      data[pixel + 3] = OPAQUE;
    }
  return { width: WIDTH, height: HEIGHT, data };
}

// Held back from the learner while they label images, so the score means something.
function testColor(index) {
  const box = index % 2 === KIND_BOX;
  if (index >= TEST_SAME_COLOR) return box ? 'blue' : 'red';
  return box ? 'red' : 'blue';
}

function testCondition(index) {
  if (index < TEST_SAME_COLOR) return 'いつもの色';
  if (index < TEST_DARK_FROM) return '色を入れ替え';
  return '暗い場所';
}

function visionTestSet() {
  return Array.from({ length: TEST_SET_SIZE }, (_, index) => ({
    id: 'test-' + index,
    label: index % 2,
    condition: testCondition(index),
    image: makeVisionImage({
      kind: index % 2,
      color: testColor(index),
      light: index >= TEST_DARK_FROM ? TEST_DARK_LIGHT : 1,
      variant: TEST_FIRST_VARIANT + index,
    }),
  }));
}

export { makeVisionImage, visionTestSet };
