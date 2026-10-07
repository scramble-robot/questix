# robot_autostart

systemd による ROS 2 ノードの自動起動を設定するロール。

## 動作概要

- `/etc/questix_robot/mode` が `competition` の時のみ、ブート時に `ros2 launch questix_launcher questix_core.launch.xml` を `enable_gpio_ref:=true`、`enable_autoreferee:=true` 付きで自動実行
- `practice`（デフォルト、練習）と `lesson`（教材）の時、ブート時や手動の `systemctl start` ではサービスは即正常終了し、
  ノードは起動しない。Robot Manager の「起動」「再起動」だけが、直前に起動要求（`/etc/questix_robot/start-request`、
  保存したモードと同じ `mode=`）を書いてからサービスを起動し、ランチャーはそれを消費して `enable_gpio_ref:=true`、
  `enable_autoreferee:=false` で起動する（`launch.env` の `ENABLE_GPIO_REF` は読まない）。
  - `practice`: コントローラーだけ（`enable_twist_arbiter:=false enable_lab_shoot:=false require_teacher_permission:=false`）。
    教材（QUESTiX LAB）と先生の許可は使わない。
  - `lesson`: 教材から走行・発射でき（`enable_twist_arbiter:=true enable_lab_shoot:=true`）、コントローラーも教材も
    先生の許可がある間だけ動く（`require_teacher_permission:=true`）。
  要求は同じブート・120 秒以内のものだけ有効で、消費されるため異常終了しても `Restart=on-failure` では起動し直さない
  （詳細は `scripts/robot_manager/README.md` の「練習モードの起動要求」）
- その他の Launch 引数は `/etc/questix_robot/launch.env` で制御
- GPIO5 physical E-stop は運用上の設定ではないため、ランチャーは lesson / practice / competition とも `launch.env` の `ENABLE_GPIO_REF` を無視して GPIO 安全系を常時有効化（competition は GPIO27 AutoReferee も必須）

## 変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `robot_mode` | `practice` | `lesson`（教材）/ `practice`（練習）/ `competition`（大会）。それ以外は失敗 |
| `install_robot_manager` | `false` | Web管理GUI のインストール（privateリポジトリ） |
| `robot_manager_repo` | `git+ssh://...` | robot-manager の Git URL |
| `robot_manager_version` | `main` | robot-manager のブランチ/タグ |
| `robot_manager_port` | `8888` | Web UI のポート |

## モード切替（CLI）

```bash
# 大会モードに切替
echo competition | sudo tee /etc/questix_robot/mode
sudo systemctl restart questix_robot

# 練習モード・教材モードに切替（起動は Robot Manager の「起動」から。systemctl だけでは起動しない）
echo practice | sudo tee /etc/questix_robot/mode
echo lesson | sudo tee /etc/questix_robot/mode

# サービス状態確認
sudo systemctl status questix_robot

# ログ確認
journalctl -u questix_robot -f
```

## Launch設定の変更

`/etc/questix_robot/launch.env` を編集してサービスを再起動:

```bash
sudo nano /etc/questix_robot/launch.env
sudo systemctl restart questix_robot
```

設定項目（出荷時のデフォルトは `ansible/roles/robot_autostart/defaults/main.yaml` が
single source。`launch.env.j2` はそこから参照するのみで値を重複定義しません）:

| 環境変数 | 出荷時デフォルト | 説明 |
|---------|-----------|------|
| `ROS_DOMAIN_ID` | （kitting時に解決） | 詳細は `ansible/playbooks/vars/README.md` の「ROS_DOMAIN_ID の解決」を参照 |
| `ENABLE_LIDAR` | `false` | YDLiDAR の有効化 |
| `ENABLE_SHOT` | `false` | 射出コンポーネントの有効化 |
| `ENABLE_DRIVE` | `false` | 駆動コンポーネントの有効化 |
| `ENABLE_GPIO_REF` | `true` | 互換のために残している legacy 項目で、どこからも読まれない。systemd ランチャー（lesson / practice / competition）は `enable_gpio_ref:=true` を固定で渡し、`questix_core` の既定値もリテラルの `true`（環境変数 `ENABLE_GPIO_REF` は参照しない）。Robot Manager からは `false` にできず、保存時に `false` は `true` へ書き換えられる |
| `ENABLE_RVIZ` | `false` | RViz 可視化の有効化 |
| `CONTROLLER_TYPE` | `dualshock` | コントローラ種別（`uart`、`dualshock`、`web`） |

出荷時に全コンポーネントを無効（legacy 項目の `ENABLE_GPIO_REF` を除く）にしているのは、初回起動時に
モーターや LiDAR が意図せず動作しないようにするためです。運用者が必要なコンポーネントを
明示的に有効化してください。

Ansible は `launch.env` を `force: false` で配置するため、既存ファイルを上書きしません
（新規作成時のみ上記の出荷時デフォルトが適用されます）。ただし `ROS_DOMAIN_ID` だけは
再setup時にも resolver が解決した値へ同期されます（他の既存設定は保持されます）。

既存環境に `ENABLE_GPIO_REF=false` が残っていても、ランチャーは lesson / practice / competition とも
`enable_gpio_ref:=true` を固定で渡すため安全系を無効化できません。
`questix_core` の `enable_gpio_ref` の既定値もリテラルの `true` で、環境変数
`ENABLE_GPIO_REF`（`launch.env` を `source` した shell を含む）は GPIO 安全系の判断に使われません。
GPIO 安全系なし（no-GPIO）は、手動の診断起動でその都度 launch 引数 `enable_gpio_ref:=false` を
明示したときだけです。この指定はその launch プロセスだけのもので、どこにも保存されないため、
プロセスの終了後や電源の入れ直し後の次の起動は GPIO 監視ありに戻ります。
`enable_autoreferee:=true` かつ `enable_gpio_ref:=false` は無効な組合せで、launch が拒否します。

## 手動デプロイ

Ansible を使わずに手動でセットアップする場合:

```bash
# 設定ディレクトリ作成
sudo mkdir -p /etc/questix_robot
sudo cp systemd/mode /etc/questix_robot/mode
sudo cp systemd/questix_robot.env /etc/questix_robot/launch.env
sudo chown -R $(whoami):$(whoami) /etc/questix_robot

# ランチャースクリプト配置
sudo mkdir -p /opt/questix_robot
sudo cp systemd/questix_robot_launcher.sh /opt/questix_robot/
sudo chmod +x /opt/questix_robot/questix_robot_launcher.sh

# systemd サービス登録
sudo cp systemd/questix_robot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable questix_robot

# polkit ルール配置（questix_robot.service の start/stop/restart と、
# questix_network_admin.service の start だけをパスワードなしで許可）
sudo sed "s|ubuntu|$USER|g" systemd/50-questix-robot.rules | sudo tee /etc/polkit-1/rules.d/50-questix-robot.rules
# 旧版の .pkla・NOPASSWD:ALL が残っていれば削除（QUESTiX が書いたものだけ）
sudo python3 -I scripts/cleanup_legacy_privileges.py
```
