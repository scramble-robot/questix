# QUESTiX Launcher

QUESTiXシステムの各ノードを起動するためのlauncherファイル群です。XMLベースのROS 2 launchファイルを使用します。

## モード（`robot_mode`）

`questix_core.launch.xml` の構成は `robot_mode`（`lesson` / `practice` / `competition`、既定
`practice`、環境変数からは読まない）の一つで決まります（モードの定義は
`scripts/robot_manager/modes.py`）。モードで変わるのは「どのノードを起動し、どうつなぐか」と
走行許可（`/motion_permission`）に必要な票だけで、drive / shot / ESC はどのモードでも同じ設定で
`/emergency_stop`（非常停止、L1）と `/motion_permission`（走行許可、L2）と指令だけを見ます
（`design/safety_permission_input_refactor.md`）。

| | 教材（`lesson`） | 練習（`practice`） | 大会（`competition`） |
|---|---|---|---|
| gpio_reader が読む GPIO | GPIO5 | GPIO5 | GPIO5 + GPIO27（`gpio_reader.competition.yaml`） |
| RefereeMonitor（GPIO27 → 審判の票） | 起動しない | 起動しない | 起動する |
| 非常停止（`/emergency_stop`） | GPIO5 | GPIO5 | GPIO5 |
| 走行許可に必要な票 | 先生（`/actuation_authority`） | なし（常に許可） | 審判（`/motion_vote/referee`） |
| command_arbiter（走行・発射の入力の選択） | 起動する | 起動しない | 起動しない |
| `/target_twist`・`/launcher_command` を出すもの | command_arbiter（コントローラーか教材） | joy_controller・joy_launcher | joy_controller・joy_launcher |

`questix_robot_launcher.sh` は保存されたモードを `robot_mode:=<mode>` でそのまま渡し、
どのモードでも `enable_gpio_ref:=true` を固定値で渡します。`competition` は電源投入時にも起動し、
`practice` と `lesson` は Robot Manager の「起動」が置いた起動要求があるときだけ起動します。

起動のときに拒否する組み合わせ（判断は `questix_core.launch.xml` の 1 か所。子プロセスを
一つも起動せずにエラーを出して終了します）:

- `robot_mode` が `lesson` / `practice` / `competition` 以外
- `robot_mode:=competition` で `enable_gpio_ref:=false`
- `robot_mode` に置き換わった旧引数（`enable_autoreferee`、`require_teacher_permission`、
  `enable_twist_arbiter`、`enable_lab_shoot`）が渡されたとき（黙って練習として起動しないため）

## GPIO安全系（非常停止、L1）

`enable_gpio_ref:=true` は、drive/shot の有無に関係なく `gpio_reader` を1プロセス起動し、
operation_manager の `emergency_stop_manager` が GPIO5（物理非常停止、safe-low）を判定して
`/emergency_stop` を出します。非常停止の入力はどのモードでも GPIO5 だけです（安全機能だけを扱う）。
大会では gpio_reader が GPIO27 も読みますが、それは `referee_monitor` が審判の票
（`/motion_vote/referee`）にするためで、撃破は非常停止ではなく走行許可で止まります。
operation_manager（非常停止・走行許可・審判）は `questix_core` が 1 回だけ起動し、ほかの launch は
起動しません（`/joy` を間で止める joy_gate はありません）。

`launch.env` の `ENABLE_GPIO_REF` はどのモードでも読まないため、既存の `launch.env` に
`ENABLE_GPIO_REF=false` が残っていても、GPIO5 の安全系は常時有効です（issue #168）。

`/emergency_stop` の発行元は operation_manager だけで、`questix_core` は operation_manager を
`enable_gpio_ref` に関係なく常に起動します。`enable_gpio_ref:=false` は `questix_core` を手で
`ros2 launch` する明示的な診断用途だけに残る機能で（`competition` 以外。
production の `questix_robot_launcher.sh` は渡しません）、`emergency_stop_manager.no_gpio.yaml` で
GPIO を読まず、`/emergency_stop` に `active=false`、reason `released (no GPIO safety path)` を
出し続けます。drive / shot / ESC と QUESTiX LAB は構成によらず「未受信・途絶・押下なら止める」の
一つの規則だけを持ち（`require_emergency_stop: true`）、この診断構成でも（走行許可があれば）
コントローラと教材から動かせます。物理非常停止回路（RLY1）の動力遮断はこの設定に関係なく
働きますが、診断構成では押下が ROS に伝わらない（ソフトウェア停止・診断が働かない）ため、
通常運用では使いません。

GPIO5 監視はすべての起動の既定です。`questix_core.launch.xml` の `enable_gpio_ref` の既定値は
リテラルの `true` で、環境変数 `ENABLE_GPIO_REF`（export した値や、`launch.env` を `source` した
shell）は GPIO 安全系の判断に使いません。no-GPIO にするには、その診断起動の launch 引数として
`enable_gpio_ref:=false` を毎回明示します。この指定はその launch プロセスだけのもので、どこにも
保存されません。プロセスの終了後や Raspberry Pi の電源の入れ直し後、次の手動起動（引数なし）と
production 起動は GPIO 監視ありに戻ります。

```bash
# 手動診断（その都度明示。drive / shot は安全に無効化した条件で）
ros2 launch questix_launcher questix_core.launch.xml \
  robot_mode:=practice enable_gpio_ref:=false
```

## 走行許可（L2、`/motion_permission`）

走行許可は非常停止とは別の概念です。operation_manager の MotionPermissionManager が、実行中の
モードが必要とする票（`operation_manager/config/operation_manager.permission.yaml`）をまとめて
`/motion_permission` に出し、drive_component（`drive_allowed`）と shot_component /
esc_motor_control（`launcher_allowed`）が `questix_safety::PermissionMonitor` で従います
（未受信・0.5 s の途絶・false は止める。許可が戻っても新しい指令までは動かない）。

- 教材: 先生の許可（Robot Manager の操作タブ、`/actuation_authority`）がある間だけ、
  コントローラーでも教材からも動きます。
- 練習: 票は要らず常に許可です（MotionPermissionManager が落ちれば止まる、という規則は同じ）。
- 大会: AutoReferee の撃破（GPIO27 false）で止まります（非常停止ではないので、shot はサーボバスを
  解放せず（電源は入ったまま）、射撃とチルトだけを断ります）。

両方が閉じているときは非常停止（L1）の理由と反応が優先します。

GPIO5の物理非常停止回路はRLY1で左右DDT駆動モーター、ローラー用ESC、Shot用サーボ、
Tilt用サーボの動力をハードウェア遮断します。Raspberry Pi、5 V I/O、3.3 V I/Oは
通電を維持するため、GPIO5は状態をROSへ通知し続けます。GPIO5のraw値は解除時
`false`、押下時 `true` です。物理遮断とROSソフトウェア停止は独立した二重の
安全経路です。

GPIO27は大会用AutoReferee `AR_in` で、クライアント撃破出力（撃破時5 V、
非撃破時0 V）をHATのフォトカプラで反転します。撃破時は `false`/停止、
非撃破時はR2（10 kΩ）の3.3 Vプルアップにより `true`/許可です。ただし
AutoReferee未接続、クライアント無通電、一次側断線も `true` となり、現行
ハードウェアでは非撃破と区別できません。この制約は `/diagnostics` の
`pin_27_signal_limit` にも表示されます。

| Mode | GPIO5 physical E-stop | GPIO27 AutoReferee | `/emergency_stop` | `/motion_permission` |
|---|---:|---:|---|---|
| practice / lesson | false | not read | released | practice: allowed; lesson: the teacher's vote |
| any | true, missing or stale | - | active | — |
| competition | false | true | released | allowed |
| competition | false | false, missing or stale | released | not allowed (`referee:off`) |

安全系だけを非通電で起動するコマンド例:

```bash
ros2 launch questix_launcher questix_core.launch.xml \
  enable_lidar:=false enable_shot:=false enable_drive:=false \
  enable_gpio_ref:=true robot_mode:=practice enable_rviz:=false
```

## コントローラーと QUESTiX LAB の走行・発射実験（command_arbiter、L3）

`questix_core.launch.xml` は教材用の起動（`robot_mode:=lesson`）だけ入力の選択
command_arbiter（`command_arbiter/launch/command_arbiter.launch.xml`、ノード `drive_arbiter` と
`launcher_arbiter`）を入れます。joy_controller の出力は `/target_twist/joy` に付け替えられ、QUESTiX LAB の教材ブリッジは
`/target_twist/lab` に出し、`drive_arbiter` がどちらかを `/target_twist`（drive_component）へ
渡します。起動し直す必要はありません。

- ふだんはコントローラーの指令が通ります。
- 教材の指令を通すのは、先生の教材の許可（`/lab_permission`、Robot Manager の操作タブの「コントローラーと教材」）が
  届いている間だけで、教材の速さの上限（`lab_max_linear` / `lab_max_angular`）で切り詰めます。
- 教材が走り始めると、スティックが中立なら教材の指令に切り替わります。
- 教材の走行中にスティックを倒すと、すぐにコントローラーへ戻り、教材の走行は止まります
  （その走行が終わるまで教材は割り込めません）。
- 教材の指令が途切れると、コントローラーに戻ります。

発射機構（ローラー・角度・射出）も同じ規則です。コントローラーのボタンは joy_controller パッケージの
`joy_launcher` が `questix_msgs/LauncherCommand` にして出し（教材用の起動では `/launcher_command/joy`）、
教材ブリッジは `/launcher_command/lab` に出し、`launcher_arbiter` がどちらかを `/launcher_command`
（esc_motor_control・shot_component）へ渡します。教材の指令はローラー出力 80% まで、角度は
`lab_tilt_min_deg`〜`lab_tilt_max_deg`、射出はローラーが 0.2 以上で 1.0 秒回ってから・前の 1 枚から
2.0 秒あけてだけ通します。ボタンを押せばすぐにコントローラーに戻ります。esc_motor_control と
shot_component は `/joy` も教材のトピックも読みません。

練習・大会では入れず、joy_controller と joy_launcher が `/target_twist` と `/launcher_command` を
直接出します。規則は `command_arbiter/include/command_arbiter/source_selector.hpp`（発射機構は
`launcher_flow.hpp`）、パラメータは `command_arbiter/config/command_arbiter.yaml`、状態は
`/command_arbiter/status`（`questix_msgs/ArbiterStatus`）にあります。非常停止と走行許可は
command_arbiter ではなく drive_component・shot_component・esc_motor_control 自身が判断します。

## ファイル構成

### メインlaunchファイル

- `launch/questix_core.launch.xml` - 全システムを起動するメインファイル（`/emergency_stop` の発行元 operation_manager も起動する）
- `launch/drive_component.launch.xml` - 走行（joy_controller + drive_component）
- `launch/shot_component.launch.xml` - 射出（shot_component + esc_motor_control）
- `launch/lidar_driver.launch.xml` - LiDAR の座標変換（static TF。ドライバのノードは現在コメントアウト）
- `launch/test.launch.xml` - テスト・デバッグ用の最小構成

`questix_core.launch.xml` 以外は operation_manager を起動しません。
drive / shot / ESC は `/emergency_stop` と `/motion_permission` が届かない間は動かないので、単体で
動かすときは別の端末で発行元を起動してください
（手順は [`questix_msgs/README.md`](../questix_msgs/README.md) の「単体起動では発行元も起動する」）。

### 各パッケージ用launchファイル

- `joy_controller/launch/joy_controller.launch.xml` - ジョイスティックコントローラ
- `esc_motor_control_cpp/launch/esc_motor_control_cpp.launch.xml` - ESCモータコントローラ
- `ydlidar_ros2_driver/launch/ydlidar_launch.xml` - YDLiDAR
- `ydlidar_ros2_driver/launch/ydlidar_launch_view.xml` - YDLiDAR + RViz

## 実行時のsource依存

`questix_launcher` は以下のパッケージが同じcolcon workspaceにある前提でlaunchします。
これらはaptで入る依存ではなく、source/workspace依存です。

- `ydlidar_ros2_driver`
- `esc_motor_control_cpp`
- `motor_control_app`

LiDARなど実機依存のパッケージは追加取得とJazzy互換性確認が必要です。取得できても、
対象ハードウェアでの動作を保証するものではありません。

### ユーティリティスクリプト

- `launch_questix.sh` - 便利なシェルスクリプト

## 使用方法

### 1. 直接launchファイルを使用

```bash
# 全システムを起動
ros2 launch questix_launcher questix_core.launch.xml

# 走行だけを起動（別の端末で /emergency_stop の発行元も起動する。上の「メインlaunchファイル」）
ros2 launch questix_launcher drive_component.launch.xml

# テスト構成を起動
ros2 launch questix_launcher test.launch.xml
```

### 2. シェルスクリプトを使用（推奨）

```bash
# 基本的な使用方法
./launcher/launch_questix.sh <コマンド> [オプション]

# 全システムを起動
./launcher/launch_questix.sh full

# ナビゲーションシステムを起動（RViz付き）
./launcher/launch_questix.sh navigation --rviz

# サーボシステムを起動
./launcher/launch_questix.sh servo

# テスト構成を起動
./launcher/launch_questix.sh test
```

## コマンド一覧

| コマンド | 説明 |
|---------|------|
| `full` | 全システムを起動（デフォルト構成） |
| `navigation` | ナビゲーション用システム（LiDAR + モータ + Joy） |
| `servo` | サーボ制御システム |
| `test` | テスト用最小構成 |
| `ddt-motor` | DDTモータコントローラのみ |
| `lidar` | LiDARのみ |
| `joy` | ジョイスティックコントローラのみ |

## オプション

| オプション | 説明 | デフォルト |
|----------|------|-----------|
| `--sim-time` | シミュレーション時間を使用 | false |
| `--rviz` | RVizを起動 | false |
| `--no-rviz` | RVizを起動しない | - |
| `--joy-device DEV` | ジョイスティックデバイス | /dev/input/js0 |
| `--motor-type TYPE` | モータタイプ（ddt/esc） | ddt |

## 使用例

```bash
# 全システム + RViz
./launcher/launch_questix.sh full --rviz

# ESCモータでナビゲーション
./launcher/launch_questix.sh navigation --motor-type esc --rviz

# 別のジョイスティックデバイスでテスト
./launcher/launch_questix.sh test --joy-device /dev/input/js1

# シミュレーション時間でサーボシステム
./launcher/launch_questix.sh servo --sim-time
```

## XML launchファイルの利点

1. **可読性**: XMLは構造が明確で設定が直感的
2. **メンテナンス性**: 設定変更が簡単
3. **コメント**: XMLコメントでドキュメント化が容易
4. **構造化**: 階層構造で複雑な設定も整理しやすい

## トラブルシューティング

### ワークスペースがビルドされていない場合

```bash
cd <your_workspace_path>
colcon build --symlink-install
source install/setup.bash
```

### デバイスアクセス権限の問題

```bash
# シリアルポートの権限設定
sudo chmod 666 /dev/ttyACM0
sudo chmod 666 /dev/ttyUSB0

# ジョイスティックの権限設定  
sudo chmod 666 /dev/input/js0
```

### ログの確認

```bash
# ROS2ログの確認
ros2 node list
ros2 topic list
ros2 topic echo /cmd_vel

# システムログの確認
journalctl -f
```

## 注意事項

- 各ノードを起動する前に、対応するハードウェアが接続されていることを確認してください
- シリアルポートのアクセス権限が適切に設定されていることを確認してください
- 複数のモータコントローラ（DDT/ESC）を同時に起動しないよう注意してください

## 操作・速度の設定

Joy のキー割り当て、射出・ローラー操作、走行速度・加速度は
[QUESTiX 共通操作設定](../questix_control_config/README.md) に集約しています。
robot_manager の「操作・速度」タブでコントローラー別に編集・保存し、
ロボットの次回起動／再起動で反映します。保存による自動再起動は行いません。
管理画面には未保存表示・初期値への復元・入力検証・同時編集の競合検出があります。


Robot Manager の操作タブでは、1 枚のカードで走行・発射をそれぞれ
「許可しない／コントローラーのみ／コントローラーと教材」から選びます。
対応する `/actuation_authority` と `/lab_permission` の値は順に OFF/OFF、ON/OFF、ON/ON です。
教材タブは操作タブへの案内のみで、許可を変更しません。配信停止では教材の許可だけが解除され、
「コントローラーと教材」は「コントローラーのみ」になります。
モード切替、制御の起動・再起動・停止、「すべて止める」、Manager の起動・終了では両方を解除します。
許可の選択は動作可能という判定ではありません。非常停止と `/motion_permission` の判断、
既存の中立待ちはそのままで、「スティック・ボタンから手を離してください」を常に表示します。
