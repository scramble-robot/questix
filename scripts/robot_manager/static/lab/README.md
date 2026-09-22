# QUESTiX LAB

Browser-based teaching material for the QUESTiX robot: 13 courses (mechanics, control, SLAM,
vision, path planning, reinforcement learning, …) in which learners set a condition, run an
experiment in an **in-browser simulator**, observe the result, and improve it. With the
`questix_lab_bridge` node running, the same pages also **observe the real robot** (read-only).

Ways to open it:

- **With a robot:** press **配信開始** on the **教材** tab of Questix Robot Manager (or run
  `ros2 launch questix_lab_bridge lab_bridge.launch.xml`) and open `http://<robot-ip>:8897/`
  on any device in the same network. The bridge serves these files and the page connects to
  the robot automatically.
- **On the robot itself:** `robot_manager` serves it at `http://localhost:8888/lab/`.
- **Simulator only (no robot):** it is a static site with no build step, so any static file
  server works:

```bash
python3 -m http.server 8000 -d scripts/robot_manager/static/lab   # http://localhost:8000
```

Opening `index.html` via `file://` does not work: ES modules need HTTP.

## Layout

| Path | Contents |
| --- | --- |
| `index.html` | Page shell: header, one `<section>` per course, dialogs. |
| `css/` | Stylesheets, linked in cascade order by `index.html` (later sheets override earlier ones, so keep the order). `live.css` is the robot monitor. |
| `js/main.js` | Entry point; imports every module in evaluation order. |
| `js/core/` | Shared simulation engine (`engine.js` re-exports `engine/`), canvas renderer, depth-camera maths, and the content loader (`content.js`: `loadJson` / `loadText` / `fillSentence`). |
| `js/shell/` | Course catalogue, navigation, lesson briefs/guides, school-subject tips, supplements. |
| `js/rl/`, `slam/`, `vision/`, `control/`, `planning/`, `launch/`, `arm/`, `systems/` | One directory per course family: `core` (maths, no DOM), `render` (canvas/SVG), `view` (lit-html templates), `ui` (state, actions, one `update()`). Larger courses split these further, e.g. `slam/basics-*`, `vision/depth-*`, `rl/lab-view.js`. |
| `js/quiz/` | Checkpoint quizzes and mastery tests. |
| `js/live/` | Live link to a real robot: `robot-link.js` (WebSocket client), `live-ui.js` (header button + monitor dialog), `capture-core.js` (DOM-free maths on a recording), `capture.js` (records a stretch of live data for any lesson), `live-view.js` (the shared record/連携 controls), `slam-recorder.js` (shapes a SLAM log from a recording). |
| `js/vendor/`, `assets/vendor/` | Third-party code and data; see `assets/vendor/NOTICE.md`. |
| `test/` | Node tests for DOM-free modules (`node --test .../test/*.test.mjs`), the UI regression harness (`ui-regression.mjs`) and the per-course steps files it replays (`test/steps/`). |

`core` modules have no DOM access and can be imported from Node for tests.

## Simulator and real robot

| Lesson | Simulator | Real robot (live link) |
| --- | --- | --- |
| Any page | — | Header **実機** button: LiDAR view, camera, commanded vs measured wheel RPM, pose, E-stop state. |
| Vision | Generated scenes, opened image files, webcam | **実機カメラの画像を使う** feeds the newest robot camera frame into the same processing as an opened file (colour extraction, markers, face detection, …). |
| SLAM | Generated sensor logs | **実機から15秒記録する** records LiDAR + wheel feedback into the same `robo-lab-sensors-v1` log the lesson imports from a file, through the same validation. No IMU stream exists, so `gyroZ` is 0 and the LiDAR mount offset is assumed to be zero. |
| Feedback control (speed topics) | Simulated PID runs | **実機で同じ実験をして重ねる** records `/drive_status` against `/target_twist` and draws the measured wheel speed on the same axes as the simulated run, so the two can be compared directly. The distance topics say why they cannot show it. |
| Measurement lab (under control) | Worked example, CSV | **実機で記録する** turns a recording into the table: each command held for at least 2 s becomes one input, with repeats taken after it has settled. Rows are never marked as check data — that stays the learner's decision. |
| All others | In-browser models | Existing offline workflow: download the ROS 2 script or procedure, import CSV/JSON. |

Every recording goes through `js/live/capture.js`, so the connection checks, the timeout, the abort
and the learner-facing messages exist once; `capture-core.js` holds the arithmetic and is covered by
`test/live-capture-core.test.mjs`. The page never sends anything to the robot. Browsers only allow `getUserMedia` (webcam) on
`localhost` or HTTPS; the robot camera button has no such restriction.

## Licensing rule

Everything shipped here must be permissively licensed (MIT/BSD/Apache-2.0/public domain). The
original single-file edition used YOLOv10n (AGPL-3.0) with an Ultralytics sample photo; that
chapter was replaced by face detection with pico.js (MIT), and colour recognition lives in the
"まとまりを見つける" chapter. Record any new third-party file in `assets/vendor/NOTICE.md`.

## Provenance

Split mechanically from the single-file `QUESTiX-LAB.html` (one `<style>`, one `<script>` with
60 IIFE modules → ES modules with the same names and order). The split was verified by comparing
the rendered DOM of both editions on 17 routes in headless Chrome before any content change.
Module bodies are unchanged apart from `import`/`export` lines; most are still densely written.
