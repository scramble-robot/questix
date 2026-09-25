# robot_manager

FastAPI-based web control panel for the `questix_robot` systemd service, served by
uvicorn on `127.0.0.1:8888`.

- `app.py` — service control (mode, start/stop/restart, launch config).
- `recorder.py` — rosbag recording console (`/api/rosbag/*`).
- `logs.py` — log collection console (`/api/logs/*`).
- `lab.py` — QUESTiX LAB console (`/api/lab/*`): starts/stops the lab bridge and allows or
  forbids driving from the lessons.
- `wifi_ap.py` — read-only access point settings for the QR codes (`/api/wifi-ap`).
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
  スタイル変更時は全4タブと管理設定、操作設定の編集ダイアログ、フォルダ選択をPC・モバイル幅で確認します。

## 生徒向けの操作と管理設定

通常のタブは「操作」「調整」「記録」「診断ログ」です。生徒が行う練習／大会モードの
切り替えは「操作」に残し、機体構成・通信設定・録画の詳細設定は右上の「管理設定」に
まとめています。これは画面の整理であり、利用者認証やアクセス権限の分離ではありません。
全画面の「ロボット停止」は既存のサービス停止操作です。
状態は「ロボット制御：実行中／起動処理中／停止処理中／停止中／起動失敗」と表示します。
実行中は制御プログラムの実行状態で、コントローラーの接続や操作可能を保証する表示ではありません。

- モードは**次回起動用の保存値**を表示します。変更しても実行中のモードは変わりません。
  既存のランチャー仕様により、練習モードではサービスからのROS起動をスキップします。
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

授業用の標準設定の登録と録画メモは、この段階では追加していません。

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
  a bridge started here and writes `AUTOSTART="false"`; switching back to 練習モード writes
  `AUTOSTART="true"` and starts the bridge again (unless one already runs). Automatic start is
  also skipped while the mode file says `competition`, even if it was changed by hand.
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
  time. On by default in practice mode; the card's 「教材からの走行を止める」 is the teacher's off
  switch. 大会モード turns it off (and it always reads as off in that mode), going back to practice
  turns it on. Switching restarts a bridge started here (every connected page drops for a few
  seconds); a bridge started by hand keeps its own `allow_drive`. The card lists, for the teacher,
  what still blocks driving (`bridge.drive_state.blockers`: no `twist_arbiter` or a different
  `ROS_DOMAIN_ID`, another publisher on `/target_twist/lab`, emergency stop), the robot name,
  connected pages and which page drives. If `lab.env` cannot be written when switching off,
  driving still counts as off and the reason is shown as `config_error`.
- **教材からの発射** (`ALLOW_SHOOT` in `lab.env`, `POST /api/lab/shoot`) does the same for the disc
  launcher: the lessons may spin the roller, tilt and fire one disc at a time
  (`questix_lab_bridge/README.md`, "Launcher experiments"); the learner ticks
  「発射する方向に人がいない・的の周りに人がいない」 on the page, and the controller's launcher
  buttons take over at any time. Same policy as driving: on by default in practice mode, the
  card's 「教材からの発射を止める」 is the teacher's off switch, 大会モード turns it off, practice turns it
  on, the teacher's choice survives a manager restart, a failed write still counts as off. The
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
  is on, otherwise the first LAN URL). **印刷用の接続カード** (`static/ap-card.html`) is the same
  pair on a printable page; `sudo scripts/wifi-ap.sh card` writes it as a standalone file. QR
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

Disk protection: recording refuses to start when free space is below `確保する空き容量 (GB)`
(`MIN_FREE_GB`, HTTP 507) and auto-stops (via SIGINT, so the bag is finalized) if
free space drops below that threshold mid-recording. Optional `ファイルの分割サイズ (MB)`
(`MAX_SPLIT_MB`) and `記録する時間 (秒 / 0=無制限)` (`MAX_DURATION_SEC`) cap per-file size and total
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

「制御」タブの「ブラウザ・スマホで操作」で、`web_joy_driver` を開けます。
有効な URL を入力すると「ブラウザで操作」リンクが表示され、QR 生成なしで直接開けます。
PC ではキーボード（Space を保持して WASD / 矢印など）、スマホ・タブレットではタッチ操作が使えます。
Android アプリは不要です。詳細は [Web Joy の操作方法](../../web_joy_driver/README.md) を参照してください。
接続用 QR はスマホのカメラからブラウザで開く場合にも利用できます。
URL は編集可能です。管理画面を LAN アドレスで開くと同じホストの HTTP ポート 8899 を
初期候補にします。`localhost` で開いた場合は、スマホから到達できるロボットの IP を
入力してください。ドライバーのポートや認証トークンは自動取得しません。

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
ロボットの次回起動／再起動で反映します。保存による自動再起動は行いません。
管理画面には未保存表示・初期値への復元・入力検証・同時編集の競合検出があります。

操作割り当てはコントローラー別のボタン名・軸名から選べます。名前の隣に
ROS の配列番号も表示し、標準配置以外の番号も選択できます。
コントローラーは UART / Switch・DualShock・Web（ブラウザ・スマホ、`web_joy_driver`）の 3 種類で、
管理設定の「機体・接続の設定」（`CONTROLLER_TYPE`）と「調整」の編集対象の両方で選べます。
設定ファイルもそれぞれ別（`controls.uart.yaml` / `controls.dualshock.yaml` / `controls.web.yaml`）です。
Web 用の図は操作ページの「移動」カード（左スティック＝前後・左右、右スティック＝旋回）と
「ショット」カード（TILT ▲・FIRE・TILT ▼・ROLLER）をページと同じ配置・名前で描きます。
ページが送らない入力（十字キーや A/B/X/Y など）は選択肢に出さず、既存の割り当ては「図の対象外」になります。
Web のスティックの遊びは `web_joy_driver` の `deadzone` として保存されます。
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
「実行中の設定と比較」を押したときだけ、各項目に「実行中（取得時点）」を表示します。
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
