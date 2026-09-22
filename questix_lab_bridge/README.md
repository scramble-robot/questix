# questix_lab_bridge

Read-only WebSocket bridge between a real QUESTiX robot and the **QUESTiX LAB** web teaching
material (`scripts/robot_manager/static/lab/`, served by `robot_manager` at `/lab/`).

The lessons run their experiments in an in-browser simulator. This node lets the same pages
*observe* the real robot as well: LiDAR scans, odometry, wheel feedback, the commanded velocity,
and (optionally) camera images.

**Observation only.** The node creates subscriptions and nothing else (no publishers, services,
or actions of its own), and everything a browser sends over the socket is discarded. A lesson
can never move the robot; driving stays with the controller and the `joy_gate` / E-stop path.

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
| `max_clients` | `8` | Further browsers are refused (close code 1013). |
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

## Protocol (version 1)

Units follow REP-103: metres, radians, seconds; x forward, y left, theta counter-clockwise.

Text frames are JSON objects tagged by `type`: `hello` (sent first: protocol version, geometry,
topic per stream), `scan`, `odom`, `drive`, `twist`, and `status` (received rate per stream,
once a second). Unmeasured LiDAR beams are `null`, never `0` or a large number. Binary frames
are one camera image each, exactly as published. See `questix_lab_bridge/messages.py` for the
fields.

`drive.left.rpm` / `drive.right.rpm` are raw DDT wire values: the right motor is mirrored, so it
reads negative when driving forward. Pages that need forward-positive wheel speeds derive them
from `drive.v` / `drive.w` (`static/lab/js/live/slam-recorder.js`), which already carry the
robot's own sign convention. With `joy_axis_drive`, `v` and `w` are always 0 (see
`questix_msgs/msg/DriveStatus.msg`), so wheel-odometry recording needs `drive_component`.

## Security notes

The port is unauthenticated and, by default, reachable from the LAN. It exposes telemetry,
camera images, and the static teaching pages (GET only, confined to `lab_dir`), but accepts no
commands. Set `host` to `127.0.0.1` if only the robot's own browser
should connect, and leave `camera_topic` empty when images must not leave the robot.

## Tests

```bash
(cd questix_lab_bridge && python3 -m pytest test)   # no ROS needed; run inside the package dir
colcon test --packages-select questix_lab_bridge
```

Validated so far on an AMD64 development machine with published test topics only. Raspberry Pi 5
validation with the real LiDAR, drive, and a camera is still pending and is authoritative.
