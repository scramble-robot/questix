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

## 操作・速度の設定

Joy のキー割り当て、射出・ローラー操作、走行速度・加速度は
[QUESTiX 共通操作設定](../../questix_control_config/README.md) に集約しています。
robot_manager の「操作・速度」タブでコントローラー別に編集・保存し、
ロボットの次回起動／再起動で反映します。保存による自動再起動は行いません。
管理画面には未保存表示・初期値への復元・入力検証・同時編集の競合検出があります。

操作割り当てはコントローラー別のボタン名・軸名から選べます。名前の隣に
ROS の配列番号も表示し、標準配置以外の番号も選択できます。
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
4: ローラー、5: チルト、6: 全方向移動用の左右）。図のキーを押すと機能を選ぶ
ポップアップが開きます。図に重ねた番号や一覧の機能を押すと、その機能の割り当て先を
直接選べます。同じスティックに複数の番号がある場合も、番号ごとに編集できます。
編集ポップアップは選んだキーや機能名の脇に表示し、画面端では位置を調整します。
スマートフォンでは画面下部に表示します。速度・加速度・入力感度・実行中の値は
「速度・詳細設定」、読み込んだプロファイルや配置の説明は「プロファイル情報・操作ガイド」
を開いて確認できます。
ページの自動スクロールは行いません。閉じるボタン・Escape・外側のクリックで
閉じられ、「編集値に反映」を押す前の選択は変更として残りません。
スティックは上下・左右・押し込みを区別し、未割り当てのボタンも選択できます。
「編集値に反映」でフォームと図を更新し、図のすぐ上の「操作設定を保存」で
確定します。保存済み表示中は「編集中に切り替える」を押してから編集してください。
保存中・保存完了・入力エラー・保存失敗は図の近くにも表示します。図から保存する際は
入力エラーがあってもページを自動スクロールせず、問題の項目名を表示します。
保存が失敗した場合も編集値を保持します。
同じ入力に複数の機能を割り当てる場合は、その内容を反映前に表示します。
「チルト上下」（5）の機能名・番号から開くポップアップでは、軸操作と
「上下を別々のボタンで操作」を切り替えられます。「上げるボタン」「下げるボタン」を
それぞれ選び、例えば Switch の X / B や DualShock の L1 / L2 にまとめて割り当てられます。
「編集値に反映」までは操作方法も割り当ても変更されません。
チルトの上下ボタンを割り当てるとボタン操作へ、チルト軸を割り当てると軸操作へ
切り替わります。チルトの上下に同じボタンは指定できません。
チルトは軸操作／ボタン操作の設定に応じて表示し、標準配置にない番号は一覧に
「図の対象外」と表示します。高度な双スティック・直接駆動の割り当ては下の設定欄で確認できます。

各項目の「保存済み」は読み込み時点の設定、「変更後」は未保存の編集値です。
変更行と変更件数を表示し、初期値への復元時にも元の保存値を比較できます。
「実行中の値を取得」を押すと、同じ行の「実行中（取得時点）」と比較できます。
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
