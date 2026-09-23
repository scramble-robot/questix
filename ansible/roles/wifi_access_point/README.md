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

- 初回の `up` でパスワードを自動生成し、`/etc/questix_robot/wifi_ap.env` に保存します（読めるのは root とロボットのユーザーだけ。Robot Manager が QR コードを出すために読みます）。
  次回からは同じ SSID・パスワード・チャンネルを使います。`--ssid`、`--password`、`--new-password`、`--band`、
  `--channel`、`--country`、`--interface` で変更できます（`--help` 参照）。
- ロボットのアドレスは `10.42.0.1`、接続した端末には DHCP で `10.42.0.x` が割り当てられます。
  有線 LAN がインターネットにつながっていれば、端末の通信はそちらへ転送されます。
- `up` は QUESTiX LAB の教材配信も有効にします（`lab.env` の `AUTOSTART="true"` と、動作中の Robot Manager への
  配信開始の依頼）。つないだ端末で `http://10.42.0.1:8897/` を開けます。大会モードのときは配信を開始しません。
- **URL を打たずに開く**: Robot Manager の「教材」タブの「スマートフォンで開く」に、① Wi-Fi に接続する QR と
  ② 教材を開く QR が出ます。`sudo scripts/wifi-ap.sh card` で、同じ内容の印刷用カード（1 ファイルの HTML、
  オフラインで開ける）をホームディレクトリに書き出します。ロボットに貼っておくと、カメラで2回読むだけです。
  教材の URL はどの機体でも `http://10.42.0.1:8897/` です。
- `qrencode` が入っていれば、スマートフォンのカメラで読み取れる接続用 QR コードを表示します。

> [!WARNING]
> アクセスポイント中は、wlan0 で既存の Wi-Fi（インターネット）に接続できません。
> Wi-Fi 経由の SSH で `up` / `down` を実行すると接続が切れます。スクリプトは確認のうえ
> バックグラウンドで適用を続け、ログを `/var/log/questix-wifi-ap.log` に残します。
> `up` 後は、アクセスポイントに接続して `ssh <user>@10.42.0.1` で入り直してください。

## 複数台を同じ部屋で使う

何もしなくても、台ごとに別のアクセスポイントになります。

- **SSID**: 既定は `QUESTiX-<Wi-Fi の MAC アドレスの末尾4桁>`（例: `QUESTiX-3F2A`）です。同じイメージから
  作ってホスト名が同じキットでも重なりません。機体番号にしたい場合は `--ssid QUESTiX-01` のように指定します。
- **チャンネル**: 初回の `up` で周囲の電波を調べ、重ならないチャンネル（2.4 GHz は 1 / 6 / 11、5 GHz は
  36 / 40 / 44 / 48）のうち一番空いているものを選びます。先に起動したロボットのアクセスポイントも数に入るので、
  1台ずつ `up` すると自然に分かれます。調べられないとき（すでにアクセスポイント中など）は、MAC アドレスから
  機体ごとに決まったチャンネルを使います。
- **パスワード**: 台ごとに別のものを生成します。
- **アドレス**: どの機体も `10.42.0.1` ですが、アクセスポイントが別なので衝突しません（端末は1台にだけ接続）。

選び直すときは、いったん `down` してから `sudo scripts/wifi-ap.sh up --channel auto`（SSID は `--ssid auto`）。
`sudo scripts/wifi-ap.sh status` で、その機体の SSID・チャンネルを確認できます。

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
| `wifi_ap_ssid` | `QUESTiX-<MAC末尾4桁>` | 2〜32 文字（英数字・空白・`_` `.` `-`）。Wi-Fi がない環境ではホスト名 |
| `wifi_ap_password` | なし（必須） | 8〜63 文字の ASCII（空白・`\` を除く） |
| `wifi_ap_band` | `bg` | `bg` = 2.4 GHz、`a` = 5 GHz |
| `wifi_ap_channel` | `6` | チャンネル（スクリプトは初回に空いているものを自動で選ぶ） |
| `wifi_ap_country` | `JP` | 電波の規制区域（国コード） |
| `wifi_ap_address` | `10.42.0.1/24` | アクセスポイント側のロボットのアドレス |

## 実機での確認項目

Raspberry Pi 5 での確認が正となります。

- `sudo scripts/wifi-ap.sh up` のあと、スマートフォンから SSID が見え、接続して `10.42.0.x` が割り当てられる
- 再起動後もアクセスポイントが自動で開始する
- `sudo scripts/wifi-ap.sh down` で保存済みの Wi-Fi に戻る
