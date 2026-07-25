# robot_manager

FastAPI-based web control panel for the `questix_robot` systemd service, served by
uvicorn on `127.0.0.1:8888`.

- `app.py` — service control (mode, start/stop/restart, launch config).
- `recorder.py` — rosbag recording console (`/api/rosbag/*`).
- `logs.py` — log collection console (`/api/logs/*`).
- `static/` — vanilla HTML/CSS/JS frontend (no build step).

## Competition GPIO safety

The `ENABLE_GPIO_REF` field in `launch.env` is retained for manual development and
diagnostics. When `/etc/questix_robot/mode` is `competition`, the production launcher
ignores that field and always passes `enable_gpio_ref:=true` together with
`enable_autoreferee:=true`. Therefore an existing `launch.env` containing
`ENABLE_GPIO_REF=false` cannot disable the GPIO5 physical E-stop and GPIO27
AutoReferee safety path. `enable_autoreferee:=true` with `enable_gpio_ref:=false` is
not a valid operational configuration.

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
