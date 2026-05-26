# ROS2 Ansible Playbooks

このディレクトリには、異なるアーキテクチャ向けのROS2セットアップ用Ansibleプレイブックが含まれています。

## プレイブック概要

### setup_dev.yaml (AMD64向け)

- **対象**: AMD64/x86_64アーキテクチャの開発マシン
- **用途**: ROS2開発環境のセットアップ
- **特徴**:
  - ROS2 Humble デスクトップフルインストール
  - 開発ツール一式
  - 開発用ワークスペース作成
  - 便利なエイリアス設定

### setup_kit.yaml (ARM64 Raspberry Pi 5向け)

- **対象**: ARM64 Raspberry Pi 5 (Ubuntu 24.04)
- **用途**: ロボティクスキット環境のセットアップ
- **特徴**:
  - ROS2 Humble ロボティクス向けパッケージ
  - GPIO/I2C/SPI インターフェース有効化
  - ロボティクス用Pythonライブラリ
  - ハードウェア用udevルール
  - ロボティクス向けワークスペース

## 事前準備

1. **Ansibleのインストール**

   ```bash
   sudo apt update
   sudo apt install ansible
   ```

2. **SSH設定**
   - 対象ホストにSSH公開鍵認証を設定
   - sudoパスワードなしでsudo実行可能にするか、become_passwordを設定

3. **インベントリファイルの作成**

   ```bash
   cp inventory.ini.example inventory.ini
   # inventory.iniを環境に合わせて編集
   ```

## 使用方法

### 開発環境のセットアップ (AMD64)

```bash
# 全ての開発マシンに対して実行
ansible-playbook -i inventory.ini setup_dev.yaml

# 特定のホストのみ
ansible-playbook -i inventory.ini setup_dev.yaml --limit dev-desktop

# sudoパスワードが必要な場合
ansible-playbook -i inventory.ini setup_dev.yaml --ask-become-pass
```

### ロボティクスキットのセットアップ (ARM64 Raspberry Pi 5)

```bash
# 全てのロボティクスキットに対して実行
ansible-playbook -i inventory.ini setup_kit.yaml

# 特定のキットのみ
ansible-playbook -i inventory.ini setup_kit.yaml --limit robot-kit-01

# sudoパスワードが必要な場合
ansible-playbook -i inventory.ini setup_kit.yaml --ask-become-pass
```

### 変数のカスタマイズ

プレイブック実行時に変数を上書き可能：

```bash
# Jazzy / Ubuntu 24.04 がサポート対象
ansible-playbook -i inventory.ini setup_dev.yaml -e "ros2_distro=jazzy"

# 追加パッケージを指定
ansible-playbook -i inventory.ini setup_kit.yaml -e "ros2_additional_packages=['ros-jazzy-navigation2']"
```

## セットアップ後の確認

### 開発環境 (AMD64)

```bash
# ROS2環境の確認
source ~/.bashrc
ros2 --version
ros2 topic list

# ワークスペースの確認
cw  # ~/ros2_ws に移動
ls -la
```

### ロボティクスキット (ARM64)

```bash
# システム再起動後
sudo reboot

# ROS2環境の確認
source ~/.bashrc
ros2 --version
ros2 topic list

# GPIO確認
gpio_status

# ワークスペースの確認
rw  # ~/robot_ws に移動
ls -la
```

## トラブルシューティング

### 一般的な問題

1. **SSH接続エラー**

   ```bash
   # SSH設定を確認
   ansible all -i inventory.ini -m ping
   ```

2. **権限エラー**

   ```bash
   # sudoパスワードを指定
   ansible-playbook -i inventory.ini setup_dev.yaml --ask-become-pass
   ```

3. **アーキテクチャミスマッチ**
   - プレイブックは実行前にアーキテクチャを確認します
   - エラーメッセージを確認して正しいプレイブックを使用してください

### Raspberry Pi固有の問題

1. **GPIO権限エラー**

   ```bash
   # ユーザーがgpioグループに属しているか確認
   groups $USER
   ```

2. **I2C/SPI デバイスが認識されない**

   ```bash
   # 再起動後に確認
   sudo reboot
   # I2Cデバイスの確認
   i2cdetect -y 1
   ```

## カスタマイズ

### 追加パッケージの指定

各プレイブックの`ros2_additional_packages`変数を編集するか、実行時に指定：

```yaml
ros2_additional_packages:
  - ros-jazzy-navigation2
  - ros-jazzy-slam-toolbox
  - ros-jazzy-moveit
```

### ROS2ディストリビューション

このブランチではUbuntu 24.04 + ROS 2 Jazzyのみをサポートします：

```bash
ansible-playbook -i inventory.ini setup_dev.yaml -e "ros2_distro=jazzy"
```

サポートされているディストリビューション:

- jazzy (デフォルト)
