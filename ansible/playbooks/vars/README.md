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
- `ros_domain_id`: ROS2 ドメイン ID（デフォルト: `42`）
- `workspace_path`: ワークスペースパス（デフォルト: `/home/{{ ansible_user }}/robot_ws`）
- `enable_i2c`: I2C を有効化（デフォルト: `true`）
- `enable_spi`: SPI を有効化（デフォルト: `true`）
- `configure_udev_rules`: udev ルールを設定（デフォルト: `true`）

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
