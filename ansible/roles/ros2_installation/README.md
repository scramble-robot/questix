# ROS2 Ansible Role

このAnsibleロールは、Ubuntu系のLinuxディストリビューションにROS2をインストールします。[ROS2公式ドキュメント](https://docs.ros.org/en/humble/Installation/Alternatives/Ubuntu-Development-Setup.html)の手順に従い、`ros2-apt-source`パッケージを使用した最新の推奨方法を採用しています。

## 要件

- Ubuntu 20.04 (Focal), 22.04 (Jammy), 24.04 (Noble)
- Ansible 2.9以上
- sudo権限
- インターネット接続

## サポートされているROS2ディストリビューション

- Humble (デフォルト)
- Iron  
- Jazzy

## 変数

### デフォルト変数

| 変数名 | デフォルト値 | 説明 |
|--------|--------------|------|
| `ros2_distro` | `humble` | インストールするROS2のディストリビューション |
| `ros2_additional_packages` | `[]` | 追加でインストールするパッケージのリスト |
| `install_dev_tools` | `true` | 開発ツールをインストールするかどうか |

### 使用例

```yaml
# プレイブックでの使用例
- name: Install ROS2
  hosts: all
  become: true
  vars:
    ros2_distro: humble
    ros2_additional_packages:
      - ros-humble-navigation2
      - ros-humble-slam-toolbox
  roles:
    - ros2
```

## インストールされるパッケージ

### 基本パッケージ

- ros-{distro}-desktop: ROS2デスクトップフルインストール

### 開発ツール（install_dev_tools: trueの場合）

- python3-flake8-docstrings: ドキュメント文字列のLint
- python3-pip: Pythonパッケージマネージャー  
- python3-pytest-cov: テストカバレッジ
- ros-dev-tools: ROS開発ツール一式

### Ubuntu 22.04以降の追加パッケージ

- python3-flake8-*: 各種Flake8プラグイン
- python3-pytest-*: 各種Pytestプラグイン

## 実行されるタスク

1. システムロケールの設定（UTF-8サポート）
2. システムパッケージの更新
3. 必要な依存関係のインストール
4. Universeリポジトリの有効化
5. ros2-apt-sourceパッケージのダウンロードとインストール
6. ROS2開発ツールのインストール
7. ROS2 Desktopパッケージのインストール
8. rosdepの初期化と更新
9. ユーザー環境設定（.bashrc, .profile）
10. インストールの検証

## 新しいリポジトリ設定方法について

このロールは2024年6月1日以降の公式推奨方法を採用しています：

- **ros2-apt-source パッケージを使用**: GitHubの最新リリースから自動取得
- **自動的なリポジトリ設定**: パッケージがGPGキーとリポジトリ設定を自動管理
- **アップデート対応**: ros2-apt-sourceパッケージの新バージョンで自動更新

従来の手動GPGキー設定方式より安全で保守性が高い方法です。

## ライセンス

MIT

## 作者情報

このロールは、ROS2の最新のインストール要件に基づいて作成されました。
