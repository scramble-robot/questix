# QUESTiX RP1 PWM guard

GPIO13のESC信号をRP1 PWM0 channel1（20 ms、normal）で生成し、ROSとは別の
プロセスでlease・切断・出力故障を監視します。Pi 5の射出の標準構成で、出荷YAMLと
ノードの既定は `pwm_backend: rp1_hw` です。Pi 5の配備ではguardを自動起動に設定します。
目的は、プロセス障害時に信号のLowを試みることです。
API/sysfs成功は波形やESCの停止を証明しません。

## 教育用途の構成と信頼範囲

ロボットは従来どおり生徒の `ROBOT_WS/install` を使います。全workspaceの凍結コピー、
承認manifest、root起動validator、ARM ticketはありません。
`questix_robot.service` と既存unit用の `pwm-guard-order.conf` は `After=` の順序だけを指定し、
`Requires=` / `Wants=` は追加しません。guardがなくても走行側の起動条件は変わらず、
rp1_hwのESCノードだけが初期化例外で失敗し、lgpio/simulationへ自動fallbackしません。
走行と射撃の別containerという既存launch構成を維持します。

生徒の編集/build/操作を維持します。初期パスワード・自動ログイン・sudoersは追加しません。同じrobot UIDのコードを
個別認証・隔離しません（N-01受容）。同UIDはARMや指令を送れ、ROS safety topicや
launch.envも信頼範囲です。授業の運転条件と非常停止は教員・作業責任者が管理します。
この信頼契約を、root権限を生徒へ渡す理由にはしません。

guardだけはroot所有の先生が確認したsource snapshotからclean environmentでbuildし、
root所有の2つのprogramを配置します。生徒のcolcon install成果物をrootで実行しません。
root serviceはcapabilityなし、NoNewPrivileges、ProtectSystem=strictで、書込みを
対象PWM0 controllerと `/run/questix_pwm_guard` に限定します。sudo/polkitを追加しません。

## 故障時の契約

- SO_PEERCREDによるrobot UID、所有接続1本、session、sequence、既定500〜2000 µsまたは0を検査。
  guardの既定上限2000 µsはESC YAML/adapterの上限と一致し、直接2001 µsもfault停止。
  sysfsの絶対許容上限2500 µsまで運転許可を広げた意味ではありません。
- ARMは明示要求。ticket不要ですが、現在ownerがいる間は別接続のARMを拒否。
  terminal/faultを同sessionの指令で解除しません。再試行はownerを閉じた新接続の新ARMです。
  故障後の成功ARMは旧session/故障codeと新sessionを標準出力（unitではjournal）に記録し、
  その後の新sessionのfault診断は初期化します。拒否されたARMは故障原因を消しません。
- ARMINGはCOMPLETEまで固定3秒の締切。最短neutral時間の保証ではありません。
  ESC側は既存の2秒neutral準備を維持。
- ACTIVE leaseは既定500 ms（daemon `--lease-ms`、100〜1000 ms）。ESCはROS executor上で
  100 msごとにgateを再評価して更新します。executor停止後は最後の更新から500 msで
  guardが停止を要求します。poll/OS/driverの遅れは別なので電気的な厳密上限ではありません。
  300 ms採用は実機executor遅延の測定後に検討します。
- 所有fdのSTOPはseq/sessionの古さに関係なくLowへ。SHUTDOWNは固定500 ms neutral→Low。
  二重SHUTDOWNで期限を延長しません。ACTIVEのsequence違反はfault停止。
- 接続断・lease失効・faultは即Lowを試みます。normalならperiod/enable不明でもduty=0を
  best effortで書き、不明/逆極性ならenable=0を試みます。確認不能ならFAULT_UNKNOWN/applied=-1。
  FAULT_UNKNOWNでもtickごとに停止を再試行します。確認不能をLow成功と表示しません。
  `enable=0` の電圧（特に逆極性/極性不明）は未確認で、disable成功を電気的Lowとしません。
  次のESC非通電試験でnormal/inversedのdisable時の電圧・過渡・pinmuxをscopeで記録するまでNOT_RUN。
- unknown所有者は変更しません。pending→export準備→Low検査後にCOMMITTED markerを確定。
  markerはroot0600、boot/controller/channel一致を要求。故障後も出力を監視。
- イベントループ例外時もRAIIでemergency Lowを試み、unitのwatchdog/ExecStopPost recover-lowを維持。
- admin/rootのLOW/STATUSとrobotの指令を分離。ownerだけREPORTで自session状態を読めます。
  robot接続は15本まで、admin用に1枠を残します。

root adminの `questix_pwm_ctl low` は出力停止要求、`status` は状態照会です。
robot UIDに管理者LOW/STATUSの権限を付与しません。robotの状態はowner REPORT/roller statusから確認します。

## 最後の砦と未確認事項

非常停止のESC駆動電源のハード遮断を最後の砦として扱います。非常停止で全DDT電源が
切れるとは扱いません。Linux全体hangやguard SIGSTOPでは、最後のPWMが残り得ます。
手動非常停止とは別の、自動独立動力遮断は実装していません。watchdogとuserspaceは代替ではありません。

授業版 `844b381`（main `3178475` + #185）では、2026-10-12にID13でS1〜S6が合格したとの
作業責任者の報告があります。guardのLow・neutral、45分の長いHigh監視で捕捉0回、
5つの停止経路でLow、ESCの無信号への反応、射出を確認した記録です。
この結果は最新mainへの移植後の実機合格を意味しません。検証用SDで新しい
`/launcher_command`・`/motion_permission` 経路のS2/S4/S5/S6と、15分のS3を再確認します。
Linux全体停止や逆極性・極性不明時の電圧を証明した結果でもありません。

## 標準の配備と出荷時の受入

管理者がレビューしたAnsibleコントローラーのソースから、Pi 5用の `setup_kit.yaml` が
`hardware_interfaces` と `pwm_guard` を実行します。イメージ生成でも同じroleを使います。
controllerのソースは内容のSHA-256ごとに別のroot管理ディレクトリへ転送し、その後
installerのno-follow snapshot・clean environment・固定コンパイラでguardだけをビルドします。
studentの `ROBOT_WS/install` は使いません。source identityは運用上の記録で、
rootがGitの設定・hookを読むことはありません。

roleはunitを配置してenableにし、配備中にstart/restartしません（次のbootで起動）。
image buildのchrootではdaemon-reloadせず、offline enableします。既設unitには
別名の `pwm-guard-order.conf` だけを追加し、`launcher-config.conf` など他のdrop-inを保ちます。
`--if-changed` はsource inventory、両binaryのSHA/実行権限、UID/GIDを反映したunitを
確認して同一ならbuildを省略します。sourceの削除は新しいstaging directoryに反映され、
古いファイルが紛れ込みません。旧c7c8b62のmigration_preflightは毎回実行し、PARTIALの
設置記録なら管理者の復旧を要求します。ID13〜16の手作業の設置は撤去せず更新できます。
既存機体の更新はESCを無通電にし、管理者のmaintenance windowで行ってください。

どの機体も、出荷時にESC駆動電源を外してLowとneutralの波形を最低1回ずつ記録します。
起動・停止過渡とfault時の停止を含め、機体ごとの受入記録を残します。過去のID13の
合格だけで別機体の波形や新しいmainの経路を受入済みとは扱いません。

| 経路 | PWM backend / guard |
| --- | --- |
| Pi 5の標準kit / Pi 5 image、通常のESC YAML launch | `rp1_hw`、guardをbootで自動起動 |
| `ros2 run esc_motor_control_cpp esc_motor_control_node`（YAMLなし） | ノード既定も `rp1_hw`。PCでは下の明示設定が必要 |
| PCの開発・単体診断・シミュレータ | 明示した `pwm_backend: simulation` または `test_mode: true`。guardを使わない |
| Pi 4 / 旧backendの明示診断 | 明示した `pwm_backend: auto` / `lgpio` 等、対応するGPIO chipを設定。RP1の標準kit配備対象外 |
| `rp1_hw` でguard/socket/overlayが使えない | 射出の初期化失敗。auto/lgpio/simulationへの切替なし |

自動判別でPCへfallbackする設計ではありません。PC/Pi 4はworkspaceのESC設定を明示して
通常の `colcon build --symlink-install` を使います。標準launchでは `config_file` が設定の入口で、
launchに別の既定値を重ねません。走行許可・非常停止の診断opt-outは既存の明示手順のみです。

### DT overlayとflash-kernel

GPIO13専用の `gpio13-rp1-pwm.dts` をhardware_interfacesへ同じ内容で配置し、
dtcで `questix-gpio13-rp1-pwm.dtbo` を作ります。masterは
`/etc/flash-kernel/dtbs/overlays/`、起動用コピーは `/boot/firmware/overlays/` に保持します。
`config.txt` の末尾に専用markerと `[all]`・`dtoverlay=questix-gpio13-rp1-pwm` を追加するため、
元の `[pi4]` / `[cm4]` の末尾に依存せず、他のboot設定を上書きしません。

Ubuntu公式 `flash-kernel_3.107ubuntu13~24.04.7` のsource archiveとdscのSHA-256を照合して
`functions` を調査しました。`find_all_overlays` は `/etc/flash-kernel/dtbs` を先に探索し、
同じfilenameは先に見つけたものを選び、firmwareの `overlays/` へコピーします。
このためmasterをそこに保持すれば、kernel側が同名を持っても管理者版が優先され、
firmware側のコピーが失われても次のflash-kernelで再配備されます。公式関数だけを
一時directoryへ向けて2回実行し、優先選択とコピーの復旧を確認しました。
実機のkernel更新・pinmux・波形は未確認です。別versionのflash-kernelはこの契約を再確認します。
参照: https://archive.ubuntu.com/ubuntu/pool/main/f/flash-kernel/flash-kernel_3.107ubuntu13~24.04.7.dsc

## 保守用の単体installer（コマンドは手順例、実施記録ではありません）

installerを含むsourceの内容を固定commitでレビューしてください。**rootで生徒のリポジトリの
Git設定/hookを読みません**。commit引数は通常ユーザーが確認した文字列の記録だけで、認証ではありません。
rootとして実行する入口2ファイルは、先に先生がGitHub等の固定sourceと内容/SHAを照合し、
`/root/questix-guard-installer/` などroot管理・非リンク・非公開書込みの場所へ配置します。
未確認の生徒checkout内installerを直接 `sudo bash` で実行しないでください。

```bash
# Teacher first reviews install_guard.sh and install_guard.py and copies both to this protected path.
# Run an absolute protected entry with a clean environment (no BASH_ENV/startup injection).
sudo /usr/bin/env -i PATH=/usr/bin:/bin LANG=C /bin/bash --noprofile --norc \
  /root/questix-guard-installer/install_guard.sh \
  /home/scramble/questix/questix_pwm_guard scramble <source-commit>
```

installerはsourceをno-follow directory FDでroot private snapshotへコピーし、ファイル一覧/SHA256を
表示します。通常ファイルのみ、symlink/特殊ファイル/parent traversal/.gitを拒否し、サイズ/項目数を
制限します。先生が `INSTALL` と答えてからCMakeを実行。事前確認済みsnapshotの非対話承認には
`--yes` を使います。rootでCMakeを実行することは、そのsourceのCMakeも先生が信頼する判断です。
SHAだけでsourceの内容が安全と証明したとはしません。

buildは素のCMake（`QUESTIX_STANDALONE=ON`、C++17、BUILD_TESTING=OFF）、clean env・固定PATH・
固定 `/usr/bin/c++`・private HOME・ccache無効。ROS環境や生徒workspaceのsetupをsourceしません。
colcon/ament packageとしてのbuild/testも維持します。必要なCMake/compilerがなければ停止し、
installerはpackageを自動導入しません。

配置先は `/opt/questix_pwm_guard/{questix_pwm_guard,questix_pwm_ctl}`（root0755）と
`/etc/systemd/system/questix_pwm_guard.service`。source snapshot、旧2バイナリ/unit backup、
SHA記録は `/var/lib/questix_pwm_guard/`。`installed.txt` はPARTIALから最終記録へ更新します。
失敗時は自動再開せず、記録とbackupを確認します。稼働中の更新はしません。先生が先に
ESC OFFでguard停止を確認してから更新します。

**単体installerはenable/start/stop、daemon-reload、reboot、GPIO操作、overlay applyを行いません。**
標準のenableとoverlay配置は上記Ansible roleが担当します。先生がESC OFFでGPIO13の
DT symbol/functionを確認し、正常再起動とLow/neutralの受入を実施します。他PWM/fanの影響も確認。
unitのReadWritePathsはレビューしたUbuntu24/Pi5 PWM0のdevice pathであり、違う機体は照合が必要です。

```bash
# Teacher only, after ESC OFF/DT/controller/consumer checks and measurement preparation:
sudo systemctl daemon-reload
sudo systemctl start questix_pwm_guard.service
sudo /opt/questix_pwm_guard/questix_pwm_ctl status
# Standard Ansible deployment already enables this unit for boot.
# Disable/stop are separate deliberate operations; keep ESC OFF and observe the signal:
sudo systemctl disable questix_pwm_guard.service
sudo systemctl stop questix_pwm_guard.service
```

guardが安定してLowを要求できることを確認した後、出荷既定の `rp1_hw`、GPIO13、
neutral1000、min0/max2000 µs、default socketを使って生徒workspaceをbuildします。
生徒の変更は通常workspaceのinstallから起動します。既存E-stop・`/motion_permission`・
command_arbiterの入力選択と、起動・停止・timeout・複数publisherの後に0を要求する規則を維持します。

### 旧凍結版c7c8b62からの移行

旧配備には `50-rp1-pwm.conf`、reviewed-launch.env、凍結runtime/承認metadataが残ります。
source更新だけではSD上の旧drop-in・launcherは消えません。**今回の再実装を旧配備にそのまま混ぜない**でください。
ESC OFFで、先生が実効unitとbackupを記録し、旧drop-inを撤去し、標準launcherをbase版へ戻し、
robotのROBOT_WS/installが新版ESCを使うことを確認します。旧凍結runtime/証跡は最初から削除しません。
installerは旧robot drop-in（壊れたsymlinkも含む）を検出したら配置を拒否します。
旧reviewed-launch.env、reviewed-release.json、approved-release.sha256、runtime-approved.sha256、
deployment-state、releases/、deployment-in-progressは検出してwarningを出し、自動削除しません。
これらは新版launcher/guardでは参照しませんが、warningは移行完了の保証ではありません。

以下は**先生がESC OFF、サービス停止/無効化、Low/export保持条件を確認した後**の退避手順例で、
実施記録ではありません。既存backupを使い回さず、root管理の新しいdirectoryへ移します。

```bash
# Teacher records effective units, installed launcher SHA, old assets and waveform conditions first.
sudo /usr/bin/mkdir -m 0700 /var/lib/questix_pwm_guard/legacy-<timestamp>
sudo /usr/bin/cp -p /opt/questix_robot/questix_robot_launcher.sh \
  /var/lib/questix_pwm_guard/legacy-<timestamp>/questix_robot_launcher.sh
# Move each existing path below into that new backup, retaining its contents and permissions:
# /etc/systemd/system/questix_robot.service.d/50-rp1-pwm.conf
# /etc/questix_pwm_guard/  (old YAML, launch env and approval metadata together)
# /opt/questix_pwm_guard/releases/
# /var/lib/questix_pwm_guard/deployment-in-progress
sudo /usr/bin/mv -- <one-existing-path-above> /var/lib/questix_pwm_guard/legacy-<timestamp>/
# Repeat mv for each existing path only; do not delete previous source/runtime evidence.
```

先生がレビュー済みの標準 `systemd/questix_robot_launcher.sh` をroot管理へ配置し、
実効robot unitから古いdrop-in依存が消えたこと、ROBOT_WS/installが新版ESCを使うことを確認します。
旧assetの退避だけでlauncher復旧とは扱いません。daemon-reload、guard更新/再起動と信号確認は
別の具体的手順をレビューして実施します。installed.txt/source/以前のbackupは残します。

### 単純な撤去

先生がESC OFF・サービス停止済み/disabled・所有marker/Low保持条件を確認してから、root管理の
2バイナリとunitをbackupへ移します。installer/uninstallはサービス停止・無効化を自動で行いません。
その後のdaemon-reload、lgpio復帰、再起動/pinmux/exportの確認は別判断です。Low/exportを勝手に解除せず、
旧source/installed.txt/backupを証拠として保持してください。停止/disabled確認後のファイル撤去例：

```bash
# Teacher chooses a new, protected backup directory; do not reuse/overwrite prior evidence.
sudo /usr/bin/install -d -m 0700 /var/lib/questix_pwm_guard/removed-<timestamp>
sudo /usr/bin/mv /opt/questix_pwm_guard/questix_pwm_guard \
  /opt/questix_pwm_guard/questix_pwm_ctl /etc/systemd/system/questix_pwm_guard.service \
  /var/lib/questix_pwm_guard/removed-<timestamp>/
```

このファイル撤去はサービス停止/無効化やGPIO unexportを代行しません。

## ソフト試験

colconはguard/ESC/launcherと依存を別build/installへbuildし、gtest、IPC/fake Output、実adapter→fakeguard、
ROS componentの故障status、installerのno-follow copy、launcher/Managerの既存回帰を実行します。
本番daemonにfake I/O/admin UID override/例外注入を含めません。test serverはuninstalled executableだけです。
root専用の実UID分離テストはisolated root runnerで実行し、非root環境では明示skipとして記録します。
