# QUESTiX RP1 PWM guard

GPIO13のESC信号をRP1 PWM0 channel1（20 ms、normal）で生成し、ROSとは別の
プロセスでlease・切断・出力故障を監視します。明示的な `pwm_backend: rp1_hw` の
opt-inです。`auto`は選びません。目的は、プロセス障害時に信号のLowを試みることです。
API/sysfs成功は波形やESCの停止を証明しません。

## 教育用途の構成と信頼範囲

ロボットは従来どおり生徒の `ROBOT_WS/install` を使います。全workspaceの凍結コピー、
承認manifest、robotサービスのdrop-in、root起動validator、ARM ticketはありません。
`questix_robot.service` はguardに依存しません。guardがなくても走行側の起動条件は変わらず、
rp1_hwを明示したESCノードは初期化例外で失敗し、simulationへ自動fallbackしません。
走行と射撃の別containerという既存launch構成を維持します。

scrambleの自動ログインと生徒の編集/build/操作を維持します。同じrobot UIDのコードを
個別認証・隔離しません（N-01受容）。同UIDはARMや指令を送れ、ROS safety topicや
launch.envも信頼範囲です。授業の運転条件と非常停止は教員・作業責任者が管理します。
この信頼契約を、root権限を生徒へ渡す理由にはしません。

guardだけはroot所有の先生が確認したsource snapshotからclean environmentでbuildし、
root所有の2つのprogramを配置します。生徒のcolcon install成果物をrootで実行しません。
root serviceはcapabilityなし、NoNewPrivileges、ProtectSystem=strictで、書込みを
対象PWM0 controllerと `/run/questix_pwm_guard` に限定します。sudo/polkitを追加しません。

## 故障時の契約

- SO_PEERCREDによるrobot UID、所有接続1本、session、sequence、500〜2500 µsまたは0を検査。
- ARMは明示要求。ticket不要ですが、現在ownerがいる間は別接続のARMを拒否。
  terminal/faultを同sessionの指令で解除しません。再試行はownerを閉じた新接続の新ARMです。
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

新版のPi配備、DT apply、GPIO電気波形、ESC無信号/Low/neutralへの反応、起動/停止過渡、
lease・異常終了・回復の波形は未確認です。10/14の授業版releaseへ本PRを入れません。
ESC非通電でguardのLowから検証し、非常停止解除・ESC通電・非zero指令・射出は別判断です。

## 先生によるインストール（ここにあるコマンドは手順例、実施記録ではありません）

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

**installerはenable/start/stop、daemon-reload、reboot、GPIO操作、overlay applyを行いません。**
新規機体は先生がESC OFFでGPIO13 overlay `deploy/gpio13-rp1-pwm.dts` と対象Ubuntuの
DT symbol/functionを確認し、dtc/boot設定/正常再起動を別手順で実施します。他PWM/fanの影響も確認。
unitのReadWritePathsはレビューしたUbuntu24/Pi5 PWM0のdevice pathであり、違う機体は照合が必要です。

```bash
# Teacher only, after ESC OFF/DT/controller/consumer checks and measurement preparation:
sudo systemctl daemon-reload
sudo systemctl start questix_pwm_guard.service
sudo /opt/questix_pwm_guard/questix_pwm_ctl status
# Enable at boot only after successful validation (not part of installation):
sudo systemctl enable questix_pwm_guard.service
# Disable/stop are separate deliberate operations; keep ESC OFF and observe the signal:
sudo systemctl disable questix_pwm_guard.service
sudo systemctl stop questix_pwm_guard.service
```

guardが安定してLowを要求できることを確認した後、生徒workspaceのESC YAMLで
`pwm_backend: rp1_hw`、GPIO13、neutral1000、min0/max2000 µs、default socketを設定してbuildします。
生徒の変更は通常workspaceのinstallから起動します。既存E-stop/teacher permission/LAB/timeoutを維持。

### 旧凍結版c7c8b62からの移行

旧配備には `50-rp1-pwm.conf`、reviewed-launch.env、凍結runtime/承認metadataが残ります。
source更新だけではSD上の旧drop-in・launcherは消えません。**今回の再実装を旧配備にそのまま混ぜない**でください。
ESC OFFで、先生が実効unitとbackupを記録し、旧drop-inを撤去し、標準launcherをbase版へ戻し、
robotのROBOT_WS/installが新版ESCを使うことを確認します。旧凍結runtime/証跡は最初から削除しません。
installerは旧robot drop-inを検出したら配置を拒否します。guardの停止/移行は具体的な別手順でレビューします。

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
