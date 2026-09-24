# Writing code for QUESTiX LAB

The reference implementation is the path-planning course: `js/planning/` with
`content/planning.json`. New and rewritten code follows it.

## Layers (one directory per course)

| File                    | Role                          | Rules                                                                                                                                                                                  |
| ----------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core.js`               | Maths, simulation, parsing    | No DOM, no `window`. Importable from Node, unit-testable.                                                                                                                              |
| `render.js`             | Canvas / SVG drawing          | Draws from plain data handed in by `ui.js`. Holds no state.                                                                                                                            |
| `view.js`               | lit-html templates            | Pure functions `model → TemplateResult`. No state, no `document.*`, no side effects. Events are bound in the template (`@click=${actions.x}`).                                         |
| `ui.js`                 | State and behaviour           | Owns the state, builds the `model`, implements `actions`, calls `render(view(model), container)` from one `update()` function, exports the `init… / activate… / review…` entry points. |
| `content/<course>.json` | Every learner-facing sentence | Loaded with `loadJson` (top-level await). Rich fragments (lists, links) go to `content/<course>/*.html`; downloadable scripts and procedures are real files.                           |

Short labels (button captions, table headers, units) may stay in `view.js`. Anything that reads as
a sentence, an explanation, or a status message belongs in the content file.

## Style

- Names say what the value is: `experiment`, `sample`, `clearance` — not `s`, `q`, `c`. Single
  letters are fine for loop indices and for the symbols of a formula written next to it
  (`x`, `y`, `theta`, `dt`, `v`, `w`), with the unit in a comment or the name.
- One declaration per statement (`const a = 1;` `const b = 2;`), never `const a = 1, b = 2;`.
- No nested ternaries. Use a small function with early returns (see `playButtonLabel`).
- Magic numbers become named constants with their unit: `const SAMPLE_PERIOD = 0.04; // seconds`.
- Functions do one thing and fit on a screen (about 40 lines). Templates are split into parts
  named after what the learner sees (`mapCard`, `controlPanel`, `resultsCard`).
- No `innerHTML` with interpolated values and no `getElementById(...).onclick = …` wiring.
  Status text, labels, disabled/hidden flags are part of the model, not poked into the DOM.
  Reading a canvas or an element's geometry by id is fine.
- Strings from other modules that are already HTML (`lessonBrief`, `schoolTips`, `lessonLabel`)
  are inserted with `unsafeHTML`; never pass learner input or robot data through it.
- Comments explain why (a constraint, a unit, a trap), not what the next line does.
- Shared helpers live in `js/core/` (`content.js`, `dom.js`); do not re-declare `download`, number
  formatting, or the `{name}` placeholder filler per module. `fillSentence(sentence, values)` from
  `js/core/content.js` fills the placeholders of a content sentence; a placeholder with no value is
  left as it is, so a missing key shows up as `{rpm}` rather than as the word "undefined".
- Format with Prettier (`.prettierrc.json`); third-party code in `js/vendor/` is left as upstream.

## lit-html notes

- Import everything from `js/vendor/lit-html.js` (`html`, `svg`, `render`, `nothing`,
  `unsafeHTML`, `unsafeSVG`, `classMap`, `styleMap`, `ifDefined`, `live`, `ref`, `repeat`).
- Boolean attributes: `?disabled=${…}`, `?hidden=${…}`. Live form state: `.value=${…}`,
  `.checked=${…}`.
- Opening another topic rebuilds the page (`render(null, container)` then `update()`), so
  `<details>`, focus and scroll start fresh; within a topic, `update()` patches in place.
- `shell/supplement-ui.js` inserts a button before every `details[data-help-dialog]` and moves
  the details' children into a shared dialog while it is open. That is compatible with lit as
  long as such a `<details>` is not conditionally swapped while its dialog is open; pause
  animations on the `supplement-open` event as the courses already do.
- Module entry points and other exports keep their names, signatures and return types; other
  modules depend on them.

## Figures and charts (for high-school learners on phones and Chromebooks)

The learners are 高校1〜2年, often on a 390 px phone or a 1366×768 Chromebook. A figure that is
exact but unreadable teaches nothing. Every new or reworked figure follows these rules:

- **Readable text at any width.** No text smaller than 12 px on screen (`--figure-text-min`). A
  figure authored in an 800-unit viewBox and shrunk to 352 px turns 14-unit labels into 6 px, so:
  put legends, axis titles, key readouts and tick labels in HTML next to or over the figure, or
  give narrow screens their own viewBox. Lines keep their width with
  `vector-effect="non-scaling-stroke"` (≥ 2 px).
- **Colour means a role, never a position.** Take colours from `js/core/palette.js`
  (`roleStyle(role, 'chart' | 'scene')`, CSS `--role-*` / `--scene-role-*`): actual = green solid,
  measured / estimated / used for a decision = blue, target / threshold = amber dashed, plan /
  prediction = magenta dash-dot, previous run = grey dotted, event = grey labelled vertical line,
  danger = red with an icon. The same quantity has the same colour in the scene and in its chart.
  Never colour lines by their order in a list.
- **Never by colour alone.** Each line or mark also has a dash pattern or shape and a direct label
  (at the line's end, or on the mark). Learner text names things by shape and label
  (「白い実線の止まりたい線」「▼ブレーキ開始」), not by colour alone.
- **Axes that can be read.** Use `niceScale` / `formatTick` from `js/core/chart-scale.js`: round
  ticks, zero on the axis for signed quantities (draw the zero line thicker), whole ticks for
  counts. Fix the range once per run (plus the previous run shown with it) — never recompute it
  from the samples played so far. The y axis says the quantity and unit (「速さ（m/秒）」), the x
  axis 「開始からの時間（秒）」. Two charts that share a time axis share its left/right edges.
- **Events are marked where they happen.** Anything the text asks the learner to look for (a
  load change, contact, a state change, a stop) is a labelled vertical line on the chart and an
  entry in 起きたこと; repeated events are grouped (「見直し 12回（0.3秒ごと）」).
- **Press → see, on one screen.** After a button starts or changes something, the part to watch
  is on screen: scroll to it (as the systems courses do with `scrollToScene`) or show the result
  right under the button. On a phone the chart the text refers to is next to the scene, not two
  screens below.
- **Say what it means.** A result card ends with one sentence that uses the measured numbers
  (「線を52 cm越えました。ブレーキを約0.9 m手前で始めれば止まれます。」), and only shows metrics
  the topic is about; a setting that has no effect in the current mode is disabled with the
  reason next to it.
- **Words.** Define a term where it first appears (or link the 補足); units are written the same
  way everywhere (m/秒, rad/秒, rpm, cm); a sentence refers to controls by their visible label.

## Taking measurements from the real robot

A lesson never talks to `robot-link.js` directly. It creates a session with `createLiveSession`
(`js/live/live-session.js`), which records every lesson stream through `recordRobot` in
`js/live/capture.js`, opens saved recordings and rosbags, saves JSON/CSV and keeps the last recording
across a reload. The lesson only supplies `apply(recording)`, which turns the recording into its own
numbers with the DOM-free helpers of `js/live/recording-core.js` (`driveRows`, `wallRows`,
`drivesOf`) and `js/live/capture-core.js`, and shows `liveCaptureControls` from
`js/live/live-view.js` with the session's `model()`, so every course offers the same block: link
state, which stream is missing, record / stop, open / save.

- `capture-core.js`, `recording-core.js` and `rosbag-core.js` have no DOM and no WebSocket, so every
  rule about what counts as a measurement is a Node test (`test/live-capture-core.test.mjs`,
  `test/recording-core.test.mjs`, `test/rosbag-core.test.mjs`).
- Derive numbers from the message stamps (`pairByStamp`), never from arrival order: a reopened file
  or a rosbag must give the same result as the live recording.
- Only `js/live/drive-link.js` sends frames to the robot. A lesson that drives passes
  `drive: { plan, program, placement, conditions, startLabel }` to `createLiveSession` (see its doc
  comment): `plan()` returns a `controller(elapsed, robot)` built from `js/live/drive-core.js`
  (programs, odometry goals) or a DOM-free module of the course (`js/control/live-drive.js`), plus
  optional `outcome()` and chart `references`; `placement()` is its own line (how much room, where
  to put the robot), `conditions()` a few words for the run history. The shared block shows one
  learner reason at a time, folds the teacher's details, and puts the result under the button.
  A run's own stop is scoped to the page (`scope: 'mine'`); only the stop bar stops any run. Never bypass the bridge's checks from the
  page, and give a closed-loop controller its own guards (stale sensor → stand still, minimum
  distance → throw an Error with the learner's sentence). Declare the topic's `drive` run mode in
  `content/shell/run-modes.json` and put `runModeBadgeHtml('drive')` in the block's heading.
- A recording replaces the lesson's data instead of being mixed into it, and says what the
  conditions were (`captureNotes`, and where it came from), so a learner can tell measured numbers
  from generated ones.
- When a topic gains (or loses) a way to use the robot, update its entry in
  `content/shell/run-modes.json` in the same change (course `modes` and `real`, topic `keys`,
  `note` and the `target` selector of the robot block), so the labels never promise something the
  page does not offer. Put `runModeBadgeHtml('live' | 'data')` in the heading of the robot block.
- Only offer a recording where the robot actually measures the quantity. Where it measures one side
  only, take that side automatically and let the learner type the other (the SLAM scenario of the
  measurement lab); where it measures neither, say so (the launch scenario) instead of hiding the
  option.
- Place LiDAR points with `scanMount(scan)` (capture-core): the bridge attaches the mount from TF,
  `rosbag-core.js` reads it from `/tf_static`, and `LIDAR_DEFAULT_MOUNT` mirrors
  `launcher/launch/lidar_driver.launch.xml` for older recordings. Never assume the LiDAR sits at the
  centre of the robot.
- `rosbag-core.js` ports `questix_lab_bridge/questix_lab_bridge/messages.py`; change the two
  together. Its test runs against `test/fixtures/drive-approach.mcap`, written by rosbag2 itself —
  regenerate it with `test/fixtures/make-rosbag-fixture.py` (needs ROS 2 and a built
  `questix_msgs`, see the script) when the messages change.

Adding such a block is a visible change, so the UI-regression run for that route reports the block
itself as a difference; check that the differing lines are only the new block, then take a fresh
baseline. Without a robot, the flow can be exercised end to end by feeding
`questix_lab_bridge.ws_server.LabWebSocketServer` synthetic payloads (no ROS needed) and driving the
page over the Chrome DevTools protocol.

## Proving that learners see the same thing

`test/ui-regression.mjs` drives a baseline copy of the site and the working copy through the same
steps in headless Chrome (fake clock, seeded `Math.random`) and diffs a canonical serialisation
of the visible DOM, including a pixel hash of every canvas:

```bash
cp -r scripts/robot_manager/static/lab /tmp/lab-baseline        # before you start
node test/ui-regression.mjs --baseline /tmp/lab-baseline --route planning
node test/ui-regression.mjs --baseline /tmp/lab-baseline --route planning --steps test/steps/planning.json
```

Without `--steps` it opens every chapter/topic button and presses each primary button once.
`--dump <dir>` also writes every snapshot to files; review an intended change (a new block) with
`diff -ru <dir>/baseline <dir>/candidate`, which realigns after an insertion. Add a
`test/steps/<course>.json` that exercises the controls the crawl does not reach (sliders,
checkboxes, examples, secondary buttons). A difference must be either fixed or a deliberate,
documented bug fix (list it under "Known intentional differences" below) — never silenced.

DOM-free modules get Node tests in `test/*.test.mjs` (`node --test test/*.test.mjs`). Tests that pin
behaviour to the site before the refactor import the copies in `test/baseline/` (see its README), so
they run in CI as well; `LAB_BASELINE=<dir>` additionally enables the few comparisons that need a
whole copy of the site.

## Known intentional differences from the single-file original

- Planning: the playback position slider never worked (the handler paused first, which wrote the
  current position back into the slider before its new value was read). It works now.
- Planning: the saved hardware procedure (`.txt`) has line breaks between paragraphs.
- SLAM: the hint that a previous result is still on screen (`画面には、前の実験結果を残しています。`)
  was only refreshed when the method or the calibration checkbox changed, so it went stale after
  selecting an earlier run from the results card — the page then claimed the displayed result
  matched the selected conditions when it did not. It is now derived from the run on screen.
- Vision: the 面積 slider's read-out was created with the suffix `画素以上` but its update handler
  wrote `画素`, so the number changed meaning as soon as the learner dragged it. It now always
  says `…画素以上`.
- Vision: the stereo chapter's 実際の奥行き read-out printed the distance raw when the chapter
  opened (`2 m`) and with one decimal after a drag (`2.0 m`). The slider steps in 0.1 m, so it
  now always shows one decimal.
- Reinforcement learning: the caption under the arena has a 「一時停止中。…」 branch that could not
  be reached. Pausing playback updated the button glyph from `updatePlayback()`, but the caption is
  written by `updateScene()`, which stops running once playback stops — so after pressing Ⅱ the page
  still claimed it was playing. The caption is now derived from the playback state.
- Reinforcement learning (structural, nothing a learner sees): the lab page is rendered once at
  start-up and kept hidden until it is opened, where the original left `#labPage` empty until then.
  Snapshots are unaffected — the serializer does not descend into a hidden element — but a steps
  file must not pick controls by position across the whole page, because the hidden lab now
  contributes elements. Open the lab with `[data-rl-group="3"]` and address its controls by id.

## Snapshot files that are advisory, not gates

- `test/steps/rl-lab-trials.json` drives seed-dependent training and evaluation. Nearly every one of
  its snapshots is reported UNSTABLE (the baseline does not reproduce itself there), so it is useful
  for spotting page errors, not for proving equality. The deterministic cover is
  `test/steps/rl-lab.json` plus `test/rl-experiment.test.mjs`.
