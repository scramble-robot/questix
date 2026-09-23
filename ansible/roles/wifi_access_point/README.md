# wifi_access_point

Raspberry Pi 5 の Wi-Fi を QUESTiX 用のアクセスポイント（WPA2-PSK）にします。
スマートフォンやタブレットをロボットへ直接つなぎ、robot_manager やブラウザ教材を開くための設定です。

NetworkManager の keyfile（`/etc/NetworkManager/system-connections/questix-ap.nmconnection`）として
プロファイルを書くため、NetworkManager が動いていない ISO の chroot でも適用でき、次回起動時に有効になります。
NetworkManager が動いていれば、その場で切り替えます。

## すぐに切り替える（ロボット上で）

```bash
sudo scripts/wifi-ap.sh up        # アクセスポイントを開始（起動時も自動で開始）
sudo scripts/wifi-ap.sh status    # SSID・パスワード・IP・接続台数
sudo scripts/wifi-ap.sh down      # 停止して、保存済みの Wi-Fi へ戻す
sudo scripts/wifi-ap.sh remove    # プロファイルと設定を削除
```

- 初回の `up` でパスワードを自動生成し、`/etc/questix_robot/wifi_ap.env`（root のみ読み取り可）に保存します。
  次回からは同じ SSID・パスワードを使います。`--ssid`、`--password`、`--new-password`、`--band`、
  `--channel`、`--country`、`--interface` で変更できます（`--help` 参照）。
- ロボットのアドレスは `10.42.0.1`、接続した端末には DHCP で `10.42.0.x` が割り当てられます。
  有線 LAN がインターネットにつながっていれば、端末の通信はそちらへ転送されます。
- `qrencode` が入っていれば、スマートフォンのカメラで読み取れる接続用 QR コードを表示します。

> [!WARNING]
> アクセスポイント中は、wlan0 で既存の Wi-Fi（インターネット）に接続できません。
> Wi-Fi 経由の SSH で `up` / `down` を実行すると接続が切れます。スクリプトは確認のうえ
> バックグラウンドで適用を続け、ログを `/var/log/questix-wifi-ap.log` に残します。
> `up` 後は、アクセスポイントに接続して `ssh <user>@10.42.0.1` で入り直してください。

## キットのセットアップに含める

`setup_kit.yaml` は `wifi_ap_enabled: true` のときだけこのロールを実行します（既定は `false`）。

```bash
ansible-playbook ansible/playbooks/setup_kit.yaml -i localhost, --connection=local --ask-become-pass \
  -e wifi_ap_enabled=true -e wifi_ap_password=<8〜63文字>
```

## 変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `wifi_ap_state` | `up` | `up`: 今すぐ＋起動時に開始 / `down`: 停止（プロファイルは残す）/ `absent`: 削除 |
| `wifi_ap_interface` | `wlan0` | アクセスポイントにする Wi-Fi |
| `wifi_ap_ssid` | `QUESTiX-<ホスト名>` | 2〜32 文字（英数字・空白・`_` `.` `-`） |
| `wifi_ap_password` | なし（必須） | 8〜63 文字の ASCII（空白・`\` を除く） |
| `wifi_ap_band` | `bg` | `bg` = 2.4 GHz、`a` = 5 GHz |
| `wifi_ap_channel` | `6` | チャンネル |
| `wifi_ap_country` | `JP` | 電波の規制区域（国コード） |
| `wifi_ap_address` | `10.42.0.1/24` | アクセスポイント側のロボットのアドレス |

## 実機での確認項目

Raspberry Pi 5 での確認が正となります。

- `sudo scripts/wifi-ap.sh up` のあと、スマートフォンから SSID が見え、接続して `10.42.0.x` が割り当てられる
- 再起動後もアクセスポイントが自動で開始する
- `sudo scripts/wifi-ap.sh down` で保存済みの Wi-Fi に戻る
