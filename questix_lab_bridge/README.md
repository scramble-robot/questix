# questix_lab_bridge

WebSocket bridge between a real QUESTiX robot and the **QUESTiX LAB** web teaching material
(`scripts/robot_manager/static/lab/`, served by `robot_manager` at `/lab/`).

The lessons run their experiments in an in-browser simulator. This node lets the same pages
*observe* the real robot as well: LiDAR scans, odometry, wheel feedback, the commanded velocity,
and (optionally) camera images.

**Observation only by default.** Unless `allow_drive` is true the node creates subscriptions and
nothing else (no publishers, services, or actions of its own), and everything a browser sends over
the socket is discarded. With `allow_drive` (see [Driving experiments](#driving-experiments)) it
also publishes `/target_twist` for the lessons' low-speed driving experiments, and nothing else.

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
| `drive_topic` | `/target_twist` | `geometry_msgs/Twist` published for the pages, the same topic `drive_component` listens to. |
| `emergency_stop_topic` | `/emergency_stop` | `questix_msgs/EmergencyStop` (reliable, transient local). `/drive_status`'s `emergency_stop` counts too. |
| `drive_max_linear`, `drive_max_angular` | `0.3`, `1.0` | Upper bounds [m/s], [rad/s]; faster requests are clamped. |
| `drive_deadman_sec` | `0.5` | The driving page repeats its command every 0.1 s; silence this long stops the robot. |
| `drive_max_run_sec` | `30.0` | Longest single run, from its first command to its stop. |
| `drive_rate_hz` | `20.0` | Rate the held command is published at. |

## Driving experiments

Some lessons can drive the robot slowly and record what happens: a speed step in the
feedback-control course, the learner's own PID stopping the robot 0.5 m before a wall, a
forward/backward speed staircase and a measured-distance drive for the measurement lab, and a
hold-to-move bench test in the 実機 dialog. All of it goes through `/target_twist`, exactly like
the controller, so `drive_component`'s own limits, `cmd_timeout_sec` and emergency stop apply
unchanged.

To use it:

1. Start the robot **without its controller**, so the bridge is the only `/target_twist` source
   (two sources would take turns every tick):
   `ros2 launch questix_launcher questix_core.launch.xml enable_controller:=false`
2. In Questix Robot Manager's 教材 tab, press **走行を許可する** (restarts the bridge with
   `allow_drive:=true`; every connected page drops for a few seconds and reconnects).
   Competition mode turns it off again, and so does every restart of Robot Manager.
3. Learners tick the safety check on the page and press the lesson's drive button.

The bridge enforces every rule itself (`questix_lab_bridge/drive.py`, unit-tested), whatever a
page sends:

| Rule | Effect |
| --- | --- |
| `allow_drive` false | Every request refused (`not_allowed`); nothing is ever published. |
| Another node publishes `drive_topic` | Refused / running run stopped (`other_publisher`, with the node names). Checked every 0.5 s in the ROS graph. |
| No node subscribes to `drive_topic` | Refused (`no_drive_node`). |
| Emergency stop active | Refused / stopped (`emergency_stop`). |
| Another page drives | Refused (`busy`). Any page may **stop** any run (`{"type":"stop"}`, the stop bar); a page ending its own experiment sends `"scope":"mine"` and cannot end someone else's. |
| No command for `drive_deadman_sec` | Stopped (`timeout`): closed tab, sleeping laptop, lost Wi-Fi. |
| Owner disconnects | Stopped at once (`disconnected`). |
| Run longer than `drive_max_run_sec` | Stopped (`time_limit`). |
| Speed above the limits / non-finite | Clamped / stopped (`invalid`). |

After a stop the bridge publishes zero for 0.3 s so `drive_component` sees an explicit stop, then
nothing: an idle bridge never competes with a controller started later. If the bridge itself dies
mid-run, `drive_component`'s `cmd_timeout_sec` (1 s) stops the motors.

The page side (`static/lab/js/live/drive-link.js`) adds its own stops: the learner's 止める
button, Esc, the page being hidden or closed, and a fixed stop bar shown on every connected page
while any page drives.

## Protocol (version 1)

Units follow REP-103: metres, radians, seconds; x forward, y left, theta counter-clockwise.

Text frames are JSON objects tagged by `type`: `hello` (sent first: protocol version, geometry,
topic per stream, `read_only`, `robot`), `session` (this connection's id), `drive_state` (may a
page drive now, blockers, owner id, limits, why the last run ended; on every change and once a
second), `scan`, `odom`, `drive`, `twist`, and `status` (received rate per stream, once a second).
Unmeasured LiDAR beams are `null`, never `0` or a large number. Binary frames are one camera
image each, exactly as published. See `questix_lab_bridge/messages.py` for the fields.

`hello.robot` is `{"name": "<robot_name or host name>", "domain": <ROS_DOMAIN_ID as a number, or
null when unset>}`.

Browsers send (all ignored unless `allow_drive` is set):

| Frame | Meaning |
| --- | --- |
| `{"type": "drive", "linear": v, "angular": w}` | Drive at v [m/s], w [rad/s]. Also the heartbeat the owner repeats. |
| `{"type": "stop"}` | Stop the run, whichever page owns it (the stop bar on every page). |
| `{"type": "stop", "scope": "mine"}` | Stop the run only if this page owns it. A page ending its own experiment (止める, Esc, leaving the page) sends this, so a page whose request was refused never ends another pupil's run. An unknown `scope` counts as a plain stop. |

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
  "rates": {"scan": 5.0, "odom": 20.0, "drive": 20.0, "twist": 0.0}
}
```

`read_only` is what the running bridge enforces (not what robot_manager's `lab.env` says);
`drive_state` is the same body as the `drive_state` frame; `rates` is the last `status` report.

`drive.left.rpm` / `drive.right.rpm` are raw DDT wire values: the right motor is mirrored, so it
reads negative when driving forward. Pages that need forward-positive wheel speeds derive them
from `drive.v` / `drive.w` (`static/lab/js/live/slam-recorder.js`), which already carry the
robot's own sign convention. With `joy_axis_drive`, `v` and `w` are always 0 (see
`questix_msgs/msg/DriveStatus.msg`), so wheel-odometry recording needs `drive_component`.

## Security notes

The port is unauthenticated and, by default, reachable from the LAN. It exposes telemetry,
camera images, the `/api/state` snapshot, and the static teaching pages (GET only, confined to
`lab_dir`). With `allow_drive` it also accepts low-speed drive commands from **anyone who can
reach the port** — keep driving off unless a class is using it at the robot, on the robot's own
access point or a trusted classroom network, and switch it off afterwards (robot_manager shows it
in orange; restarting robot_manager turns it off). Set
`host` to `127.0.0.1` if only the robot's own browser should connect, and leave `camera_topic`
empty when images must not leave the robot.

## Tests

```bash
(cd questix_lab_bridge && python3 -m pytest test)   # no ROS needed; run inside the package dir
colcon test --packages-select questix_lab_bridge
```

Validated so far on an AMD64 development machine with published test topics only (driving: a
fake drive node obeying `/target_twist`, with the pages driven in headless Chrome). Raspberry Pi 5
validation with the real LiDAR, drive, and a camera is still pending and is authoritative —
in particular the driving experiments with the real motors, `joy_gate`-less startup and the
physical E-stop.
