# Ansible Playbook Variables

このディレクトリには、Ansible playbookで使用する変数ファイルが含まれています。

## ファイル一覧

### setup_kit_vars.yaml

基本的な設定変数を含むメインの変数ファイルです。**本番環境用のデフォルト設定が含まれています。**

**含まれる変数**:

- `ros2_distro`: ROS2 のディストリビューション（デフォルト: `jazzy`）
- `target_architecture`: ターゲットアーキテクチャ（デフォルト: `arm64`）
- `install_dev_tools`: 開発ツールをインストールするかどうか（デフォルト: `true`）
- `target_ubuntu_version`: 対象 Ubuntu バージョン（デフォルト: `"24.04"`）
- `ros2_additional_packages`: インストールする追加の ROS2 パッケージのリスト
- `ros_domain_id`: ROS2 ドメイン ID（デフォルト: `42`）。詳細は下記「ROS_DOMAIN_ID の解決」を参照
- `workspace_path`: ワークスペースパス（デフォルト: `/home/{{ ansible_user }}/questix`。リポジトリのcloneをそのままcolconワークスペースとして使う）
- `enable_i2c`: I2C を有効化（デフォルト: `true`）
- `enable_spi`: SPI を有効化（デフォルト: `true`）
- `configure_udev_rules`: udev ルールを設定（デフォルト: `true`）

## ROS_DOMAIN_ID の解決

`setup_kit_vars.yaml` の `ros_domain_id: 42` は **bootstrap / legacy / pre-kitting 用の値**です。
`scripts/apply-ansible-config.sh` 経由の ARM64 ISO build（chroot 内で `setup_kit.yaml` を
非対話実行）はこの値をそのまま使うため、削除・undefined 化すると ISO build を壊します。

実機キッティングでは、`./setup.sh` が `scripts/resolve_ros_domain_id.py` を先に実行し、
ロボット固有の ID を解決してから `-e "ros_domain_id=<resolved>"` として渡します。
`setup_kit.yaml` を直接実行した場合でも、roles が始まる前に
`ansible/playbooks/tasks/validate_ros_domain_id.yaml` が範囲を検証し、
不正な値（範囲外・非整数）は fail します。

**許可される範囲**: `0-101` または `215-232`（標準的な Linux ephemeral port range を
前提とした値。範囲外の値は resolver・Ansible の両方で拒否されます）。

- `0`: 有効だが ROS 2 のデフォルトドメインと衝突しうるため warning
- `42`: 有効。ただし legacy/default 値として検出されるため、resolver は
  対話環境では「42のまま」か「ロボット固有IDに変更」かの確認を求めます
- 再setup時、42以外の有効な ID は確認なしでそのまま保持されます
  （`launch.env` と `~/.bashrc` の Ansible managed block の両方が同期されます）
- `launch.env` の ROS_DOMAIN_ID 以外の既存設定は再setupでも保持されます

resolver 自体は `launch.env` や `.bashrc` を書き換えません。永続化は Ansible
（`robot_autostart` / `robotics_workspace` ロール）の責務です。

### dev.yaml

開発/テスト環境用の設定オーバーライドファイルです。コンテナや非Raspberry Pi環境でのテストに使用します。

**オーバーライドする変数**:

- `ros_domain_id`: 99（開発用ドメイン、本番との衝突を避ける）
- `workspace_path`: `/home/{{ ansible_user }}/robot_ws_dev`
- `enable_i2c`: `false`（コンテナでのテスト用）
- `enable_spi`: `false`（コンテナでのテスト用）
- `configure_udev_rules`: `false`（コンテナでのテスト用）

## 使用方法

### 基本実行（本番環境／デフォルト設定）

```bash
ansible-playbook ansible/playbooks/setup_kit.yaml \
  -i localhost, \
  --connection=local \
  --ask-become-pass
```

この場合、`setup_kit_vars.yaml` の変数がそのまま使用されます（本番環境設定）。

### 開発環境設定で実行

開発環境やテスト環境で実行する場合：

```bash
ansible-playbook ansible/playbooks/setup_kit.yaml \
  -i localhost, \
  --connection=local \
  --ask-become-pass \
  -e @ansible/playbooks/vars/dev.yaml
```

### コマンドラインで変数をオーバーライド

特定の変数だけをオーバーライドする場合：

```bash
ansible-playbook ansible/playbooks/setup_kit.yaml \
  -i localhost, \
  --connection=local \
  --ask-become-pass \
  -e "ros_domain_id=10" \
  -e "workspace_path=/home/myuser/custom_ws"
```

### カスタム変数ファイルの作成

独自の環境用に変数ファイルを作成することもできます：

```bash
# 新しい変数ファイルを作成
cp ansible/playbooks/vars/dev.yaml ansible/playbooks/vars/my_custom.yaml

# 編集
vim ansible/playbooks/vars/my_custom.yaml

# 使用
ansible-playbook ansible/playbooks/setup_kit.yaml \
  -i localhost, \
  --connection=local \
  --ask-become-pass \
  -e @ansible/playbooks/vars/my_custom.yaml
```

## 変数の優先順位

Ansible では、変数は以下の優先順位で適用されます（下に行くほど優先度が高い）：

1. ロールのデフォルト変数（`roles/*/defaults/main.yaml`）
2. `vars_files` で読み込まれた変数（`setup_kit_vars.yaml`）
3. `-e @file.yaml` で指定された変数ファイル（`dev.yaml` など）
4. `-e "var=value"` で指定されたコマンドライン変数

## 推奨される使い方

- **本番環境（Raspberry Pi 5）**: オプションなしで実行

  ```bash
  ansible-playbook ansible/playbooks/setup_kit.yaml -i localhost, --connection=local --ask-become-pass
  ```

- **開発環境（コンテナ/テスト）**: `dev.yaml` を使用

  ```bash
  ansible-playbook ansible/playbooks/setup_kit.yaml -i localhost, --connection=local --ask-become-pass -e @ansible/playbooks/vars/dev.yaml
  ```

## 機密情報の管理（Ansible Vault）

機密情報を含む変数ファイルを暗号化する場合：

```bash
# 暗号化
ansible-vault encrypt ansible/playbooks/vars/dev.yaml

# 暗号化されたファイルを使用して実行
ansible-playbook ansible/playbooks/setup_kit.yaml \
  -i localhost, \
  --connection=local \
  --ask-become-pass \
  --ask-vault-pass \
  -e @ansible/playbooks/vars/dev.yaml

# 復号化
ansible-vault decrypt ansible/playbooks/vars/dev.yaml
```

## Ansible Vault の使用（オプション）

機密情報を含む変数ファイルを暗号化する場合：

```bash
# 暗号化
ansible-vault encrypt ansible/playbooks/vars/production.yaml

# 暗号化されたファイルを使用して実行
ansible-playbook ansible/playbooks/setup_kit.yaml \
  -i localhost, \
  --connection=local \
  --ask-become-pass \
  --ask-vault-pass \
  -e @ansible/playbooks/vars/production.yaml

# 復号化
ansible-vault decrypt ansible/playbooks/vars/production.yaml
```
