# robot_autostart

systemd による ROS 2 ノードの自動起動を設定するロール。

## 動作概要

- `/etc/questix_robot/mode` が `competition` の時のみ、ブート時に `ros2 launch questix_launcher questix_core.launch.xml` を `enable_gpio_ref:=true`、`enable_autoreferee:=true` 付きで自動実行
- `practice`（デフォルト）の時、ブート時や手動の `systemctl start` ではサービスは即正常終了し、ノードは起動しない。
  Robot Manager の「起動」「再起動」だけが、直前に起動要求（`/etc/questix_robot/start-request`）を書いてから
  サービスを起動し、ランチャーはそれを消費して `enable_autoreferee:=false`（練習用の構成。`enable_gpio_ref` は
  `launch.env` の `ENABLE_GPIO_REF`）で起動する。要求は同じブート・120 秒以内のものだけ有効で、消費されるため
  練習用の起動が異常終了しても `Restart=on-failure` では起動し直さない（詳細は
  `scripts/robot_manager/README.md` の「練習モードの起動要求」）
- その他の Launch 引数は `/etc/questix_robot/launch.env` で制御
- competition では GPIO5 physical E-stop と GPIO27 AutoReferee が必須のため、`launch.env` の `ENABLE_GPIO_REF` は無視して GPIO 安全系を常時有効化

## 変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `robot_mode` | `practice` | `competition` or `practice` |
| `install_robot_manager` | `false` | Web管理GUI のインストール（privateリポジトリ） |
| `robot_manager_repo` | `git+ssh://...` | robot-manager の Git URL |
| `robot_manager_version` | `main` | robot-manager のブランチ/タグ |
| `robot_manager_port` | `8888` | Web UI のポート |

## モード切替（CLI）

```bash
# 大会モードに切替
echo competition | sudo tee /etc/questix_robot/mode
sudo systemctl restart questix_robot

# 練習モードに切替
echo practice | sudo tee /etc/questix_robot/mode
sudo systemctl restart questix_robot

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
| `ENABLE_GPIO_REF` | `true` | 練習用の起動（Robot Manager の「起動」）と手動開発・診断用の GPIO 安全系設定。competition systemd 起動では値を無視して常に有効。他の項目と異なり出荷時も `true`（無効化すると手動 `ros2 launch` で GPIO 安全系がデフォルト無効になるため） |
| `ENABLE_RVIZ` | `false` | RViz 可視化の有効化 |
| `CONTROLLER_TYPE` | `dualshock` | コントローラ種別（`uart`、`dualshock`、`web`） |

出荷時に全コンポーネントを無効（`ENABLE_GPIO_REF` を除く）にしているのは、初回起動時に
モーターや LiDAR が意図せず動作しないようにするためです。運用者が必要なコンポーネントを
明示的に有効化してください。

Ansible は `launch.env` を `force: false` で配置するため、既存ファイルを上書きしません
（新規作成時のみ上記の出荷時デフォルトが適用されます）。ただし `ROS_DOMAIN_ID` だけは
再setup時にも resolver が解決した値へ同期されます（他の既存設定は保持されます）。

既存環境に `ENABLE_GPIO_REF=false` が残っていても、competition ランチャーは
`enable_gpio_ref:=true` を固定で渡すため安全系を無効化できません。
`enable_autoreferee:=true` かつ `enable_gpio_ref:=false` は通常運用上の無効な
組合せです。後者を明示的に無効化する操作は手動の開発・診断に限定してください。

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
