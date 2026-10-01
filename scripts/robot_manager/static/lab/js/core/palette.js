// What a colour means, once for the whole material: every chart and scene takes its colours from
// a role, never from the order of its lines, so "blue" means the same thing in every course.
// Validated with the dataviz skill's palette checker for colour-vision differences on both
// surfaces (charts on white, scenes on the dark #182d38); the pairs that pass only within the
// 6–8 ΔE band (plan vs actual/measured) always come with a second cue — the dash pattern below
// and a direct label — so no role is ever told apart by colour alone.
//
// | role     | meaning (Japanese label to use)                          | line          |
// | actual   | what really happens (実際の値 / シミュレーションの真の値)   | solid, thick  |
// | measured | what the robot measured, estimated or decided with (測った値) | solid, thin + dots |
// | target   | goal / reference / threshold (目標・境目)                 | dashed        |
// | plan     | plan or prediction (計画・予測)                           | dash-dot      |
// | previous | the previous run (前回)                                  | grey, dotted  |
// | event    | a moment something happened (出来事), always labelled    | grey vertical |
// | danger   | contact / emergency (接触・非常停止): status only, with an icon | red      |
// The CSS custom properties in css/tokens.css (--role-*, --scene-role-*) carry the same values.

const CHART_ROLE_COLORS = {
  actual: '#1a9e6e',
  measured: '#2a78d6',
  target: '#a8760a',
  plan: '#b8438a',
  previous: '#9aa5ae',
  event: '#5f6f76',
  danger: '#c62828',
  grid: '#dbe4e6',
  axis: '#4d6469',
};

const SCENE_ROLE_COLORS = {
  actual: '#1f9a6a',
  measured: '#4f86e0',
  target: '#b8800c',
  plan: '#cc5fb4',
  previous: '#8c9aa3',
  event: '#c9d3d8',
  danger: '#ff6b6b',
  grid: '#365059',
  axis: '#a9c0c5',
};

// SVG stroke-dasharray per role (the second cue next to colour); '' = solid.
const ROLE_DASH = {
  actual: '',
  measured: '',
  target: '8 5',
  plan: '10 4 2 4',
  previous: '2 4',
  event: '4 4',
  danger: '',
};

// Stroke widths [px] per role, drawn with vector-effect: non-scaling-stroke so a figure scaled
// down on a phone keeps them.
const ROLE_WIDTH = {
  actual: 3,
  measured: 2,
  target: 2,
  plan: 2,
  previous: 2,
  event: 1.5,
  danger: 2.5,
};

/** `{color, dash, width}` for a role on a chart (`surface: 'chart'`) or a dark scene. */
function roleStyle(role, surface = 'chart') {
  const colors = surface === 'scene' ? SCENE_ROLE_COLORS : CHART_ROLE_COLORS;
  return {
    color: colors[role] ?? colors.axis,
    dash: ROLE_DASH[role] ?? '',
    width: ROLE_WIDTH[role] ?? 2,
  };
}

export { CHART_ROLE_COLORS, SCENE_ROLE_COLORS, ROLE_DASH, ROLE_WIDTH, roleStyle };
