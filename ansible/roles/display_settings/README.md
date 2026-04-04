# display_settings

ディスプレイ関連の設定を管理するAnsibleロールです。ロボットキット（Raspberry Pi 5）向けに、自動ログインとスクリーンブランク防止を設定します。

## 機能

### 自動ログイン

- **GDM3 が存在する場合**: `/etc/gdm3/custom.conf` に `AutomaticLogin` を設定
- **GDM3 が存在しない場合**: systemd getty override (`getty@tty1`) でコンソール自動ログインを設定

### スクリーンブランク防止

dconf のシステムワイドオーバーライドで以下を無効化します:

| 設定 | パス | 値 |
|------|------|-----|
| セッションアイドル | `org/gnome/desktop/session` | `idle-delay=0` |
| スクリーンロック | `org/gnome/desktop/screensaver` | `lock-enabled=false` |
| スクリーンセーバー起動 | `org/gnome/desktop/screensaver` | `idle-activation-enabled=false` |
| 画面暗転 | `org/gnome/settings-daemon/plugins/power` | `idle-dim=false` |
| AC電源スリープ | `org/gnome/settings-daemon/plugins/power` | `sleep-inactive-ac-type='nothing'` |
| バッテリースリープ | `org/gnome/settings-daemon/plugins/power` | `sleep-inactive-battery-type='nothing'` |

## 変数

| 変数名 | デフォルト値 | 説明 |
|--------|-------------|------|
| `target_user` | `{{ ansible_user }}` | 自動ログイン対象ユーザー |
| `enable_autologin` | `true` | 自動ログインの有効/無効 |
| `disable_screen_blank` | `true` | スクリーンブランク防止の有効/無効 |

## 使い方

### Ansible (playbook経由)

```yaml
roles:
  - { role: display_settings }
```

変数のオーバーライド:

```bash
ansible-playbook setup_kit.yaml -e "enable_autologin=false"
```

### シェルスクリプト (手動実行)

Ansible を使わずに同等の設定を適用する場合:

```bash
sudo ./scripts/configure-display.sh [username]
```

引数を省略した場合は `$SUDO_USER` (または `$USER`) が使用されます。
