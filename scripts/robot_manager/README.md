# robot_manager

FastAPI-based web control panel for the `questix_robot` systemd service, served by
uvicorn on `127.0.0.1:8888`.

- `app.py` — service control (mode, start/stop/restart, launch config).
- `recorder.py` — rosbag recording console (`/api/rosbag/*`).
- `logs.py` — log collection console (`/api/logs/*`).
- `lab.py` — QUESTiX LAB console (`/api/lab/*`): starts/stops the read-only lab bridge.
- `static/` — vanilla HTML/CSS/JS frontend (no build step).
- `static/lab/` — QUESTiX LAB web teaching material, served at `/lab/` (see its README).

## Competition GPIO safety

The `ENABLE_GPIO_REF` field in `launch.env` is retained for manual development and
diagnostics. When `/etc/questix_robot/mode` is `competition`, the production launcher
ignores that field and always passes `enable_gpio_ref:=true` together with
`enable_autoreferee:=true`. Therefore an existing `launch.env` containing
`ENABLE_GPIO_REF=false` cannot disable the GPIO5 physical E-stop and GPIO27
AutoReferee safety path. `enable_autoreferee:=true` with `enable_gpio_ref:=false` is
not a valid operational configuration.

## QUESTiX LAB (`/lab/`)

The teaching material is a static site mounted at `/lab/` and linked from the header. Its
lessons use inline style attributes, canvas `data:`/`blob:` images, and a WebSocket to the
read-only `questix_lab_bridge` node, so `/lab` responses get a relaxed
Content-Security-Policy (`style-src 'unsafe-inline'`, `img-src data: blob:`,
`connect-src ws://*:$LAB_BRIDGE_PORT`, default 8897). Scripts stay `'self'`-only, and every other
route keeps `default-src 'self'`.

robot_manager listens on `127.0.0.1` only, because its API controls the robot service without
authentication. `/lab/` is therefore reachable from the robot's own browser only. Learners'
devices open the material from the read-only `questix_lab_bridge` node instead; do not expose
robot_manager itself to the network for this.

### 教材 tab (`lab.py`)

The **教材** tab starts and stops that bridge, so nobody has to run `ros2 launch` by hand:

- **配信開始** runs `ros2 run questix_lab_bridge lab_bridge_node` in its own process group with
  the ROS environment of `ROBOT_WS` and the `ROS_DOMAIN_ID` from `launch.env` (the same domain
  the robot service uses), the package's `lab_bridge.yaml`, `port:=$LAB_BRIDGE_PORT`, and
  `lab_dir:=` this manager's `static/lab/` — learners get exactly the pages served at `/lab/`.
- The tab shows the URL(s) to open on learners' devices (`http://<robot-ip>:8897/`; container
  and VPN interfaces are left out). A page opened there connects to the robot automatically.
- **配信停止** interrupts the process group (SIGINT, then SIGTERM/SIGKILL). The bridge is also
  stopped when robot_manager exits. A bridge that was started by hand is shown as
  "配信中 (手動で起動)" and is not stopped from here.
- `カメラのトピック` (`sensor_msgs/CompressedImage`, empty = no camera) is stored in
  `$QUESTIX_CONFIG_DIR/lab.env` and applies from the next start.
- **起動時に配信を自動で開始する** (`AUTOSTART="true"` in `lab.env`, **on by default**) starts the
  bridge whenever robot_manager starts — with the robot_manager service, that is at boot — so a
  class can open the pages without anyone pressing 配信開始. It runs in the background of the
  manager's start-up; if it fails (ROS workspace not built, a bridge already running by hand) the
  tab says "自動開始に失敗しました". Nothing in systemd or Ansible changes: the bridge stays a
  child of robot_manager and stops with it. While it is on, every device on the network may
  see the pages and the read-only telemetry.
- **大会モード** (`competition` in `$QUESTIX_CONFIG_DIR/mode`): switching to it from this UI stops
  a bridge started here and writes `AUTOSTART="false"`; switching back to 練習モード leaves it
  off (tick the checkbox again, or run `sudo scripts/wifi-ap.sh up`). Automatic start is also
  skipped while the mode file says `competition`, even if it was changed by hand.
- `sudo scripts/wifi-ap.sh up` (Wi-Fi access point) turns `AUTOSTART` on and asks a running
  robot_manager to start the bridge, so `http://10.42.0.1:8897/` works right away — except in
  大会モード, where it leaves the bridge alone.

- **スマートフォンで開く** shows two QR codes: ① joins the robot's Wi-Fi access point (from
  `$QUESTIX_CONFIG_DIR/wifi_ap.env`, written by `scripts/wifi-ap.sh`; read-only `GET /api/wifi-ap`,
  `wifi_ap.py`) and ② opens the teaching pages (`http://10.42.0.1:8897/` while the access point
  is on, otherwise the first LAN URL). **印刷用の接続カード** (`static/ap-card.html`) is the same
  pair on a printable page; `sudo scripts/wifi-ap.sh card` writes it as a standalone file. QR
  codes are drawn as SVG from `static/vendor/qrcode.js` (qrcode-generator, MIT, see
  `static/vendor/NOTICE.md`) by `static/qr-svg.js`, which fits the strict CSP of the manager UI.

Prerequisite: `questix_lab_bridge` is built in `ROBOT_WS` (`colcon build`; rosdep key
`python3-websockets`). If the node exits immediately, starting fails with an error toast.
The bridge only subscribes; it never publishes or accepts commands.

## Running (dev)

```bash
python -m robot_manager        # uvicorn on http://127.0.0.1:8888
```

## rosbag recording console

The recording card lets you record ROS 2 bags and manage them locally. Bags are
recorded in **MCAP** format so the separate `rosbag_manager` catalog app can ingest
them, and are named `<vehicle>_<timestamp>` so the recording machine is identifiable
from the bag name alone (which `rosbag_manager` uses as the display name).

Getting a bag into `rosbag_manager` is a **manual** step: `rosbag_manager` has no
upload API — it scans local folders. Copy the recorded bag directory (via USB, a
shared disk, etc.) into a folder that `rosbag_manager` scans as a root folder. The
bag list shows each bag's full path to make that copy easy. Only MCAP-storage bags
are accepted by `rosbag_manager` (db3/sqlite is rejected), which is why recording is
fixed to `-s mcap`.

Disk protection: recording refuses to start when free space is below `最小空き(GB)`
(`MIN_FREE_GB`, HTTP 507) and auto-stops (via SIGINT, so the bag is finalized) if
free space drops below that threshold mid-recording. Optional `分割(MB)`
(`MAX_SPLIT_MB`) and `録画上限(秒)` (`MAX_DURATION_SEC`) cap per-file size and total
recording time.

### Prerequisites

- ROS 2 Jazzy sourced environment (`/opt/ros/jazzy/setup.bash` and `$ROBOT_WS/install/setup.bash`).
- **`ros-jazzy-rosbag2-storage-mcap`** — the MCAP storage plugin required by `-s mcap`:

  ```bash
  sudo apt install ros-jazzy-rosbag2-storage-mcap
  ```

- The user running the service must be able to source the ROS environment and write
  to the configured `OUTPUT_DIR` (default `/var/lib/questix/rosbags`).

Recorder settings are persisted to `${QUESTIX_CONFIG_DIR:-/etc/questix_robot}/rosbag.env`.

## ログ回収コンソール (log collection)

The **ログ回収** tab bundles diagnostic logs into a single `.tar.gz` written to a
folder chosen with the shared folder picker (typically a USB stick) — this replaces
the old live journal viewer, since on a headless robot the useful action is to
*retrieve* logs onto removable media. Selectable sources:

- **questix_robot journal** — `journalctl -u questix_robot`.
- **システム全体 journal** — `journalctl -b` (current boot).
- **syslog** — `/var/log/syslog` and `syslog.1`.

Output is bounded so a verbose host cannot produce a multi-GB archive: journals are
capped to their most recent `100000` lines and each syslog file keeps only its last
`50 MB` (older entries are dropped, noted in the file). The archive contains a
`MANIFEST.txt` recording, per source, what succeeded.

### Permissions

The service runs as an unprivileged user. Reading its own unit journal works out of
the box, but the **system journal and syslog** require that user to be in the
`adm` (and/or `systemd-journal`) group:

```bash
sudo usermod -aG adm,systemd-journal "$USER"   # then re-login / restart the service
```

A source the user cannot read does not fail the whole collection — it is recorded as
a per-source error in `MANIFEST.txt` and the archive is still produced.
