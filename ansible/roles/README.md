# Ansible Roles Structure

このディレクトリには、Raspberry Pi 5 上での ROS2 ロボティクスキットのセットアップに使用される Ansible ロールが含まれています。

## ロール一覧

### 1. ros2_installation

ROS2 Jazzy のインストールと設定を行います。

**場所**: `ansible/roles/ros2_installation/`

**主な機能**:

- ROS2 Jazzy のインストール
- ROS2 開発ツールのインストール（オプション）
- ROS2 環境の設定

### 2. raspberry_pi_setup

Raspberry Pi 5 固有のユーティリティとユーザー設定を行います。

**場所**: `ansible/roles/raspberry_pi_setup/`

**主な機能**:

- 開発ツールのインストール（git, vim, htop, etc.）
- Python 開発環境のセットアップ
- GPIO ライブラリのインストール
- gpio グループの作成とユーザーの追加

**変数**:

- `target_user`: 設定対象のユーザー（デフォルト: `ansible_user`）

### 3. hardware_interfaces

ハードウェアインターフェース（I2C、SPI）と udev ルールの設定を行います。

**場所**: `ansible/roles/hardware_interfaces/`

**主な機能**:

- I2C インターフェースの有効化
- SPI インターフェースの有効化
- ロボティクスハードウェア用の udev ルールの設定
  - USB シリアルデバイス
  - サーボコントローラー
  - LIDAR
  - USB カメラ

**変数**:

- `boot_config_path`: ブート設定ファイルのパス（デフォルト: `/boot/firmware/config.txt`）
- `enable_i2c`: I2C を有効化（デフォルト: `true`）
- `enable_spi`: SPI を有効化（デフォルト: `true`）
- `configure_udev_rules`: udev ルールを設定（デフォルト: `true`）

**ハンドラー**:

- `reboot_required`: システム再起動が必要な場合に通知
- `reload_udev`: udev ルールをリロード

### 4. robotics_workspace

ROS2 ロボティクスワークスペースと bash 環境を設定します。

**場所**: `ansible/roles/robotics_workspace/`

**主な機能**:

- ロボティクスワークスペースディレクトリの作成
- bash エイリアスの設定（rw, rs, rb, rt, gpio_status）
- ROS2 環境変数の設定（ROS_DOMAIN_ID, ROBOT_WS）

**変数**:

- `target_user`: ワークスペースを作成するユーザー
- `workspace_path`: ワークスペースのパス（デフォルト: `/home/{{ target_user }}/robot_ws`）
- `ros_domain_id`: ROS2 ドメイン ID（デフォルト: `42`）

## 使用方法

### プレイブックでの使用

```yaml
- name: Setup ROS2 Robotics Kit
  hosts: all
  become: true
  roles:
    - role: ros2_installation
      vars:
        ros2_install_dev_tools: true
    - role: raspberry_pi_setup
    - role: hardware_interfaces
    - role: robotics_workspace
```

### 個別ロールのカスタマイズ

各ロールの変数をオーバーライドして動作をカスタマイズできます：

```yamlyaml
- role: hardware_interfaces
  vars:
    enable_i2c: true
    enable_spi: false
    configure_udev_rules: true

- role: robotics_workspace
  vars:
    workspace_path: /home/custom/my_robot_ws
    ros_domain_id: 10
```

## ディレクトリ構造

```text
ansible/roles/
├── ros2_installation/
│   ├── defaults/
│   ├── meta/
│   ├── tasks/
│   └── README.md
├── ros2_build/
│   └── tasks/
├── raspberry_pi_setup/
│   ├── defaults/
│   │   └── main.yaml
│   ├── meta/
│   │   └── main.yaml
│   ├── tasks/
│   │   └── main.yaml
│   └── README.md
├── hardware_interfaces/
│   ├── defaults/
│   │   └── main.yaml
│   ├── handlers/
│   │   └── main.yaml
│   ├── meta/
│   │   └── main.yaml
│   ├── tasks/
│   │   └── main.yaml
│   └── README.md
└── robotics_workspace/
    ├── defaults/
    │   └── main.yaml
    ├── meta/
    │   └── main.yaml
    ├── tasks/
    │   └── main.yaml
    └── README.md
```

## 依存関係

ロール間の依存関係：

1. `ros2_installation` - 他のロールの前に実行される必要があります
2. `raspberry_pi_setup` - 独立して実行可能
3. `hardware_interfaces` - 独立して実行可能
4. `robotics_workspace` - `ros2_installation` の後に実行される必要があります

## テスト

各ロールは個別にテストできます：

```bash
# 構文チェック
ansible-playbook playbooks/setup_kit.yaml --syntax-check

# チェックモード（ドライラン）
ansible-playbook playbooks/setup_kit.yaml --check -i localhost,

# 特定のロールのみ実行
ansible-playbook playbooks/setup_kit.yaml --tags raspberry_pi_setup
```

## ライセンス

MIT
