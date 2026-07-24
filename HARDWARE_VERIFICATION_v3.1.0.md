# Raspberry Pi 5 実機一括検証 手順書（tag 3.1.0）

Issue [#139](https://github.com/scramble-robot/questix/issues/139) のチェックリストに対する **詳細手順書**。
各項目は「手順（実際に叩くコマンド）→ 期待結果 → 出典（PR/issue）」で構成する。上から順に消化する想定。

> この手順書はコードと config を裏取りして作成している（ノード名・トピック名・パラメータ名・config パスは
> 実装準拠）。Issue #139 本文の記述と細部が異なる箇所は、本書側が実装に一致する。

---

## 用語・環境の前提（最初に一読）

### 起動方法は2系統あり、デフォルトが違う

| 起動方法 | コマンド | `controller_type` | `enable_lidar` | 備考 |
|---|---|---|---|---|
| 手動 launch | `ros2 launch questix_launcher questix_core.launch.xml` | `dualshock` | `false` | 開発・単体検証向け |
| systemd | `sudo systemctl start questix_robot.service` | `uart` | `true` | 本番。`mode=competition` 必須（下記） |

- systemd 版（`systemd/questix_robot_launcher.sh`）は **`/etc/questix_robot/mode` が `competition` のときだけ**
  ROS 2 を launch する。それ以外は何もせず終了（exit 0）するので、systemd で起動確認する場合は先に mode を確認：
  ```bash
  cat /etc/questix_robot/mode        # -> competition でなければ launch されない
  sudo systemctl status questix_robot.service
  sudo journalctl -u questix_robot -f
  ```
- `questix_robot.service` は **システムユニット**（`--user` ではない）。操作は `sudo systemctl ...`。
- Web 管理 UI は別ユニット `questix_robot_manager.service`（`uvicorn` on `127.0.0.1:8888`）。
- **controller_type によってボタン割当と config が切り替わる**（`dualshock` vs `uart`＝Switch2）。
  検証時は自分がどちらで起動したかを常に意識する。手動 launch で uart を使うには
  `... questix_core.launch.xml controller_type:=uart`。

### ノード名早見表（`ros2 node list` / kill / lifecycle で使う実名）

| 役割 | 実ノード名 | 種別 | パッケージ |
|---|---|---|---|
| 走行（＋オドメトリ） | `/drive_component` | lifecycle | `motor_control_app` |
| 射撃 | `/shot_component` | lifecycle | `motor_control_app` |
| ローラー（ESC） | `/esc_motor_control` | 通常 | `esc_motor_control_cpp` |
| 操作可否・非常停止発行 | `/operation_manager_node` | 通常 | `operation_manager` |
| joy ゲート | `/joy_gate` | 通常 | `joy_gate` |
| GPIO 読み取り | `/gpio_reader_node` | 通常 | `gpio_reader` |

> Issue 本文の「operation_manager を kill」等は、実ノード名 `/operation_manager_node` を指す。
> `pkill -f operation_manager` でも可だが、`ros2 node list` の表示名は上表のとおり。

### 記録様式

各項目を消化したら、対応する元 issue（#80 / #82 / #83 / #84 / #85 / #86 / #81 / #87 / #88 / #69 / #90）へ
以下の様式でコメントする。

```
2026-07-xx / <commit> / <確認者> / <branch> — OK（備考）
```

---

## 0. 前提・準備

- [ ] 検証対象を固定：tag `3.1.0` を確認し commit を控える
  ```bash
  git fetch --tags
  git rev-parse HEAD
  git describe --tags
  ```
- [ ] Pi 5 上でビルド・source 済み
  ```bash
  cd <robot_ws>          # 例: /home/ubuntu/robot_ws
  colcon build --symlink-install
  source install/setup.bash
  ```
- [ ] 機材が接続・通電済み：DDT M0602C（左右ホイール, `/dev/ttyACM0`）、FEETECH サーボ（shot, `/dev/servo`）、
      ESC（roller, GPIO 13）、コントローラ（joy / uart_joy）、物理 E-Stop（gpio_reader, BCM 27）
- [ ] シリアル権限を確認（必要なら）：`ls -l /dev/ttyACM0 /dev/servo`

---

## 1. 起動・トピック確認

出典: PR #118 (#85), PR #123 (#88), PR #130 (#87), PR #124/#125 (#81)

- [ ] **フル起動でエラーなく立ち上がる**（レガシー motor app 削除後の影響）
  - 手順（手動）：`ros2 launch questix_launcher questix_core.launch.xml`
    - systemd で確認する場合：`sudo systemctl restart questix_robot.service && sudo journalctl -u questix_robot -f`
  - 期待：致命的エラーなく各ノードが起動。`ros2 node list` に `/drive_component` `/shot_component`
    `/esc_motor_control` `/operation_manager_node` `/joy_gate` `/gpio_reader_node` が並ぶ。
  - 出典：PR #123 / #88

- [ ] **`drive_component` が auto_start で ACTIVE まで到達**（通電済み通常起動で約1秒）
  - 手順：`ros2 lifecycle get /drive_component`
  - 期待：`active`。`drive_component.yaml` の `auto_start: true` / `connect_retry_period_sec: 1.0` により、
    起動後に自動で configure→activate する。
  - 出典：PR #118 / #85

- [ ] **モータ未通電で起動 → 待機 → 通電で自動 activate**
  - 手順：モータ電源 OFF のまま起動 →`ros2 lifecycle get /drive_component`（`unconfigured` を確認）→
    モータ通電 → 再度 `ros2 lifecycle get /drive_component`
  - 期待：未通電中はプロセス存続のまま `unconfigured` で静かにリトライ（1秒周期）。通電すると自動で
    configure→activate。
  - 出典：PR #118 / #85

- [ ] **手動 deactivate 後は自動再 activate されない・モータ停止**
  - 手順：`ros2 lifecycle set /drive_component deactivate` → 放置 → `ros2 lifecycle get /drive_component`
  - 期待：`inactive` のまま自動復帰しない（auto_start タイマは deactivate でキャンセルされる）。モータ停止。
    再開は `ros2 lifecycle set /drive_component activate`。
  - 出典：PR #118 / #85

- [ ] **旧トピックが出ないこと**
  - 手順：`ros2 topic list`
  - 期待：次が **出ない**：`/drive_motor_status` / `motor_status` / `/gpio/controllable_diagnostic` /
    `/roller_emergency_status`
  - 出典：PR #130 / #87

- [ ] **新トピックが従来どおり publish されること**
  - 手順：`ros2 topic list`
  - 期待：次が出る：
    - `/drive_status`（`questix_msgs/DriveStatus`）
    - `/diagnostics`（`diagnostic_msgs/DiagnosticArray`）
    - `/emergency_stop`（`questix_msgs/EmergencyStop`）
    - 現行 ESC ステータスは `/roller_motor_status`（`std_msgs/Float32`。※ `motor_status` とは別物・削除対象ではない）
  - 補足：`single_ddt_motor_feedback` と `joy_axis_drive_status` は **相対名**（コード上スラッシュ無し、
    launch で `/single_ddt_motor_feedback` などに remap）で、single_ddt / joy_axis_drive 系ノードのもの。
    標準の `questix_core.launch.xml` 構成では走行は `drive_component`（`/drive_status` `/odom`）が主。
    これらを検証するときは該当ノードを含む構成で起動すること。
  - 出典：PR #130 / #87

- [ ] **`/emergency_stop` が late-join でも最新ラッチ状態を受信できる**
  - 手順：起動後しばらく経ってから購読開始
    ```bash
    ros2 topic echo /emergency_stop --once
    ```
  - 期待：後から購読しても直近の最新状態（`active` / `source` / `reason`）が1件受信できる。
    QoS は reliable + transient_local（keep-last 1＝latch）。
  - 出典：PR #124 / #81

---

## 2. 走行基本・シリアル

出典: PR #113/#116 (#84), PR #127 (#87)

> パラメータは `launcher/config/drive_component.yaml`（Single Source of Truth）。変更はこの1ファイルを編集。

- [ ] **50Hz joy 入力で取りこぼしが解消**（従来は約10Hzに制限）
  - 手順：joy を動かしながら実効指令レートを計測
    ```bash
    ros2 topic hz /target_twist
    ```
  - 期待：joy を 50Hz 相当で操作したとき、`/target_twist`（＝走行指令）が頭打ちにならず追従する。
  - 出典：PR #113 / #84

- [ ] **走行・停止・モード切替が従来どおり**
  - 手順：走行させて停止（スティック中立）→ ブレーキ保持を確認。`control_mode` を `velocity` / `current` で
    切り替え（`drive_component.yaml` の `control_mode` を変更して再起動、または別 config で起動）。
  - 期待：`brake_on_stop: true`（**velocity モードのみ有効**）で停止時にしっかり停止・保持。両モードで走行可。
  - 出典：PR #113 / #84

- [ ] **DDT 最小コマンド間隔要件の確認 → 必要なら `command_wait_ms` 調整**
  - 手順：50Hz 運転で通信エラー頻度を観察。問題があれば `drive_component.yaml` の `command_wait_ms` を
    `0` から少しずつ上げる。
  - 期待：既定 `command_wait_ms: 0`（無効）で問題なければそのまま。>0 にするとその分コールバックがブロック
    される点に注意。
  - 出典：PR #113 / #84

- [ ] **CRC 不一致 / フィードバックタイムアウトのログ頻度を監視**
  - 手順：50Hz 運転中に launch ログ（または `journalctl -u questix_robot -f`）を観察
  - 期待：CRC エラー（DDT は CRC8/MAXIM）やフィードバックタイムアウトの WARN が過剰に出ない。
    ※ これらは ROS パラメータではなくプロトコル内部処理（フレーム read timeout 10ms、
    フィードバック stale 判定は 0.5s）。
  - 出典：PR #113/#116 / #84

- [ ] **`tcdrain()` 実測・USB serial 切断/再接続の戻り方**
  - 手順：走行中に USB を一時切断→再接続し、復帰までの挙動・遅延を観察
  - 期待：切断中は停止・エラーログ、再接続で復帰。極端な遅延やハングがない。
  - 出典：PR #116 / #84

- [ ] **velocity モードで `/drive_status` の各値が妥当**
  - 手順：走行中に
    ```bash
    ros2 topic echo /drive_status
    ```
  - 期待：`left`/`right`（`MotorFeedback`）の `velocity_rpm` が実測、`current_raw`/`current_amp` /
    `position_raw` / `fault_code` が妥当（`fault_code == 0`）。`linear_velocity` / `angular_velocity` も算出される。
  - 出典：PR #127 / #87

- [ ] **アイドル時：ポーリングでモータが動かない・ブレーキ保持・CRC エラー増なし**
  - 手順：ACTIVE のまま無操作で放置し `/drive_status` とログを観察
  - 期待：`refreshMotorFeedback` のポーリングでモータは動かない。`brake_on_stop` 後の再送でブレーキ保持。
    CRC エラーログが増えない。
  - 出典：PR #127 / #87

- [ ] **configure 時プライミングでモータが動かない**
  - 手順：`ros2 lifecycle set /drive_component cleanup` → `... configure` を実行して観察
  - 期待：`initializeMotor` のプライミング中にモータが動かない。
  - 出典：PR #127 / #87

---

## 3. 安全系

出典: PR #111 (#80), PR #112 (#82), PR #115 (#86), PR #124/#125 (#81), PR #79

- [ ] **上流ノード kill → ホイールが約0.6s 以内に停止**
  - 手順：走行させながら上流を kill
    ```bash
    ros2 lifecycle get /drive_component     # active を確認
    # 別ターミナルで上流を止める（いずれか）
    pkill -f uart_joy_driver    # or: pkill -f joy_gate / pkill -f joy_controller
    ```
  - 期待：`/target_twist` 途絶から約 **0.6s 以内**にホイール停止。
    （`cmd_timeout_sec: 0.5` + watchdog 100ms タイマ ≒ 0.6s。WARN「Command timeout: no /target_twist ...」）
  - 出典：PR #111 / #80

- [ ] **モータ fault 誘発 → ホイール停止**（従来は fault 中も動き続けた）
  - 手順：走行中に fault を誘発（例：一時的な過負荷/配線）→ `/drive_status` の `fault_code` を観察
  - 期待：`fault_code != 0` を検知するとホイール停止。
  - 出典：PR #111 / #80

- [ ] **`/operation_manager_node` を kill → `/joy_gated` が約1.1s 以内にゼロ化**
  - 手順：`/gpio/controllable = true`（操作可能）の状態で
    ```bash
    ros2 topic echo /joy_gated       # 監視用（別ターミナル）
    pkill -f operation_manager       # /operation_manager_node を停止
    ```
  - 期待：`/gpio/controllable` の更新が止まり、**`joy_gate` 側の `controllable_timeout_sec: 1.0` + 100ms タイマ**
    により約 **1.1s** で `/joy_gated` がゼロ化。WARN「no /gpio/controllable update for more than ...」が joy_gate に出る。
  - 出典：PR #112 / #82

- [ ] **operation_manager 再起動 → 次の `true` で passthrough 即再開**
  - 手順：`/operation_manager_node` を再起動（再 launch）→ 操作可能状態に戻す
  - 期待：次の `/gpio/controllable = true` 受信で passthrough 即再開。**joy_gate ノードのログ**に
    「... reception recovered」INFO が出る。
  - 出典：PR #112 / #82

- [ ] **ESC：フルスピードボタンで回転／離すと停止**
  - 手順：`full_speed_button`（既定 `7`：DualShock R2 / Switch2 ZR）を押下→離す
  - 期待：押下で回転（INFO「Full-speed button PRESSED」）、離すと停止（INFO「Full-speed button RELEASED」）。
  - 出典：PR #115 / #86

- [ ] **ESC：押下保持中に joy 切断 → safety_timeout で停止＋WARN（1回）**
  - 手順：ボタン押下を保持したまま joy を切断
  - 期待：`safety_timeout: 1.0` 超過でモータ停止。WARN「Safety timeout: stopping motor」が **1回のみ**。
  - 出典：PR #115 / #86

- [ ] **ESC：保持したまま joy 復旧 → 回らない（自動復帰しない）**
  - 手順：ボタンを押したまま joy を復旧
  - 期待：自動復帰しない（`require_release_` ラッチ）。スロットル無視の INFO
    「Full-speed press ignored after safety timeout: release and press again」が出る。
  - 出典：PR #115 / #86

- [ ] **ESC：release → press で確実に再開**
  - 手順：ボタンを一度離してから再度押す（複数回）。`dualshock` / `uart` 両 config で確認。
  - 期待：release→press で毎回再開。config バリアント
    （`esc_motor_control_cpp.dualshock.yaml` / `.uart.yaml`）でも同一挙動。
  - 出典：PR #115 / #86

- [ ] **物理 E-Stop 押下 → drive / shot / esc の3コンポーネント全停止**
  - 手順：物理 E-Stop（BCM 27）を押下。チェーンを追う場合：
    ```bash
    ros2 topic echo /gpio_27          # gpio_reader_node の出力（Bool）
    ros2 topic echo /gpio/controllable
    ros2 topic echo /emergency_stop
    ```
  - 期待：`gpio_reader_node` が `gpio_27` を publish → `operation_manager_node` が `/gpio/controllable=false` と
    `/emergency_stop`（`active=true`）を publish → drive / shot / esc が全停止。
  - 出典：PR #125 / #81

- [ ] **E-Stop 解除 → 各コンポーネントの復帰セマンティクスどおり**
  - 手順：E-Stop を解除
  - 期待：`/emergency_stop`（`active=false`）配信後、
    - drive：次の指令まで停止のまま → 指令受付再開
    - shot：復帰（configure→activate）
    - ESC：再押下で始動（自動復帰しない）
  - 出典：PR #125 / #81

---

## 4. shot（射撃）

出典: PR #117 (#83), PR #79

> shot のパラメータは **YAML が有効値**（`motor_control_app/config/shot_config.{dualshock,uart}.yaml`）。
> `controller_type` により自動選択。tilt/trigger サーボ ID は 11 / 10、fire_angle=145.0、home_angle=245.0。

- [ ] **射撃中もチルト joy 操作が遅延なく即応**（sleep 撤廃）
  - 手順：射撃しながらチルトを操作
  - 期待：チルトが遅延なく即応。チルト入力は既定 `tilt_axis: 7`（十字キー上下）またはボタン
    （L=up index4 / ZL=down index6）。
  - 出典：PR #117 / #83

- [ ] **fire ボタン連打で1回のみ発射**（多重発射しない）
  - 手順：`fire_button`（既定 `5`：R）を連打
  - 期待：`fire_duration_ms: 300` の間は再発射しない（`is_shooting_` ガード）。1回だけ発射。
  - 出典：PR #117 / #83

- [ ] **射撃中に deactivate → タイマー停止＋home 復帰**
  - 手順：射撃中に `ros2 lifecycle set /shot_component deactivate`
  - 期待：シュートタイマー停止し、トリガーサーボが `home_angle` に復帰（`cancelShotSequence`）。
  - 出典：PR #117 / #83

- [ ] **射撃中にサーボ通電断 → 自動復帰シーケンス**
  - 手順：射撃中にサーボ電源を一時断→復帰
  - 期待：`triggerAutoRecovery` → auto_start による再 configure/activate（on_configure が通電を検査）。
    従来どおり自動復帰。
  - 出典：PR #117 / #83

- [ ] **shot の E-Stop press/release サイクルを通電サーボで確認**
  - 手順：E-Stop 押下→解除を数回。`ros2 lifecycle get /shot_component` で状態遷移を確認。
  - 期待：押下で deactivate→cleanup（サーボ接続解放）、解除で configure→activate。
  - 出典：PR #79

---

## 5. フィードバック・オドメトリ

出典: PR #136 (#69), PR #132 (#90)

- [ ] **DDT フィードバック監視 CLI をポート非競合で起動**
  - 手順：Launcher 起動・`drive_component` ACTIVE の状態で、別ターミナルから
    ```bash
    ros2 run motor_control_app ddt_feedback_monitor
    ```
    - 単体モータ（`/single_ddt_motor_feedback`）を高頻度で見る場合：
      ```bash
      ros2 run motor_control_app ddt_feedback_monitor --ros-args \
        -p motor_feedback_topics:="['/single_ddt_motor_feedback']" -p rate_hz:=10.0
      ```
  - 期待：`/dev/ttyACM0` を**開かず**（既定は `/drive_status` を購読）、左右モータの current/velocity/position/fault
    が motor_id ごとに継続表示。ポート競合が起きない。
  - 補足：`ddt_checker.py`（リポジトリ直下）は **ポートを直接開く保守専用 GUI**。Launcher 稼働中は使わない
    （CLI とは別物）。
  - 出典：PR #136 / #69

- [ ] **走行・停止・モード切替中に監視値が追従、副作用なし**
  - 手順：CLI を出したまま走行/停止/モード切替
  - 期待：監視値が追従。購読のみなので既存の走行/shot/Launcher に副作用なし。
  - 出典：PR #136 / #69

- [ ] **通常起動で auto_start → ACTIVE 到達（odom 経路）**
  - 手順：`ros2 lifecycle get /drive_component`
  - 期待：`active`（オドメトリは `drive_component` に内蔵。別ノードではない）。
  - 出典：PR #132 / #90

- [ ] **`/odom` が約10Hz、フレーム名・共分散が妥当**
  - 手順：
    ```bash
    ros2 topic hz /odom
    ros2 topic echo /odom --once
    ```
  - 期待：約 **10Hz**（`status_publish_rate: 10.0`）。`header.frame_id=odom`、`child_frame_id=base_link`、
    共分散が設定済み。
  - 出典：PR #132 / #90

- [ ] **TF・RViz 表示**
  - 手順：
    ```bash
    ros2 run tf2_ros tf2_echo odom base_link
    ```
    RViz を起動し Fixed Frame=`odom` に設定（`... questix_core.launch.xml enable_rviz:=true` でも可）。
  - 期待：`odom`→`base_link` の TF が更新（`publish_tf: true`）。RViz に base_link と Odometry が表示。
  - 出典：PR #132 / #90

- [ ] **直進 ~1m・その場 360° 旋回でポーズを実測比較**
  - 手順：直進約1m、その場旋回360° を実施して `/odom` のポーズを実測と比較
  - 期待：概ね一致（大きなドリフト・スケール誤差がない）。
  - 出典：PR #132 / #90

- [ ] **回帰確認**
  - 手順・期待：
    - 操縦感・`/drive_status` が不変
    - E-Stop でモータ停止 **かつ** odom ドリフト停止（フィードバック 0.5s 途絶で積分停止・ポーズ固定）
    - `deactivate`→`activate` でポーズ維持
    - `cleanup`→`configure` でポーズがリセット
  - 出典：PR #132 / #90

---

## 対象外

- **#100（Pi 5 向け SD 焼き可能 `.img` 生成）**：未着手のため本手順書の対象外。着手時に別途 SD 焼き→
  Pi 5 起動確認の手順を用意する。

## 完了時の運用（#98 準拠）

各項目を消化したら：

1. 結果（**日付・commit・確認者・ブランチ**）を対応する元 issue
   （#80 / #82 / #83 / #84 / #85 / #86 / #81 / #87 / #88 / #69 / #90）にコメントで残す。
2. [#98 台帳](https://github.com/scramble-robot/questix/issues/98) の該当行「実機検証」列を 🔲 → ✅ に更新。
3. 本手順書（Issue #139）の全項目が済んだら #139 をクローズ。
