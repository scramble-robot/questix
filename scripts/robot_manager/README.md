# robot_manager

FastAPI-based web control panel for the `questix_robot` systemd service, served by
uvicorn on `127.0.0.1:8888`.

- `app.py` — service control (mode, start/stop/restart, launch config).
- `recorder.py` — rosbag recording console (`/api/rosbag/*`), the single recording authority.
- `trial.py` — classroom trial evidence helpers (metadata, source identity, integrity).
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

## 授業用 trial 記録 (classroom trial evidence)

授業の改善ループ（現状観察 → 1変数変更 → 再試行 → 比較 → 判断 → baseline復帰）で取った
bag を、あとから再現・比較できるようにするための記録モードです。**録画の仕組みは増やさず**、
上記 generic recorder と同じ 1 本の `ros2 bag record` プロセス・ロック・状態をそのまま使い、
bag と同じディレクトリに evidence（sidecar）を置きます。

- generic 録画: `POST /api/rosbag/start` — 従来どおり。メタデータも sidecar も無し。
- 授業 trial: `POST /api/rosbag/start-trial` — 同じ recorder + evidence。

同時に走る録画プロセスは 1 本だけで、二重 start は従来どおり HTTP 409 です。

### passive contract（この記録系がやらないこと）

classroom trial logger は**完全に受動的**です。ROS に対して行うのは
`topic list` / `node list` / `param dump` / `bag info` という読み取りだけで、以下は一切行いません。

- `/target_twist` などへの publish、モーター・射出・ESC の操作
- `ros2 param set`、lifecycle 遷移、E-stop 解除
- シリアルデバイスの直接オープン、rosbag の再生

そのため recorder 側が失敗しても、ロボット制御には影響しません（evidence が欠けるだけです）。
この不変条件は `test_trial_evidence.py` の `PassiveContractTests` で機械的に検査しています。

### ROS 実行環境の権威 (runtime environment authority)

`questix_robot.service` は `/etc/questix_robot/launch.env` を読みますが、robot_manager の
サービス自身は同じ ROS 環境である保証がありません。そこで classroom trial では**録画開始ごとに**
`launch.env` を読み、`ROBOT_WS` と `ROS_DOMAIN_ID` を解決します。

- topic/node 探索、parameter dump、`ros2 bag record`、`ros2 bag info` はすべてこの解決済み環境で実行します。
- `/opt/ros/jazzy/setup.bash` と `${ROBOT_WS}/install/setup.bash` の**両方が必須**です。どちらかが
  無い・source に失敗する場合は、**evidence ディレクトリを作る前・recorder プロセスを起動する前に**
  失敗します（HTTP 503）。preflight 自体がこの prelude 経由で実行されるため、ここで必ず検出されます。

  | exit code | 意味 |
  | --- | --- |
  | 90 | `/opt/ros/jazzy/setup.bash` が無い |
  | 91 | `/opt/ros/jazzy/setup.bash` を source できない |
  | 92 | `${ROBOT_WS}/install/setup.bash` が無い（ワークスペース未ビルド） |
  | 93 | `${ROBOT_WS}/install/setup.bash` を source できない |

- `launch.env` に `ROS_DOMAIN_ID` が無い場合はプロセス環境 → ROS 既定値の順にフォールバックし、
  どの出所を使ったかを evidence と warning に残します。
- **実行時 ROS 環境**（`ROS_DISTRO` / `ROS_DOMAIN_ID` / `RMW_IMPLEMENTATION` /
  `ROS_LOCALHOST_ONLY` / `ROS_AUTOMATIC_DISCOVERY_RANGE` / `ROS_STATIC_PEERS`）は
  source **後**のシェル内で読み取り、`questix_trial.yaml` の `runtime.effective_env` と
  `source_identity.txt` に保存します。`ROS_DISTRO` は `setup.bash` が定義するため、source 前の
  環境は「どう録画されたか」の証拠になりません。解決値と実行時 `ROS_DOMAIN_ID` が食い違う場合は
  warning を出します。

generic 録画の環境解決は従来のまま変更していません（厳格化は classroom 経路だけです）。

### QUESTiX source identity の権威

Robot Manager は `/opt/questix_robot/robot_manager`（および site-packages）へコピーして
インストールされるため、**自分自身の `__file__` は Git チェックアウトではありません**。そこで
classroom trial は、実際に動いている QUESTiX ソースを次の順で解決します。

1. `launch.env` の `QUESTIX_SOURCE_DIR`（任意。明示指定が必要な環境向け）
2. `${ROBOT_WS}/src/*`（`colcon build --symlink-install` ではここが実ソースツリー）
3. Robot Manager 自身のディレクトリ（チェックアウトから直接起動している開発機向け）

候補は「git work tree であること」かつ「QUESTiX のマーカー（`launcher/package.xml` と
`systemd/questix_robot_launcher.sh`）を持つこと」の両方を満たす必要があります。

解決できない、または 40 桁の commit SHA が取得できない場合、classroom trial は **HTTP 503 で失敗**
します。`unknown` を正常として記録しません。bag だけが必要な場合は generic 録画を使ってください。

### preflight

開始前に ROS グラフを読み取り、次が揃っていなければ**録画プロセスを起動しません**（HTTP 409）。

- 必須: ノード `/drive_component`、トピック `/target_twist`、`/drive_status`
- 任意: `/joy`、`/joy_gated`、`/odom`、`/emergency_stop`、`/diagnostics`、`/parameter_events`

任意トピックの欠落は記録するだけで、trial を止めません。`/parameter_events` も必須ではありません。

### 収集するメタデータ

`trial_id` / `team_id`（匿名）/ `robot_id` / `condition_label` / `floor` / `payload_kg` /
`battery_voltage` / `memo` のみを受け付けます。

**氏名・学籍番号・メールアドレス・学校名の項目は schema に存在せず、送られても拒否します**
（未知のキーは HTTP 422）。値は長さ・文字種を検証したうえで YAML sidecar に書き出すだけで、
シェルコマンドへ展開されることはありません。

### evidence ディレクトリ

`ros2 bag record -o <bag>` は自分でディレクトリを作るため、開始前の evidence はいったん
隠しディレクトリへ書き、bag ができてから移します。staging 名は（衝突回避済みの）bag 名から作り、
`mkdir` で**排他的に**作成するので、同じ trial ID をやり直しても、失敗した trial の staging が
残っていても、evidence が混ざることはありません。

```text
OUTPUT_DIR/
├── .trial_robot1_20260921_193000.evidence.tmp/   # 作成中 / 失敗時のみ残る
└── robot1_20260921_193000/
    ├── metadata.yaml           # rosbag2 の所有物（sidecar は絶対に上書きしない）
    ├── robot1_0.mcap
    ├── questix_trial.yaml      # schema_version 付きの trial 記録
    ├── source_identity.txt     # 40桁 commit SHA / branch / dirty / describe
    ├── topic_list.txt          # 開始時のトピック一覧
    ├── drive_params_before.yaml
    ├── drive_params_after.yaml
    ├── joy_params_before.yaml  # /joy_controller がある場合のみ
    ├── joy_params_after.yaml
    ├── parameter_diff.txt      # before/after の unified diff（差分が無ければその旨）
    ├── bag_info.txt            # ros2 bag info の出力
    └── recorder.log            # recorder の stdout/stderr
```

sidecar は一時ファイル → rename で書き出します。`questix_trial.yaml` には `schema_version`、
実効 recorder 設定（`-a -s mcap` と `EXCLUDE_TOPICS`）、runtime（解決値と実行時 `effective_env`）、
source（解決元 `origin` 付き）、preflight、結果が入ります。
Git の diff 本文は保存しません（dirty/clean のみ）。

bag 名は従来どおり `<vehicle>_<YYYYMMDD_HHMMSS>` ですが、同名ディレクトリが既にある場合は
trial ID、さらに連番を足して**既存 bag を絶対に上書きしません**。

### 失敗時の扱い (failure semantics)

- 必須ノード/トピック欠落・ROS 環境解決失敗: 録画プロセスを起動せずエラー。
- 起動直後に recorder が落ちた場合: `recorder.log` と `status: start_failed` の
  `questix_trial.yaml` を staging に**残します**（部分的な evidence は消しません）。
- parameter dump 失敗: 録画は続行し、warning として evidence と UI に出します。
- 停止は従来どおり SIGINT。SIGTERM/SIGKILL へ escalate した場合は正常 finalize とは扱わず、
  `finalize: finalize_timeout` として記録し、integrity は `ok` になりません。
- classroom trial の停止理由は `user_stopped` / `auto_stopped_low_disk` / `max_duration` /
  `process_exited` / `start_failed` / `shutdown` を区別します（finalize の成否は
  `last_finalize_reason` で別に持ちます）。generic 録画の停止理由は従来どおり `stopped` /
  `auto_stopped_low_disk` / `process_exited` / `start_failed` のままです。
- 低容量の自動停止（SIGINT）と最小空き容量ガードは generic と共通で、従来どおり動作します。

### 停止時の順序（evidence の帰属）

授業では「Trial A 停止 → parameter 変更 → Trial B」と進むため、停止 API が返ったあとに
parameter を変えられても Trial A の `*_params_after.yaml` が汚れない順序にしてあります。

```text
SIGINT → recorder 終了
  ├─ 同期: drive/joy parameter-after dump → parameter_diff.txt 確定   ← ここまで終えてから
  └─ HTTP stop 応答
        └─ 非同期: ros2 bag info → integrity 判定 → sidecar を bag へ移動
```

- 停止 API が返った時点で、直前 trial の after parameter と diff は確定しています。
- この同期区間の間は録画スロットを保持したままなので、次の trial start は HTTP 409 になります
  （数秒）。低容量自動停止・プロセス自己終了（`/status` による回収）・サービス停止でも同じ順序です。
- parameter dump に失敗しても停止自体は成功し、warning として evidence と UI に残ります。

停止後、同じ ROS 環境で `ros2 bag info` を実行し、`/target_twist` と `/drive_status` の
メッセージが 1 件以上あるかを見て `ok` / `warning` / `failed` を API と UI に返します。
出力フォーマットに過度に依存しない緩いパーサで、読み取れなければ `warning` に落とします。
UI は evidence の状態を `作成中...` → `OK` / `要確認` / `失敗` と表示します。

### サービス停止時の挙動（generic を含む意図的な変更）

Robot Manager の shutdown 時に、**自身が所有する録画プロセスを SIGINT で graceful finalize**
するようになりました。これは generic 録画にも効きます（従来は録画プロセスが finalize されずに
残る可能性がありました）。classroom trial の場合は evidence の確定まで待ってから終了します。

### 授業でのA/B手順

1. 「授業trial記録」を ON にし、`condition_label` に `baseline` と入れて録画 → 停止。
2. パラメータを**1つだけ**変更して再起動（変更自体は robot 側の作業で、この画面は行いません）。
3. `condition_label` に変更内容（例 `max_speed 1.5`）を入れて録画 → 停止。
4. 2 本の bag の `questix_trial.yaml` / `parameter_diff.txt` / `bag_info.txt` を比較して判断。
5. baseline に戻し、`condition_label` を `baseline_restored` にして確認録画。

### rosbag_manager 互換

Robot Manager 側では、sidecar が同居した bag の一覧・削除・MCAP 認識が壊れないことを
テストで確認しています（`.trial_*.tmp` は一覧にも削除 API にも出ません）。
実運用の `rosbag_manager` でのカタログ取り込み互換は、ソースが手元に無いため**未確認**で、
Raspberry Pi 5 での統合確認項目として残しています。

PlotJuggler 連携、parameter 変更 UI、allowlist プロファイルは本機能の対象外です。

### テスト

```bash
python3 -m unittest discover -s scripts/robot_manager -p 'test_*.py' -t scripts/robot_manager
```

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
