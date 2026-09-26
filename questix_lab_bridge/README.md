# questix_lab_bridge

WebSocket bridge between a real QUESTiX robot and the **QUESTiX LAB** web teaching material
(`scripts/robot_manager/static/lab/`, served by `robot_manager` at `/lab/`).

The lessons run their experiments in an in-browser simulator. This node lets the same pages
*observe* the real robot as well: LiDAR scans, odometry, wheel feedback, the commanded velocity,
the disc launcher's roller and tilt/fire status, and (optionally) camera images.

**Observation only by default.** Unless `allow_drive` or `allow_shoot` is true the node creates
subscriptions and nothing else (no publishers, services, or actions of its own), and everything a
browser sends over the socket is discarded except a recording to keep on the robot
([Records kept on the robot](#records-kept-on-the-robot); files only, nothing reaches ROS). With
`allow_drive` (see [Driving experiments](#driving-experiments)) it also publishes
`/target_twist/lab` for the lessons' low-speed driving experiments; with `allow_shoot` (see
[Launcher experiments](#launcher-experiments)) `/roller/lab`, `/shot/lab/tilt` and
`/shot/lab/fire`; and nothing else.

## Run

From Questix Robot Manager: open the **教材** tab and press **配信開始** (it runs this node with
the right ROS environment, domain and `lab_dir`, and shows the URL for learners). By hand:

```bash
ros2 launch questix_lab_bridge lab_bridge.launch.xml
```

Then open **`http://<robot-ip>:8897/`** in a browser. The bridge serves the QUESTiX LAB pages
over plain HTTP on the same port as the WebSocket, and a page opened this way connects to the
robot automatically. (Port 8897 used to be WebSocket-only; opening it in a browser then failed
with `InvalidUpgrade: invalid Connection header: keep-alive` in the node log.)

If the material is opened from somewhere else (robot_manager's `/lab/`, or any static file
server), press **実機** in the header and connect to `ws://<robot-ip>:8897`.

The bridge is deliberately not part of `questix_core.launch.xml` or the `questix_robot` service:
it is a classroom tool that is switched on from the manager when a lesson needs it.

## Parameters (`config/lab_bridge.yaml`)

| Parameter | Default | Meaning |
| --- | --- | --- |
| `host` / `port` | `0.0.0.0` / `8897` | Listen address. The port must match `LAB_BRIDGE_PORT` in `scripts/robot_manager/app.py` (its CSP only allows this port) and `DEFAULT_PORT` in `static/lab/js/live/robot-link.js`. |
| `max_clients` | `24` | Further browsers are refused (close code 1013). Sized for a class: every pupil's phone or tablet plus the teachers' laptops. |
| `robot_name` | `""` | Name reported in `hello.robot.name` and `/api/state`, so a class with several robots can tell them apart. Empty = the host name. |
| `lab_dir` | `""` | Directory of the QUESTiX LAB site (`index.html`) to serve over HTTP. Empty = look for `scripts/robot_manager/static/lab` above the installed module (repository root or a colcon workspace with the repository under `src/`), then `$ROBOT_WS/src/*`, then `/opt/questix_robot/robot_manager/static/lab`. The node logs which directory it serves, or a warning if none was found (HTTP requests then get a plain-text explanation). |
| `scan_topic` | `/scan` | `sensor_msgs/LaserScan`. Empty string disables a stream. |
| `odom_topic` | `/odom` | `nav_msgs/Odometry` (published by `drive_component`). |
| `drive_status_topic` | `/drive_status` | `questix_msgs/DriveStatus`. |
| `target_twist_topic` | `/target_twist` | `geometry_msgs/Twist`. |
| `camera_topic` | `""` (off) | `sensor_msgs/CompressedImage`, JPEG or PNG only. No camera driver ships with this repository. |
| `scan_max_hz`, `odom_max_hz`, `drive_max_hz`, `twist_max_hz`, `camera_max_fps` | 5 / 20 / 20 / 20 / 10 | Upper bound of what is forwarded; the newest message wins. |
| `scan_max_points` | `360` | Scans are decimated by an integer stride to at most this many beams. |
| `base_frame` | `base_link` | Each scan carries `mount` (`x`, `y`, `yaw` of the scan frame in this frame), looked up once per frame in TF — on QUESTiX the static transform of `launcher/launch/lidar_driver.launch.xml`. `null` (and a throttled warning) while TF does not know it; the lab then uses its default mount. |
| `wheel_radius`, `wheel_separation` | `0.1`, `0.5` | Only reported to the page for wheel-odometry lessons. Keep identical to `launcher/config/drive_component.yaml`. |
| `allow_drive` | `false` | Let pages drive the robot (next section). robot_manager passes `true` while 教材からの走行 is allowed. |
| `drive_topic` | `/target_twist/lab` | `geometry_msgs/Twist` published for the pages: `twist_arbiter`'s lab input. |
| `emergency_stop_topic` | `/emergency_stop` | `questix_msgs/EmergencyStop` (reliable, transient local). `/drive_status`'s `emergency_stop` counts too. |
| `drive_max_linear`, `drive_max_angular` | `0.3`, `1.0` | Upper bounds [m/s], [rad/s]; faster requests are clamped. |
| `drive_deadman_sec` | `0.5` | The driving page repeats its command every 0.1 s; silence this long stops the robot. |
| `drive_max_run_sec` | `30.0` | Longest single run, from its first command to its stop. |
| `drive_rate_hz` | `20.0` | Rate the held command is published at. |
| `roller_status_topic`, `shot_status_topic` | `/roller/status`, `/shot/status` | `std_msgs/String` JSON status of `esc_motor_control` and `shot_component`, mirrored to every page (streams `roller`, `shot`). Empty = not mirrored, and no launcher experiments. |
| `allow_shoot` | `false` | Let pages operate the disc launcher ([Launcher experiments](#launcher-experiments)). robot_manager passes its 教材からの発射 switch. |
| `roller_lab_topic`, `tilt_lab_topic`, `fire_lab_topic` | `/roller/lab`, `/shot/lab/tilt`, `/shot/lab/fire` | `std_msgs/Float32` roller power 0..1, `std_msgs/Float32` tilt [deg], `std_msgs/Empty` fire one disc; the launcher nodes' lab inputs. |
| `shoot_max_power` | `0.8` | Cap on the roller power a page may command; narrowed further by `esc_motor_control`'s `lab_max_speed` from `/roller/status`, never widened. |
| `shoot_tilt_min`, `shoot_tilt_max` | `0.0`, `120.0` | Cap on the tilt range [deg]; narrowed further by `shot_component`'s `tilt_min_deg` / `tilt_max_deg` from `/shot/status` (its `tilt_min_angle` / `tilt_max_angle`, 0 / 120 in `shot_config*.yaml`). |
| `shoot_fire_interval_sec` | `2.0` | Shortest time between two shots of any source. |
| `shoot_deadman_sec` | `0.5` | The page repeats `roller` every 0.1 s; silence this long stops the roller. |
| `shoot_max_spin_sec` | `30.0` | Longest session, from its first command to its stop. |
| `shoot_rate_hz` | `20.0` | Rate the roller command is published at during a session. |
| `records_dir` | `~/.local/share/questix/lab-records` | Where records are kept ([Records kept on the robot](#records-kept-on-the-robot)); created with the bridge user's permissions. `""` = keep nothing (pages cannot save, the list is empty). |
| `records_quota_mb`, `records_min_free_mb` | `500`, `200` | Space the records may take, and free space always left on the disk [MiB]. |
| `auto_record` | `true` | Record driving that no page records (the controller) by itself. |
| `rosbag_dir` | `/var/lib/questix/rosbags` | Robot Manager's rosbags, listed and converted for the lessons. robot_manager passes its `OUTPUT_DIR`. |
| `rosbag_max_seconds`, `rosbag_convert_timeout_sec` | `300.0`, `60.0` | Longest window converted from one bag, and how long one conversion may take [s]. |

## Driving experiments

Some lessons can drive the robot slowly and record what happens: a speed step in the
feedback-control course, the learner's own PID stopping the robot 0.5 m before a wall, a
forward/backward speed staircase and a measured-distance drive for the measurement lab, and a
hold-to-move bench test in the 実機 dialog. The bridge publishes to `/target_twist/lab`;
`twist_arbiter` (started by practice launches of `questix_core.launch.xml`) passes either that or
the controller's command on to `/target_twist`, so `drive_component`'s own limits,
`cmd_timeout_sec` and emergency stop apply unchanged, and the controller keeps working:

- a lab run takes over only while the stick is neutral;
- moving the stick during a lab run hands the robot back to the controller at once; the bridge
  reads `/twist_arbiter/status` and ends the run (`controller`);
- nothing has to be relaunched between driving by hand and a lesson.

To use it:

1. Start the robot as usual for practice: `ros2 launch questix_launcher questix_core.launch.xml`
   (competition launches, `enable_autoreferee:=true`, do not start `twist_arbiter`).
2. Robot Manager runs the bridge with `allow_drive:=true` in practice mode (its 教材 tab switch
   「教材からの走行を止める」 turns it off; competition mode turns it off, practice mode on).
3. Learners tick the safety check on the page and press the lesson's drive button.

The bridge enforces every rule itself (`questix_lab_bridge/drive.py`, unit-tested), whatever a
page sends:

| Rule | Effect |
| --- | --- |
| `allow_drive` false | Every request refused (`not_allowed`); nothing is ever published. |
| Another node publishes `drive_topic` | Refused / running run stopped (`other_publisher`, with the node names). Checked every 0.5 s in the ROS graph. |
| No node subscribes to `drive_topic` | Refused (`no_drive_node`): no `twist_arbiter` (not a practice launch, or another `ROS_DOMAIN_ID`). |
| `twist_arbiter` gives the robot to the controller | Stopped (`controller`): the stick moved, or it was held when the run started. |
| Emergency stop active | Refused / stopped (`emergency_stop`). |
| Another page drives | Refused (`busy`). Any page may **stop** any run (`{"type":"stop"}`, the stop bar); a page ending its own experiment sends `"scope":"mine"` and cannot end someone else's. |
| No command for `drive_deadman_sec` | Stopped (`timeout`): closed tab, sleeping laptop, lost Wi-Fi. |
| Owner disconnects | Stopped at once (`disconnected`). |
| Run longer than `drive_max_run_sec` | Stopped (`time_limit`). |
| Speed above the limits / non-finite | Clamped / stopped (`invalid`). |

After a stop the bridge publishes zero for 0.3 s so `drive_component` sees an explicit stop, then
nothing, so `twist_arbiter` soon hands the robot back to the controller. If the bridge itself dies
mid-run, `drive_component`'s `cmd_timeout_sec` (1 s) stops the motors.

The page side (`static/lab/js/live/drive-link.js`) adds its own stops: the learner's 止める
button, Esc, the page being hidden or closed, and a fixed stop bar shown on every connected page
while any page drives.

## Launcher experiments

Lessons can also spin the disc launcher's roller, tilt it and fire one disc. The bridge publishes
the launcher nodes' lab inputs, and the nodes decide themselves whether to apply them
(`accept_lab_input`, set only by practice launches; E-stop; the controller's quiet time; their own
clamps and fire interval) and report it in their status:

| Topic | Type | From → to |
| --- | --- | --- |
| `/roller/lab` | `std_msgs/Float32` (0..1) | bridge → `esc_motor_control` |
| `/shot/lab/tilt` | `std_msgs/Float32` [deg] | bridge → `shot_component` |
| `/shot/lab/fire` | `std_msgs/Empty` | bridge → `shot_component` |
| `/roller/status` | `std_msgs/String` JSON `{command, source: joy/lab/idle, lab_accepted, lab_locked, estop, lab_max_speed}` | `esc_motor_control` → bridge, 5 Hz |
| `/shot/status` | `std_msgs/String` JSON `{tilt_deg, shooting, fired_count, last_fire_source: joy/lab/null, lab_accepted, estop, active, tilt_min_deg, tilt_max_deg, next_fire_in_sec, lab_refused}` | `shot_component` → bridge, 5 Hz and on change |

Both statuses are mirrored to every page (streams `roller`, `shot`) whether or not `allow_shoot` is
set. The controller always wins: pressing its roller button, or firing, takes the launcher over at
once and ends the page's session.

The bridge enforces its own rules on top (`questix_lab_bridge/shoot.py`, unit-tested), whatever a
page sends:

| Rule | Effect |
| --- | --- |
| `allow_shoot` false | Every request ignored (`hello.shoot.allowed` and `shoot_state.allowed` false); nothing is ever published. |
| Nobody subscribes to `/roller/lab` or `/shot/lab/fire`, a status is silent for 1 s, says `lab_accepted: false`, or `shot_component` is not `active` | Refused / session ended (`no_launcher`, with `parts`: `roller`, `shot`). Competition launches never accept lab input. |
| Another node publishes one of the three lab topics | Refused / ended (`other_publisher`, with the node names). Checked every 0.5 s. |
| Emergency stop (`/emergency_stop`, `/drive_status`, or `estop` in either status) | Refused / ended (`emergency_stop`, `parts` naming the source). |
| Controller in use: `/roller/status` `source: "joy"` now or within the last 1 s, `lab_locked` outside an E-stop, `/shot/status` `lab_locked` (if the node reports it), or a controller shot within the last 1 s | Refused / ended (`controller`). |
| Another page owns the launcher | Refused (`busy`). Any page may stop the roller (`roller_stop`). |
| No `roller` frame for `shoot_deadman_sec` | Session ended (`timeout`), roller 0. |
| Owner disconnects / session longer than `shoot_max_spin_sec` | Ended (`disconnected` / `time_limit`), roller 0. |
| Roller power above `shoot_max_power`, tilt outside `shoot_tilt_min..max`, non-finite values | Clamped / refused (`invalid`, which also ends the owner's session). |
| `fire` without `"confirm": true` | Refused (`no_confirm`). The page sends it only while the pupil's safety tick 「発射する方向に人がいない・的の周りに人がいない」 is set. |
| `fire` before the roller was commanded at ≥ 0.2 for 1.0 s without a break, or by a page that owns no session | Refused (`not_spinning`). |
| `fire` while a shot is moving (`shooting`) / sooner than `shoot_fire_interval_sec` after the last shot of any source, or before `/shot/status` `next_fire_in_sec` has run out | Refused (`shooting` / `interval`). Never queued. |

A session starts with the owner's first accepted `roller` or `tilt` and lives only while the owner
keeps sending `roller` (`"power": 0` while it only tilts); a tilt alone lapses after
`shoot_deadman_sec`. While it lasts the bridge publishes the roller power at `shoot_rate_hz`; when
it ends, and whenever a blocker appears (session or not), 0 for 0.3 s, then nothing. After a
controller press or an E-stop `esc_motor_control` keeps the lab locked (`lab_locked`) until it
hears a lab 0: once the controller and the E-stop have let go, the bridge sends that 0 itself (at
most every 2 s while the lock stays), so the `controller` blocker clears without the page doing
anything. Tilts are published on request, at most every 60 ms (latest wins; `shot_component`
refuses closer than 50 ms). If the bridge dies mid-session, `esc_motor_control` drops the stale
lab command (1 s) and stops the roller.

## Records kept on the robot

Recordings live on the robot, not in one browser: every device connected to the robot can list,
open and download them, a pupil who changes or reloads a device loses nothing, and the teacher
can collect them from one folder (`records_dir`, one `<id>.json` per record in the
`questix-lab-recording` format of `static/lab/js/live/recording-core.js`; `.meta/` holds the
listing index). Three kinds (`source`):

| `source` | Made by |
| --- | --- |
| `lab` | A page saving a run or a 「記録だけする」 capture (`record_save` over the WebSocket). The bridge checks format, version and wheel geometry, makes the id itself (`<yyyymmdd-hhmmss>-lab-<lesson>-<group>-<robot>`, ASCII only) and writes the file. |
| `auto` | The bridge, for driving no page records: when the command on `/target_twist` or the measured speed (`/drive_status`, `/odom`) says the robot moves and no lab driving run is active, it keeps every stream from 1 s before until the robot has stood still for 3 s (split every 180 s; less than 1 s of motion is dropped) and saves it as lesson `free-drive`, 「コントローラーで走行」 (「走行（指令元不明）」 when the robot moved without a command). |
| `rosbag-cache` | A converted window of one of Robot Manager's rosbags, kept so opening it again is instant. |

Storage is bounded by `records_quota_mb` and by `records_min_free_mb` of free disk. When full,
`auto` records and caches delete their own oldest; `lab` records are never deleted
automatically — saving from a page is refused (「ロボットの保存領域がいっぱいです。…」) until the
teacher tidies the folder up. Robot Manager's 教材 tab shows the count, size, limit and folder.

Plain HTTP GET on the bridge port (every answer: `Access-Control-Allow-Origin: *`,
`Cache-Control: no-store`, JSON, gzip when the browser accepts it; errors are
`{"error": "<Japanese>"}` with a 4xx/5xx status):

| Request | Answer |
| --- | --- |
| `GET /api/records` | `{records: [{id, source, lesson, label, group, robot, recordedAt, seconds, outcome, bytes}], quota: {used_bytes, limit_bytes}, save}`, newest first. `label` is the run's `conditions.label` or a fallback (「コントローラーで走行」, 「Robot Managerの録画」, 「設定：不明」). |
| `GET /api/records/<id>` | The recording, as an attachment `<id>.json`. |
| `GET /api/rosbags` | `{bags: [{name, startedAt, seconds, bytes, topics, usable, reason}], dir}` from each bag's `metadata.yaml`, newest first. `usable` = has `/drive_status`, `/odom` or `/scan`; a bag still being recorded is listed with a `reason`. A missing folder is an empty list. |
| `GET /api/rosbags/<name>/recording?start=<s>&seconds=<s>` | That window (default: from the start, `rosbag_max_seconds` long, never longer) converted with rosbag2_py into a recording of the same payloads the bridge sends live (`source: 'rosbag'`, `lesson: null`, `conditions.label` 「Robot Managerの録画」, the bridge's rates and scan decimation, the LiDAR mount from `/tf_static`). One conversion at a time (503 otherwise), on a worker thread, given up after `rosbag_convert_timeout_sec` (504). |

Nothing here adds a ROS publisher, service or action: the records are files, the auto recorder
reads the payloads the node already builds, and rosbags are read from disk.

## Protocol (version 1)

Units follow REP-103: metres, radians, seconds; x forward, y left, theta counter-clockwise.

Text frames are JSON objects tagged by `type`: `hello` (sent first: protocol version, geometry,
topic per stream, `read_only`, `robot`), `session` (this connection's id), `drive_state` (may a
page drive now, blockers, owner id, limits, why the last run ended; on every change and once a
second), `shoot_state` (the same for the launcher), `scan`, `odom`, `drive`, `twist`, `roller`,
`shot`, and `status` (received rate per stream, once a second).
Unmeasured LiDAR beams are `null`, never `0` or a large number. Binary frames are one camera
image each, exactly as published. See `questix_lab_bridge/messages.py` for the fields.

`hello.robot` is `{"name": "<robot_name or host name>", "domain": <ROS_DOMAIN_ID as a number, or
null when unset>}`. `hello.records` is `{"save": <pages may save here now>, "list": true,
"rosbags": <GET /api/rosbags can convert>}`. `hello.shoot` is `{"allowed": <allow_shoot>,
"max_power": 0.8, "tilt_min": 0.0, "tilt_max": 120.0, "fire_interval_sec": 2.0,
"min_fire_power": 0.2, "spin_up_sec": 1.0, "deadman_sec": 0.5, "max_spin_sec": 30.0}` — the
bridge's own caps; the effective limits, narrowed by the nodes' status, are in
`shoot_state.limits` (sent right after `hello`). An older bridge sends no `shoot`: treat it as
`{"allowed": false}`. `read_only` concerns driving only (kept for existing pages and robot_manager).

`roller` and `shot` are the status JSON exactly as the node sent it, plus `"type"` and `"stamp"`
(receipt time [s]):
`{"type": "roller", "stamp": 12.3, "command": 0.5, "source": "lab", "lab_accepted": true,
"lab_locked": false, "estop": false}`,
`{"type": "shot", "stamp": 12.3, "tilt_deg": 30.0, "shooting": false, "fired_count": 2,
"last_fire_source": "lab", "lab_accepted": true, "estop": false, "active": true,
"tilt_min_deg": 0.0, "tilt_max_deg": 120.0, "next_fire_in_sec": 0.0, "lab_refused": null}`
(`lab_refused`: why shot_component refused the last lab request, e.g. `interval`).

`shoot_state` (on every change and once a second; its time fields are exact when sent, count them
down locally in between):

```json
{"type": "shoot_state", "allowed": true,
 "blockers": [{"code": "controller", "nodes": null, "parts": ["roller"]}],
 "owner": 3, "active": true,
 "roller": {"power": 0.5, "since_sec": 1.4},
 "tilt_deg": 30.0, "ready_to_fire": true, "next_fire_in_sec": 0.0, "spin_ready_in_sec": 0.0,
 "session_sec": 4.2, "fired": 1,
 "limits": {"max_power": 0.8, "min_fire_power": 0.2, "spin_up_sec": 1.0,
            "fire_interval_sec": 2.0, "tilt_min": 0.0, "tilt_max": 120.0, "deadman": 0.5,
            "seconds": 30.0},
 "last_stop": null}
```

`blockers[].code` is one of `not_allowed`, `no_launcher`, `other_publisher`, `emergency_stop`,
`controller` (display order); `nodes` lists other publishers, `parts` which of `roller` / `shot`
(or `topic` for the E-stop topic) is concerned. `roller.since_sec` is how long the roller has been
commanded at `min_fire_power` or more (0 otherwise); `spin_ready_in_sec` is `null` while it is
not. `limits.max_power` / `tilt_min` / `tilt_max` are the effective limits (the bridge's caps
narrowed by the nodes' status); they change when the nodes report other values. `tilt_deg` is the last tilt a page sent (`null` before any; the measured angle is in `shot`).
`fired` counts the pages' shots since the bridge started. `last_stop.reason` is `stopped`,
`timeout`, `time_limit`, `disconnected`, `invalid` or a blocker code; `by` the page that stopped
it, or `null`.

Any page may send `{"type": "record_save", "recording": {...}}` (one frame, up to 8 MiB; the only
frame larger than 1 kB the bridge accepts) and gets, to itself only, `{"type": "record_saved",
"id": "<id>"}` or `{"type": "record_error", "message": "<Japanese>"}`.

Browsers send (all ignored unless `allow_drive` is set):

| Frame | Meaning |
| --- | --- |
| `{"type": "drive", "linear": v, "angular": w}` | Drive at v [m/s], w [rad/s]. Also the heartbeat the owner repeats. |
| `{"type": "stop"}` | Stop the run, whichever page owns it (the stop bar on every page). |
| `{"type": "stop", "scope": "mine"}` | Stop the run only if this page owns it. A page ending its own experiment (止める, Esc, leaving the page) sends this, so a page whose request was refused never ends another pupil's run. An unknown `scope` counts as a plain stop. |

Browsers send (all ignored unless `allow_shoot` is set; on the page only
`static/lab/js/live/shoot-link.js` sends them):

| Frame | Meaning |
| --- | --- |
| `{"type": "roller", "power": p}` | Roller at p (0..1, clamped to `max_power`). The owner's heartbeat: repeat it at least every 0.1 s during a session, `"power": 0` included. The first accepted one starts a session. |
| `{"type": "roller_stop"}` | Stop the roller and end the session, whichever page owns it. |
| `{"type": "tilt", "deg": d}` | Tilt to d degrees (clamped to `tilt_min..tilt_max`). Owner only; may start a session. |
| `{"type": "fire", "confirm": true}` | Fire one disc. Only a JSON `true` confirms. |

A refused `roller` / `tilt` / `fire` is answered to the sender only:
`{"type": "shoot_refused", "reason": "<key>", "request": "roller"|"tilt"|"fire",
"next_fire_in_sec": 1.2, "spin_ready_in_sec": 0.3}`. `reason` is a blocker code, `busy`,
`invalid`, `no_confirm`, `not_spinning`, `shooting` or `interval`. An accepted fire has no reply of
its own: `shoot_state.fired` goes up and `next_fire_in_sec` restarts.

### `GET /api/state`

Plain HTTP on the same port returns a JSON snapshot of the bridge, for Robot Manager's 教材 tab
and for checking a classroom robot with `curl http://<robot-ip>:8897/api/state`:

```json
{
  "protocol": 1,
  "read_only": false,
  "robot": {"name": "questix-3", "domain": 7},
  "clients": 12,
  "max_clients": 24,
  "drive_state": {"allowed": true, "blockers": [{"code": "other_publisher", "nodes": ["/joy_controller"]}],
                  "owner": null, "active": false, "linear": 0.0, "angular": 0.0,
                  "limits": {"linear": 0.3, "angular": 1.0, "deadman": 0.5, "seconds": 30.0},
                  "last_stop": null},
  "rates": {"scan": 5.0, "odom": 20.0, "drive": 20.0, "twist": 0.0},
  "records": {"dir": "/home/ubuntu/.local/share/questix/lab-records", "count": 12,
              "used_bytes": 23456789, "limit_bytes": 524288000, "save": true,
              "auto_record": true, "rosbag_dir": "/var/lib/questix/rosbags"},
  "shoot_state": {"allowed": true, "blockers": [{"code": "no_launcher", "nodes": null, "parts": ["shot"]}],
                  "owner": null, "active": false, "...": "as the shoot_state frame"}
}
```

`read_only` (driving) and `shoot_state.allowed` (launcher) are what the running bridge enforces
(not what robot_manager's `lab.env` says); `drive_state` / `shoot_state` are the same bodies as
the frames (`shoot_state` is `{"allowed": false}` only when absent); `rates` is the last `status`
report.

`drive.left.rpm` / `drive.right.rpm` are raw DDT wire values: the right motor is mirrored, so it
reads negative when driving forward. Pages that need forward-positive wheel speeds derive them
from `drive.v` / `drive.w` (`static/lab/js/live/slam-recorder.js`), which already carry the
robot's own sign convention. With `joy_axis_drive`, `v` and `w` are always 0 (see
`questix_msgs/msg/DriveStatus.msg`), so wheel-odometry recording needs `drive_component`.

## Security notes

The port is unauthenticated and, by default, reachable from the LAN. It exposes telemetry,
camera images, the `/api/state` snapshot, the static teaching pages (GET only, confined to
`lab_dir`), and the records and rosbags described above (read-only over HTTP; anyone who can
reach the port can also add a `lab` record, bounded by the quota). With `allow_drive` it also
accepts low-speed drive commands, and with `allow_shoot` launcher commands (roller, tilt, firing a
disc), from **anyone who can reach the port** — keep them off unless a class is using them at the
robot, on the robot's own access point or a trusted classroom network, and switch them off
afterwards (robot_manager shows them in orange). The pupil's safety tick and `confirm` are
checks of the page, not authentication. Set
`host` to `127.0.0.1` if only the robot's own browser should connect, and leave `camera_topic`
empty when images must not leave the robot.

## Tests

```bash
(cd questix_lab_bridge && python3 -m pytest test)   # no ROS needed; run inside the package dir
# test_rosbags.py writes and converts a real MCAP bag; it is skipped unless ROS 2 (rosbag2_py)
# and a built questix_msgs are sourced.
colcon test --packages-select questix_lab_bridge
```

Validated so far on an AMD64 development machine with published test topics only (driving: a
fake drive node obeying `/target_twist`, with the pages driven in headless Chrome). Raspberry Pi 5
validation with the real LiDAR, drive, and a camera is still pending and is authoritative —
in particular the driving experiments with the real motors, `joy_gate`-less startup and the
physical E-stop. The launcher experiments were checked end to end against a fake launcher node
(statuses per the contract above) only; the real roller ESC, servos, controller takeover and
E-stop on a Raspberry Pi 5 are still to be validated.
