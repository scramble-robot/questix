# robot_autostart

systemd による ROS2 ノードの自動起動を設定するロール。

## 動作概要

- `/etc/questix_robot/mode` が `competition` の時のみ、ブート時に `ros2 launch questix_launcher questix_core.launch.xml` を自動実行
- `practice`（デフォルト）の時はサービスは即正常終了し、ノードは起動しない
- Launch 引数は `/etc/questix_robot/launch.env` で制御

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

設定項目:

| 環境変数 | デフォルト | 説明 |
|---------|-----------|------|
| `ENABLE_LIDAR` | `true` | YDLiDAR の有効化 |
| `ENABLE_SHOT` | `true` | 射出コンポーネントの有効化 |
| `ENABLE_DRIVE` | `true` | 駆動コンポーネントの有効化 |
| `ENABLE_GPIO_REF` | `true` | GPIO レフェリーシステムの有効化 |
| `ENABLE_RVIZ` | `false` | RViz 可視化の有効化 |

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

# polkit ルール配置（パスワードなしでサービス制御）
sudo cp systemd/50-questix-robot.pkla /etc/polkit-1/localauthority/50-local.d/
```
