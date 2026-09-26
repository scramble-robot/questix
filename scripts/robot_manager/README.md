# robot_manager

FastAPI-based web control panel for the `questix_robot` systemd service, served by
uvicorn on `127.0.0.1:8888`.

- `app.py` — service control (mode, start/stop/restart with the practice start request,
  「すべて止める」 `/api/stop-all`, launch config).
- `recorder.py` — rosbag recording console (`/api/rosbag/*`).
- `logs.py` — log collection console (`/api/logs/*`).
- `lab.py` — QUESTiX LAB console (`/api/lab/*`): starts/stops the lab bridge and allows or
  forbids driving from the lessons.
- `wifi_ap.py` — read-only access point settings for the QR codes (`/api/wifi-ap`), plus the
  browser controller's address on the access point and the saved `CONTROLLER_TYPE`.
- `static/` — vanilla HTML/CSS/JS frontend (no build step).
- `static/lab/` — QUESTiX LAB web teaching material, served at `/lab/` (see its README).

## Dependencies (pinned)

`requirements.txt` pins the exact versions of fastapi, starlette, pydantic(-core), uvicorn and
their dependencies. `setup.py`, the Ansible role (`robot_autostart`), `update-robot-manager.sh`
and CI all install from it, so every robot and every test run gets the same combination. It stays
in the system Python on purpose (no venv, ROS 2 keeps its apt environment) and is minimal for the
same reason: plain `uvicorn`, not `uvicorn[standard]`, which used to install pyyaml, websockets and
others over the apt copies ROS 2 uses. To upgrade, change the pins together and run the tests with
the new versions installed (also `python3 -s -m pytest`, so `~/.local` does not hide them).

## Updating an installed Robot Manager

The `questix_robot_manager` service runs the pip-installed copy, not this directory, so a
`git pull` does not change what it serves (a missing route then answers HTTP 404). Run
`sudo scripts/update-robot-manager.sh`: when an installed dependency differs from
`requirements.txt` it installs the pinned versions (this step needs the internet); it compares the
installed files with this directory and, only when they differ, replaces `/opt/questix_robot/robot_manager`, reinstalls the package without
downloading anything (`--no-deps --no-build-isolation` when fastapi/uvicorn are present) and
restarts the service. `--check` only reports (exit 0 current / 1 outdated / 2 not installed).
`sudo scripts/wifi-ap.sh up` runs it with `--if-installed` before starting the teaching material,
and `scripts/install-robot-manager.sh --with-gui` uses it for its Robot Manager step.

When something fails (HTTP 500, the service does not come up), run
`sudo scripts/check-robot-manager.sh`. It changes nothing and reports in one go: the Python the
service uses, the version and origin (apt / pip) of fastapi, starlette, pydantic(-core), uvicorn and
anyio including duplicate copies, unmet requirements between them, `pip check`, whether
`robot_manager.app` imports, whether the install matches the repository, the answers of
`/api/status`, `/api/lab/status` and `/api/wifi-ap`, whether the service user can write
`/etc/questix_robot` (and read `wifi_ap.env`), and the last traceback in the service log.

## UI スタイル

QUESTiX Robot Manager の全タブとダイアログは、`static/style.css` の共通テーマを使います。

- 色は `:root` の CSS 変数で管理します。濃紺の背景と鮮やかなシアンのアクセントを基本とし、
  タブ単位で背景色・文字色を上書きしません。コントローラー図の機能識別色は別扱いです。
- セクションは `.card`、操作は `.btn`、補助操作は `.btn-small` を使います。
  保存はシアン、起動は緑、再起動はオレンジ、停止・削除は赤に揃えます。
  再読み込みなどの補助操作は中立色、色付きボタンの文字は濃色にしてコントラストを確保します。
- 日本語ゴシック体を優先し、本文・入力欄は 16px、補助文字は 14px 以上を基本にします。
- 生徒向けの表示では rosbag を「動作データの記録」、bag を「記録データ」と呼びます。
  割り当ての変更、設定の保存、次回起動での使用は、それぞれ別の段階として説明します。
- 入力欄とボタンの基本高さは 44px、角丸は `--radius-control` に統一します。
  キーボードのフォーカス表示と無効状態の表示も共通です。
- 画面幅 639px 以下では設定を1列にし、パス入力をラベルの下に配置します。
  スタイル変更時は全5タブと管理設定、操作設定の編集ダイアログ、フォルダ選択をPC・モバイル幅で確認します。

## 生徒向けの操作と管理設定

通常のタブは「操作」「調整」「記録」「診断ログ」「教材」です。生徒が行う練習／大会モードの
切り替えは「操作」に残し、機体構成・通信設定・記録の詳細設定は右上の「管理設定」に
まとめています。これは画面の整理であり、利用者認証やアクセス権限の分離ではありません。
状態は「ロボット制御：実行中／起動処理中／停止処理中／停止中／起動失敗」と表示します。
「実行中」は制御プログラムが動いていることを示すだけで、コントローラーの接続や操作できることを保証する表示ではありません。

- ヘッダーには、ロボット名・モード（動作中のモードと次回のモード）・ロボット制御の状態・
  非常停止ボタンが押されているときはその表示と、常に **「すべて止める」** があります。
  「すべて止める」は確認なしの1タップで、`POST /api/stop-all` がまず教材の走行・発射を止め
  （教材のブリッジに WebSocket で `{"type":"stop"}` と `{"type":"roller_stop"}` を送る。どのページも
  送れる停止で、ブリッジは再起動せず生徒の接続も切れません）、次にロボット制御（`questix_robot`）を
  停止します。結果は画面上部に項目ごとに表示します。教材からの走行・発射の**許可**は変えません
  （許可・禁止は「教材」タブのスイッチで、先生が意図して切り替えます）。
- 「操作」の最初のカード「いまのロボット」に、ロボット名、モード（動作中／次回）、ロボット制御、
  非常停止ボタン、教材の配信、教材からの走行・発射の許可、いま動かしているのは誰かをまとめて表示します。
  ロボット名は**ホスト名**です（教材のブリッジの `robot_name` の既定値で、生徒の教材画面に出る名前と同じ。
  ブリッジが動いていればブリッジが名乗る名前を表示します）。Wi-Fi の SSID は接続用 QR に、
  `VEHICLE_NAME` は記録名にだけ使い、ここでは使いません。非常停止ボタンの状態は、教材のブリッジが
  走行か発射を許可されて配信しているときだけ分かります（それ以外は「分かりません」）。
- モードの保存値は**次回起動用**です。変更しても実行中のモードは変わりません。ロボット制御が
  動いているときにモードや操作設定を保存すると、画面上部に「今すぐ再起動して反映」を出します
  （押すと通常の再起動確認のあとで再起動します）。
- **練習モードの起動**: 電源投入時、練習モードではロボット制御を起動しません（今までどおり）。
  「起動」「再起動」を押すと練習用の構成で起動します（下の「練習モードの起動要求」）。大会モードの
  起動は今までどおりで、電源投入時にも起動します。起動の結果は、実際に起動したかどうかで表示します
  （「練習用の構成で起動しました」「起動できませんでした：…」）。ロボット制御が動いている間は「起動」を
  押せません。
- 起動前の確認では保存プロファイルとROS・ワークスペースの起動ファイルを確認します。
  コントローラーの物理接続や安全状態の自動判定は行いません。
  旧サービスで `/api/readiness` がない場合は既存APIで保存設定を確認し、起動環境は未確認と表示します。
  新しい環境チェックと設定履歴の保存には、更新済みの管理サービスを起動する必要があります。
- 調整画面は未保存と保存済みを区別し、「ロボットの設定と比較」で実際のROSパラメータと比較します。
  取得できなかった項目は未確認として残します。比較は取得時点の情報で、30秒経過または
  起動・停止操作、取得できたサービス状態・起動設定の変化、通信切断で確認結果を失効させます。
- 操作失敗時は画面上部に案内と詳細を残します。通信断やタイムアウトでは処理完了を断定しません。
- 操作設定の保存前の値は `controls.<controller>.history.json` に直前の1世代を保持します。
  「ひとつ前の設定を読み込む」は編集値を戻すだけで、「操作設定を保存」により確定します。
  既存の競合検出を使用し、外部編集でリビジョンが変わった場合は古い履歴を提示しません。

授業用の標準設定の登録と記録のメモは、この段階では追加していません。

## 練習モードの起動要求 (`start-request`)

`systemd/questix_robot_launcher.sh` (the `questix_robot` service's `ExecStart`, also shipped as
`ansible/roles/robot_autostart/files/questix_robot_launcher.sh`) launches in practice mode only
when Robot Manager asked for it a moment ago:

1. 起動 / 再起動 in practice mode: the manager writes `$QUESTIX_CONFIG_DIR/start-request`
   (atomically, with its own permissions: `mode=practice`, `requested_at=<epoch s>`,
   `boot_id=<kernel boot id>`), then runs `systemctl start|restart questix_robot`.
2. The launcher accepts the request only for the same boot, for `mode=practice` while the mode
   file says `practice`, and when it is at most 120 s old; it deletes the request in any case, then
   runs `ros2 launch questix_launcher questix_core.launch.xml enable_autoreferee:=false
   enable_gpio_ref:=<ENABLE_GPIO_REF from launch.env, default true> controller_type:=…
   enable_lidar/shot/drive/rviz:=…` (the same as competition except the safety profile). With
   AutoReferee off, questix_core's practice defaults add `twist_arbiter` and let the ESC and shot
   nodes accept QUESTiX LAB's launcher input, so the lessons can drive and fire.
3. Without a usable request (power-on, `systemctl start` by hand, a stale request) it logs why and
   exits 0, as before.
4. Every launch writes `$QUESTIX_CONFIG_DIR/last-launch` (`mode`, `started_at`, `boot_id`);
   `/api/status` reports it as `running_mode` while the service runs (`unknown` for a launch by an
   older launcher or from another boot).

The manager then waits up to 4 s for the launcher to take the request and 1.5 s more, and answers
with what happened (`ok`, `message`, `state`, `running_mode`). If the request is still there (an
older launcher that skips practice mode: rerun `scripts/install-robot-manager.sh` or the
`robot_autostart` role) it removes it and says so; a request is also removed when `systemctl`
fails, on 「すべて止める」 / 停止, and whenever the manager starts, so a leftover can never start the
robot later.

**Restart=on-failure**: the request is consumed before launching, so a practice launch that crashes
is *not* restarted (the restart finds no request and exits 0; the unit ends up inactive). The
操作 tab says so when a practice launch ends without a stop through the manager; press 起動 again
after checking the 診断ログ. Competition launches are restarted as before.

For tests, `QUESTIX_CONFIG_DIR`, `QUESTIX_BOOT_ID_FILE` and `QUESTIX_ROS_SETUP` override the
launcher's paths (the service sets none of them); `test_launcher_script.py` runs the real script
with a fake `ros2` and `logger`.

## Competition GPIO safety

The `ENABLE_GPIO_REF` field in `launch.env` applies to practice launches started from Robot
Manager (default and recommended: `true`) and to manual development and diagnostics. When `/etc/questix_robot/mode` is `competition`, the production launcher
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
  "配信中（手動で起動）" and is not stopped from here.
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
  a bridge started here and writes `AUTOSTART`, `ALLOW_DRIVE` and `ALLOW_SHOOT` false, after saving
  the teacher's practice values as `PRACTICE_AUTOSTART` / `PRACTICE_ALLOW_DRIVE` /
  `PRACTICE_ALLOW_SHOOT` in `lab.env` (only when none are saved yet). 配信開始 is refused (409) in
  that mode and the tab disables streaming and both switches with the reason. Switching back to
  練習モード restores exactly the saved values (all on when none were saved, e.g. the mode file was
  edited by hand), clears them, and starts the bridge if automatic start is on; the toast says
  what is on now, so a teacher's explicit forbid is never silently lifted. Automatic start is also
  skipped while the mode file says `competition`, even if it was changed by hand.
- The bridge's stdout/stderr go to `~/.cache/questix/lab-bridge.log` of the service user
  (truncated on every start; discarded if that file cannot be written). While no bridge of ours
  runs, or after a failed start, `/api/lab/status` carries its last 15 lines as `log_tail` and
  the tab shows them under **ブリッジのログ**.
- `/api/lab/status` also carries `bridge`: the running bridge's own `GET /api/state` (ours or one
  started by hand; `null` when none answers within 0.5 s). The tab takes the driving state from
  it (`bridge.read_only`), not from `lab.env`.
- **教材からの走行** (`ALLOW_DRIVE` in `lab.env`, `POST /api/lab/drive`) lets the lessons' driving
  experiments move the robot (`questix_lab_bridge/README.md`, "Driving experiments"); each run is
  confirmed by the learner's safety tick, and `twist_arbiter` lets the controller take over at any
  time. On by default in practice mode; the card's switch 「教材からの走行を許可する」 (one switch,
  its state next to it) is the teacher's off switch. 大会モード turns it off (and it always reads
  as off in that mode), going back to practice restores the teacher's choice. Switching restarts
  a bridge started here (every connected page drops for a few seconds); a bridge started by hand
  keeps its own `allow_drive`. The card's headline combines the permission with what blocks it
  now (「許可済み・いまは走行できません（非常停止ボタンが押されています）」); a missing
  `twist_arbiter` / launcher node is shown only after it lasted 6 s, because a restarted bridge
  reports it for a few seconds while it discovers the ROS graph. The plain reason is on the card;
  the technical cause (`twist_arbiter`, `ROS_DOMAIN_ID`, topics, limits) is under
  「先生・技術者向けの詳しい情報」. If `lab.env` cannot be written when switching off, driving
  still counts as off and the reason is shown as `config_error`.
- **教材からの発射** (`ALLOW_SHOOT` in `lab.env`, `POST /api/lab/shoot`) does the same for the disc
  launcher: the lessons may spin the roller, tilt and fire one disc at a time
  (`questix_lab_bridge/README.md`, "Launcher experiments"); the learner ticks
  「発射する方向に人がいない・的の周りに人がいない」 on the page, and the controller's launcher
  buttons take over at any time. Same policy as driving: on by default in practice mode, the
  card's switch 「教材からの発射を許可する」 is the teacher's off switch, 大会モード turns it off,
  practice restores the teacher's choice, the choice survives a manager restart, a failed write
  still counts as off. The
  card shows `bridge.shoot_state` (who operates it, what blocks it: launcher nodes not accepting
  lab input, another publisher, emergency stop, controller in use). `/api/lab/status` carries
  `shoot_allowed` / `shoot_running` like `drive_allowed` / `drive_running`.
- Both permissions are always passed to the bridge explicitly (`-p allow_drive:=true|false
  -p allow_shoot:=true|false`), so the defaults in `lab_bridge.yaml` (which lets a bridge started
  by hand drive) never decide for a bridge started here.
- A permission error on `mode`, `launch.env` or `lab.env` names the service user, the owner and
  the fix (`sudo chown <user>:<user> /etc/questix_robot …`). `scripts/check-robot-manager.sh`
  checks the same, plus that `wifi_ap.env` is readable.
- `sudo scripts/wifi-ap.sh up` (Wi-Fi access point) turns `AUTOSTART` on and asks a running
  robot_manager to start the bridge, so `http://10.42.0.1:8897/` works right away — except in
  大会モード, where it leaves the bridge alone.

- **スマートフォンで開く** shows two QR codes: ① joins the robot's Wi-Fi access point (from
  `$QUESTIX_CONFIG_DIR/wifi_ap.env`, written by `scripts/wifi-ap.sh`; read-only `GET /api/wifi-ap`,
  `wifi_ap.py`) and ② opens the teaching pages (`http://10.42.0.1:8897/` while the access point
  is on, otherwise the first LAN URL). When `CONTROLLER_TYPE=web`, ③ opens the browser controller
  (`web_joy_driver`, `http://10.42.0.1:8899/`, otherwise port 8899 of the first LAN URL).
  **印刷用の接続カード** (`static/ap-card.html`) is the same set on a printable page (③ only with
  `CONTROLLER_TYPE=web`); `sudo scripts/wifi-ap.sh card` writes the ①② card as a standalone file. QR
  codes are drawn as SVG from `static/vendor/qrcode.js` (qrcode-generator, MIT, see
  `static/vendor/NOTICE.md`) by `static/qr-svg.js`, which fits the strict CSP of the manager UI.

Prerequisite: `questix_lab_bridge` is built in `ROBOT_WS` (`colcon build`; rosdep key
`python3-websockets`). If the node exits immediately, starting fails with an error (and the log
above). The bridge only subscribes unless 教材からの走行 is on; then it may publish
`/target_twist/lab` (twist_arbiter's lab input) and nothing else.

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

Disk protection: recording refuses to start when free space is below `確保する空き容量（GB）`
(`MIN_FREE_GB`, HTTP 507) and auto-stops (via SIGINT, so the bag is finalized) if
free space drops below that threshold mid-recording. Optional `ファイルの分割サイズ（MB）`
(`MAX_SPLIT_MB`) and `記録する時間（秒 / 0=無制限）` (`MAX_DURATION_SEC`) cap per-file size and total
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

## 診断ログの保存 (log collection)

The **診断ログ** tab bundles diagnostic logs into a single `.tar.gz` written to a
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


## ブラウザ操作とスマホ接続用 QR

「操作」タブの「ブラウザ・スマホのコントローラー」で、`web_joy_driver` を開けます。
カードの最初の行に、次回の起動で使うコントローラー（`CONTROLLER_TYPE`）が Web かどうかを表示し、
Web でないときは「管理設定を開く」で切り替え先へ移動できます。
URL は自動で入ります: ロボットの Wi-Fi（アクセスポイント）がオンなら `http://10.42.0.1:8899/`
（`/api/wifi-ap` の `controller_url`）、それ以外は「教材」タブが知っているロボットの LAN アドレスの
ポート 8899 です（Robot Manager は `127.0.0.1` でだけ動くため、画面のアドレスからは作れません）。
URL は編集でき、編集した後は自動で書き換えません。ドライバーのポートや認証トークンは自動取得しないので、
変えた場合は URL に反映してください。
「ブラウザで操作」リンクで QR 生成なしで直接開けます。
PC ではキーボード（Space を保持して WASD / 矢印など）、スマホ・タブレットではタッチ操作が使えます。
Android アプリは不要です。詳細は [Web Joy の操作方法](../../web_joy_driver/README.md) を参照してください。
接続用 QR はスマホのカメラからブラウザで開く場合にも利用できます。`CONTROLLER_TYPE=web` のときは
「教材」タブの「スマートフォンで開く」と印刷用の接続カードにも ③ コントローラーの QR が出ます。

QR は同梱の `static/vendor/qrcode.js`（qrcode-generator 2.0.4、Wi-Fi・教材の QR と共用）によりブラウザ内で生成します。
外部の QR 生成サービスや CDN への通信はありません。URL 編集時には古い QR を消します。

フロントエンドの URL・QR テスト:

```bash
node --test scripts/robot_manager/tests/web_joy_connection.test.cjs
```

## 操作・速度の設定

Joy のキー割り当て、射出・ローラー操作、走行速度・加速度は
[QUESTiX 共通操作設定](../../questix_control_config/README.md) に集約しています。
QUESTiX Robot Manager の「調整」タブでコントローラー別に編集・保存し、
ロボットの次回起動／再起動で反映されます。保存しても自動では再起動しません。
管理画面には未保存表示・初期値への復元・入力検証・同時編集の競合検出があります。

操作割り当てはコントローラー別のボタン名・軸名から選べます。名前の隣に
ROS の配列番号も表示し、標準配置以外の番号も選択できます。
コントローラーは UART / Switch・DualShock・Web（ブラウザ・スマホ、`web_joy_driver`）の 3 種類で、
管理設定の「機体・接続の設定」（`CONTROLLER_TYPE`）で選べます。「調整」で編集できるのは UART / Switch と
DualShock で、設定ファイルはそれぞれ別（`controls.uart.yaml` / `controls.dualshock.yaml`）です。
Web はブラウザの操作画面でボタンの役割が決まっているため、同梱の `controls.web.yaml` を固定で使い、
「調整」では編集しません（次回起動が Web のときは「調整」にその旨を表示し、「別のコントローラー用の設定です」
という警告は出しません。保存 API も 409 で断ります）。「操作設定を保存」のバーは未保存の変更があるときだけ
表示し、保存後にロボット制御が動いていれば画面上部に「今すぐ再起動して反映」を出します。
UART の名前は `uart_joy_driver` のプロトコルに合わせています。DualShock は
Linux の標準配置を表示するもので、接続機器の自動判別ではありません。
[joy_node の配列順は機器依存](https://github.com/ros-drivers/joystick_drivers/blob/ros2/joy/README.md)
のため、独自の接続環境では実際の番号に合わせてください。

コントローラー図には、通常の走行・射出操作で使うスティックやボタンを番号付きで
表示します。PC では図の周囲に機能名と入力名を表示し、線で対応するキーにつなぎます。
小さな画面では図を拡大し、機能名は図の下の一覧に表示します。
中央の補助ボタンは割り当てがある場合だけ表示し、タッチパッドは図から省略しています。
タッチパッドに既存の割り当てがある場合は「図の対象外」として一覧に残ります。
「編集中」と「保存済み」を切り替えて配置を比較でき、変更した割り当ては
色でも表示します。番号は機能に固定されます（1: 前後、2: 旋回、3: 射出、
4: ローラー、5: 射出角度の調整、6: 全方向移動用の左右）。図のキーを押すと機能を選ぶ
ポップアップが開きます。図に重ねた番号や一覧の機能を押すと、その機能の割り当て先を
直接選べます。同じスティックに複数の番号がある場合も、番号ごとに編集できます。
編集ポップアップは選んだキーや機能名の脇に表示し、画面端では位置を調整します。
スマートフォンでは画面下部に表示します。走行速度・旋回速度・ローラー出力・スティックの遊びは
「速度・操作感」、読み込んだプロファイルや配置の説明は「設定を戻す・設定情報・操作ガイド」
を開いて確認できます。
ページの自動スクロールは行いません。閉じるボタン・Escape・外側のクリックで
閉じられ、「この割り当てに変更」を押す前の選択は変更として残りません。
スティックは上下・左右・押し込みを区別し、未割り当てのボタンも選択できます。
「この割り当てに変更」で編集画面のフォームと図を更新し、「操作設定を保存」で
確定します。保存済み表示中は「割り当てを編集する」を押してから編集してください。
保存中・保存完了・入力エラー・保存失敗は図の近くにも表示します。図から保存する際は
入力エラーがあってもページを自動スクロールせず、問題の項目名を表示します。
保存が失敗した場合も編集値を保持します。
同じ入力に複数の機能を割り当てる場合は、その内容を反映前に表示します。
「射出角度を上げる」「射出角度を下げる」（5↑ / 5↓）は常に別々に表示します。
各ラベルからポップアップを開き、十字キー・スティックの方向やボタンを選べます。
例えば「上げる＝十字キー上、下げる＝B」のように異なる種類の入力も組み合わせられます。
選んだ方向だけを編集し、反対方向の現在値も表示します。
上下に同じ入力は指定できません。「この割り当てに変更」までは割り当てを変更しません。
標準配置にない番号は一覧に「図の対象外」と表示します。
左右独立スティック・直接駆動専用の設定は、この画面では扱いません。

「速度・操作感」は日常の調整に使う6項目に絞っています。
走行速度は m/s、旋回の速さは標準比 %、ローラー出力・スティックの遊びは % で表示します。
旋回はプロファイルの初期値を100%とし、「ゆっくり 50%」「標準 100%」「速め 150%」
からも選べます。保存済みの速度を変更しても、100%の基準は変わりません。
独自プロファイルで初期値が0の場合のみ、比率を定義できないため回転/秒で表示します。
加速・減速は「走り出し・停止のきびきび感」「旋回のきびきび感」で別々に調整します。
初期値を100%として「おだやか 50%」「標準 100%」「きびきび 150%」から選べます。
低くすると速度がゆっくり変化し、スティックを戻して停止するまでの時間も長くなります。
最高速度の設定には影響しません。
加減速はプリセットか正の数値で調整します。ON/OFFの切り替えはありません。
既存の内部値0（制限なし）は、その項目を編集せず保存した場合に維持します。
初期値0の独自設定では加速度の単位で入力します。
表示単位は保存時に ROS の単位へ変換し、既存の走行・旋回方向の反転も維持します。
各項目に数値を変えたときの効果を説明し、「保存済み」と「変更後」を並べています。
速度は指令値で、実際の速度は車体の制限や路面によって変わります。

モータ RPM、低速不感帯、目標速度付近の緩和幅、全方向移動用の左右速度、
単体起動専用の設定は画面に表示しません。保存時にも既存値を維持します。
「速度・操作感を初期値に戻す」は表示中の6項目だけを対象とし、キー割り当ても維持します。
「ロボットの設定と比較」を押したときだけ、各項目に「実行中（取得時点）」を表示します。
初回表示時には Launch 設定の
コントローラーを選択し、編集対象・Launch 設定・読み込み時刻を表示します。

フロントエンドの回帰テスト（追加依存なし）:

```bash
node --test scripts/robot_manager/tests/*.test.cjs
```

### 実行中の設定の取得

`GET /api/control-runtime` は `launch.env` の `ROBOT_WS`・`ROS_DISTRO`・
`ROS_DOMAIN_ID` を使い、短時間の ROS `GetParameters` クライアントで
編集対象パラメータだけを読み取ります。自動ポーリング、パラメータ書き込み、
ロボットの再起動は行いません。複数ノードの応答待ちは共通の期限内で行い、
同時リクエストは制限しています。

実行中の列は取得時刻付きのスナップショットです。ノード未検出・応答なし・
未宣言パラメータを区別し、取得できなかった値を保存済み設定で補完しません。
コントローラー種別は実機から判別していないため、実行中の軸・ボタンは番号で表示します。
別のプロファイルを編集中の場合も、問い合わせ先は表示された ROS_DOMAIN_ID のノードです。
取得には ROS 2 とビルド済みのワークスペースが必要です。

API を追加したバージョンへ更新した場合は、管理画面サービスの再起動が必要です。
保存済みのキー設定を実際のロボットに適用する再起動とは別の操作です。
