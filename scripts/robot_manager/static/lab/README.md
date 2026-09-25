# QUESTiX LAB

Browser-based teaching material for the QUESTiX robot: 14 courses (motors, mechanics, control,
SLAM, vision, path planning, reinforcement learning, …) in which learners set a condition, run an
experiment in an **in-browser simulator**, observe the result, and improve it. With the
`questix_lab_bridge` node running, the same pages also **observe the real robot**, and — on a robot
where driving has been allowed — run **low-speed driving experiments** on it.

Ways to open it:

- **With a robot:** the bridge starts with Robot Manager (or with **配信開始** on its **教材**
  tab; by hand: `ros2 launch questix_lab_bridge lab_bridge.launch.xml`). Open
  `http://<robot-ip>:8897/` on any device in the same Wi-Fi — the 教材 tab shows it as a QR code.
  The bridge serves these files and the page connects to the robot automatically.
- **On the robot itself:** `robot_manager` serves it at `http://localhost:8888/lab/`.
- **Simulator only (no robot):** it is a static site with no build step, so any static file
  server works:

```bash
python3 -m http.server 8000 -d scripts/robot_manager/static/lab   # http://localhost:8000
```

Opening `index.html` via `file://` does not work: ES modules need HTTP.

Elsewhere the header's **実機** button opens the connection dialog. It takes the address as Robot
Manager shows it (`http://10.42.0.1:8897/`), a `ws://` address, or a bare host / `host:port`, and
connects to the bridge's WebSocket on port 8897; `:8888` (Robot Manager itself) is refused with an
explanation. `js/live/robot-link.js` gives up an attempt after 6 s and says why in the learner's
words: unreachable host, no bridge answering, the bridge's client limit (close code 1013, retried
every 15 s), or — on a page served by the bridge — the stream stopped. Until a connection has worked
the address stays editable; only a link that was open and dropped is shown as つながり直しています….
Once open, the dialog shows the robot's name, its `ROS_DOMAIN_ID` and whether lessons may drive it
(from the bridge's `hello`), and warns when no stream has delivered anything for 4 s. These rules are
Node tests (`test/robot-link.test.mjs`, fake WebSocket and mocked timers).

## Layout

| Path                                                                                           | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.html`                                                                                   | Page shell: header, one `<section>` per course, dialogs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `css/`                                                                                         | Stylesheets, linked in cascade order by `index.html` (later sheets override earlier ones, so keep the order). `live.css` is the robot monitor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `js/main.js`                                                                                   | Entry point; imports every module in evaluation order.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `js/core/`                                                                                     | Shared simulation engine (`engine.js` re-exports `engine/`), canvas renderer, depth-camera maths, and the content loader (`content.js`: `loadJson` / `loadText` / `fillSentence`).                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `js/shell/`                                                                                    | Course catalogue, navigation, lesson briefs/guides, school-subject tips, supplements.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `js/rl/`, `slam/`, `vision/`, `motor/`, `control/`, `planning/`, `launch/`, `arm/`, `systems/` | One directory per course family: `core` (maths, no DOM), `render` (canvas/SVG), `view` (lit-html templates), `ui` (state, actions, one `update()`). Larger courses split these further, e.g. `slam/basics-*`, `vision/depth-*`, `rl/lab-view.js`.                                                                                                                                                                                                                                                                                                                                                                              |
| `js/quiz/`                                                                                     | Checkpoint quizzes and mastery tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `js/live/`                                                                                     | Live link to a real robot: `robot-link.js` (WebSocket client), `live-ui.js` (header button + monitor dialog), `capture-core.js` (DOM-free maths on a recording), `recording-core.js` (the saved recording format, CSV, stamp pairing), `rosbag-core.js` (reads a robot rosbag `.mcap` in the browser), `capture.js` (records a stretch of live data for any lesson, opens and saves files), `live-session.js` (state behind one record/open/save block), `live-view.js` (the shared record/連携 controls), `robot-state*.js` (the 「実機の状態」 panel and its memo), `slam-recorder.js` (shapes a SLAM log from a recording). |
| `js/vendor/`, `assets/vendor/`                                                                 | Third-party code and data; see `assets/vendor/NOTICE.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/`                                                                                        | Node tests for DOM-free modules (`node --test .../test/*.test.mjs`), the UI regression harness (`ui-regression.mjs`) and the per-course steps files it replays (`test/steps/`).                                                                                                                                                                                                                                                                                                                                                                                                                                                |

`core` modules have no DOM access and can be imported from Node for tests.

## Simulator and real robot

Learners see what each experiment runs on from four labels: **シミュレーション** (the in-browser
model; no robot needed), **実機と連携** (values taken from the connected robot, read-only),
**実機を動かす** (the page drives the robot itself, only where driving is allowed) and
**実機で測って入力** (numbers measured on the robot, typed in or opened as a file). They appear on the
catalogue cards (with a legend), in the course switcher, in the first row of every experiment's
brief (with a button that scrolls to the robot block) and on the robot blocks themselves. Which
course and topic uses which label is declared once in `content/shell/run-modes.json` and read by
`js/shell/run-mode.js`; `test/run-mode.test.mjs` checks that the declarations agree with each other
and name real topics.

| Lesson                             | Simulator                                    | Real robot (live link)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any page                           | —                                            | Header **実機** button: LiDAR view, camera, commanded vs measured wheel RPM, pose, E-stop state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Vision                             | Generated scenes, opened image files, webcam | **実機カメラの画像を使う** feeds the newest robot camera frame into the same processing as an opened file (colour extraction, markers, face detection, …).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| SLAM                               | Generated sensor logs                        | **実機から15秒記録する** records LiDAR + wheel feedback into the same `robo-lab-sensors-v1` log the lesson imports from a file, through the same validation. **計測ログを開く** also takes a rosbag (`.mcap`) or a saved recording. QUESTiX has no IMU, so `gyroZ` is 0 and the page warns that the IMU and SLAM methods cannot turn on such a log. The LiDAR mount comes with each scan (TF via the bridge, `/tf_static` in a bag; default 0.2 m ahead as in `lidar_driver.launch.xml`).                                                                                                                                                                                                                                                                                                                                                                                                            |
| Feedback control (speed topics)    | Simulated PID runs                           | **実機で同じ実験をして重ねる** records `/drive_status` against `/target_twist` and draws the measured wheel speed on the same axes as the simulated run, time counted from the first command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Feedback control (distance topics) | Simulated PID stop at a wall                 | The same card records `/scan` while the learner drives towards a wall; the distance straight ahead (median of the beams within ±5°) is drawn on the distance chart from the moment the gap starts to shrink. The robot has no distance target, so no target line is drawn for it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Measurement lab (under control)    | Worked example, CSV                          | **実機で記録する** turns a recording into the table: each command held for at least 2 s becomes one input, with repeats taken after it has settled. Rows are never marked as check data — that stays the learner's decision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Measurement lab (under SLAM)       | Worked example, CSV                          | Semi-automatic: every drive between two stops in `/odom` gives the wheel-odometry distance (straight line start → stop); the learner types in the tape-measured floor distance for each, and **表に加える** puts the pairs in the table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Path planning (測った部屋で試す)   | Built-in rooms                               | Two sources, one map in the course's 6 m × 4 m frame. **部屋を測る** records `/scan` + `/odom` (or opens a recording / rosbag); each scan is placed with the odometry of the same moment and the LiDAR mount, cells hit at least twice become obstacles, and the driven path is drawn next to the planned one (odometry-only placement drifts on long drives). **3Dスキャンを開く** takes a phone scan (PLY / OBJ / GLB, uncompressed; Scaniverse etc.), finds the floor, and by default keeps everything between just above the floor (default 3 cm; lower things are rolled over) and the top of the robot — what blocks a wheeled robot; a table the robot fits under stays free. A second band cuts only around the 2D LiDAR's plane (± a thickness), the map the robot itself sees, to compare; its height is typed in (it is not in the TF). Start and goal can be placed by clicking the map. |
| All others                         | In-browser models                            | Existing offline workflow: download the ROS 2 script or procedure, import CSV/JSON.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Driving the real robot

Where a lesson can drive the robot, its record block gets a **実機を走らせる** part: the program in
one sentence, a checklist of what still prevents driving (each with what to do), the learner's
safety tick, the limits, a start button and, while running, a large **止める**. While any page
drives, every connected page shows a stop bar at the bottom (also inside open dialogs), and Esc
stops the robot. The 実機 dialog adds a hold-to-move bench test (前進 / 後退 / 左 / 右 while pressed).

| Lesson                            | What the page drives                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feedback control, speed topics    | A step input: 1 s still, 0.1 / 0.2 / 0.3 m/s for 5 s, stop; recorded and overlaid like a manual run.                                                                 |
| Feedback control, distance topics | The simulation's own P/I/D gains close the loop on the LiDAR's distance to the wall (target 0.50 m, output 100 % = 0.25 m/s, one step per scan); ends at 0.25 m.     |
| Measurement lab (under control)   | A forward/backward staircase (±0.1, ±0.2 m/s, 3 s each) that fills the table.                                                                                        |
| Measurement lab (under SLAM)      | 50 or 100 cm measured by `/odom`, easing into the goal; the learner measures the floor.                                                                              |
| Motor, 実物で確かめる             | Wheels lifted on a stand: 20→40→60→40→20 % of the bridge's forward limit, 2.5 s each, then stop; fills 「指示 → 測った回転数（左・右）」 (`js/motor/bench-core.js`). |

Every run is recorded and gets a **report** (`js/live/drive-report-core.js` → `drive-report-view.js`):
duration, distance by `/odom`, where it ended, turn, peak speed against the command, how long and
how far the robot took to stop after the stop command, the nearest wall; charts of commanded vs
measured speed (and turn rate), the LiDAR's distance ahead, and the path seen from above. The
lesson block shows the report of its last run; the 実機 dialog lists every run of this browser
(`js/live/drive-history.js`, bench presses included, newest 20) with the selected one's report.
Reports stay in `localStorage` across a reload; the full recording (JSON / CSV) can be saved only
until the page is closed.

Driving needs the robot started for practice (`ros2 launch questix_launcher questix_core.launch.xml`,
which includes `twist_arbiter`: the controller keeps working and moving its stick takes over from a
lesson), 教材からの走行 not switched off in Robot Manager's 教材 tab (on by default in practice
mode), the E-stop released, and the learner's safety tick on the page. The bridge checks all of them and every other
safety rule itself (`questix_lab_bridge/README.md`, "Driving experiments"); the page only shows them.
`js/live/drive-core.js` (readiness, programs, odometry goals) and `js/control/live-drive.js` (step,
wall PID) are DOM-free and tested (`test/drive-core.test.mjs`, `test/control-live-drive.test.mjs`);
`js/live/drive-link.js` is the only module that sends anything to the robot.

Where learners measure on the robot (motor 実物で確かめる, launch 実機の測定で確かめる, the measurement
lab's robot part, planning 測った部屋, control's live card) the **「実機の状態」 panel**
(`js/live/robot-state*.js`) shows the robot in large numbers: the link, the E-stop (a red block
while pressed), who drives (this page, another page, the controller), both wheels in rpm with the
last 10 s charted against the command, speed and turn rate, the path since the panel opened, the
distance ahead from the LiDAR and how fresh every stream is. It redraws itself at most 10 times a
second and only while it is on screen; 「いまの状態をメモに添える」 adds a line of that moment to
the place's 測定メモ (kept per browser, saved as text). It only listens.

Every recording goes through `js/live/capture.js`, so the connection checks, the timeout, the abort
and the learner-facing messages exist once; `capture-core.js` holds the arithmetic and is covered by
`test/live-capture-core.test.mjs`.

Recordings outlive the page. Every record block (control, measurement lab) can **save** the
recording as JSON (`questix-lab-recording`, reopened by any lesson that uses those streams) or as
CSV (one row per message, for a spreadsheet or a plotting tool), and **open** a saved recording or
a rosbag recorded by robot_manager's recording card (`ros2 bag record -s mcap`, uncompressed — the
default). A bag is read in the browser (`rosbag-core.js`: MCAP records, the embedded ros2msg
definitions, CDR) and converted into the same messages the bridge sends, so a lesson cannot tell the
two apart; it carries no wheel geometry, so the connected robot's is used, or the defaults of
`questix_lab_bridge/config/lab_bridge.yaml`. The last recording of each block and the measurement
table are also kept in the browser's storage, so a reload does not lose them (a convenience only:
large recordings are not kept, and saving the file is the reliable way). The page never sends anything to the robot. Browsers only allow `getUserMedia` (webcam) on
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
