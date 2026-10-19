# QUESTiX：Raspberry Pi 5 向け Desktop イメージ生成ガイド

QUESTiX では生成スクリプトを公開し、利用者が公式 Ubuntu **Desktop** イメージを取得して、
自分の環境でカスタムイメージを生成します。GitHub Actions によるイメージの生成・検証・配布は行いません。
出力する `.img.xz` は、SD カードや SSD に書き込むディスクイメージです（issue #100）。

対象は Ubuntu 24.04 + ROS 2 Jazzy です。ベースのファイル名・URL・SHA-256 は
[ベースイメージの設定](pi-desktop-base.env) に固定しています。
現在は Ubuntu 24.04.5 の `preinstalled-desktop-arm64+raspi.img.xz` を使用し、
[Ubuntu 公式のチェックサム](https://cdimage.ubuntu.com/releases/24.04/release/SHA256SUMS) と照合しています。
Server イメージや汎用 ARM64 ISO には対応していません。指定したベースを取得できない場合も、別のイメージへ自動で切り替えません。
ベースを更新するときは、チェックサムに加えてパーティション構成、Desktop の初回設定、起動ファイルを確認し、実機検証をやり直してください。

## 生成に使う環境

- Ubuntu 24.04 Linux（ARM64 または AMD64）。ループデバイスとマウント名前空間を利用でき、sudo 権限が必要です。
  ビルド速度の面では ARM64 の実行環境を推奨します。Pi 5 上でも生成できます。
- 出力先に約 40 GiB の空き容量、パッケージ取得用のネットワーク接続、ROS ワークスペースのビルドに必要なメモリを用意します。
- コミット済みの QUESTiX のソースを使います。イメージに入るのは **HEAD の内容**です。
  未コミットの編集や、ホストの `build/`・`install/`・`src/`・認証情報は取り込みません。
  生成スクリプトを編集した場合は、実際の生成前にコミットしてください。使用したコミットは生成物に記録されます。
- WSL やコンテナでは、必要なカーネル機能を利用できない場合があります。
  ループデバイス・binfmt・マウント名前空間を使えない場合は Linux VM または通常の Linux 環境を使用してください。
  既存の実験用 Docker 設定は、この Pi Desktop イメージ用の生成環境ではありません。

ホストに必要なツールをインストールします。このコマンドは生成用 PC の環境を変更します。

```bash
make setup-pi-image-deps
```

**AMD64（x86_64）ホストの場合のみ**、ARM64 のプログラムを chroot 内で実行するための準備も行います。

```bash
sudo apt-get install -y qemu-user-static binfmt-support
sudo update-binfmts --enable qemu-aarch64
cat /proc/sys/fs/binfmt_misc/qemu-aarch64
```

表示が `enabled` で、`flags` に `F` が含まれることを確認してください。
生成スクリプトはこの状態を確認しますが、ホストの binfmt 登録自体は変更しません。
このエミュレーションはイメージ内の設定処理用であり、Pi の起動やハードウェア動作を検証するものではありません。

## 公式ベースイメージの取得

リポジトリのルートで、通常ユーザーとして実行してください。Ubuntu の公式配布元から取得します。

```bash
bash -e <<'DOWNLOAD'
. scripts/iso/pi-desktop-base.env
mkdir -p output/pi/base
cd output/pi/base
curl --fail --location --proto '=https' --proto-redir '=https' \
  --output "$PI_BASE_FILE.part" "$PI_BASE_URL"
printf '%s  %s\n' "$PI_BASE_SHA256" "$PI_BASE_FILE.part" | sha256sum --check -
mv "$PI_BASE_FILE.part" "$PI_BASE_FILE"
DOWNLOAD
```

生成スクリプトでも、**展開・マウントの前に** SHA-256 を照合します。
照合に失敗した場合は、取得元やファイルを確認してください。期待するハッシュ値をダウンロードしたファイルに合わせて書き換えないでください。
署名を含めて確認する場合は、[Ubuntu の検証手順（英語）](https://ubuntu.com/tutorials/how-to-verify-ubuntu) を参照してください。

## ローカルで生成する

任意で、先にスクリプトの契約テストを実行できます。
小さなテスト用ファイルだけを使うため、root 権限・ネットワーク・マウントは不要です。イメージ生成も実行しません。

```bash
make test-pi-image
```

続いて生成します。作業用イメージのマウントは root で行い、パッケージは chroot 内にインストールします。

```bash
. scripts/iso/pi-desktop-base.env
make build-kit BASE_IMAGE="$PWD/output/pi/base/$PI_BASE_FILE"
```

ユーザー名は既定で `ubuntu` です。変更する場合は `IMAGE_USER` を指定します。

```bash
make build-kit BASE_IMAGE="$PWD/output/pi/base/$PI_BASE_FILE" IMAGE_USER=robot
```

指定できる名前は、小文字の英字で始まる 1～32 文字の英小文字・数字・`_`・`-` です。
`root`・`oem` や、ベース内に存在する別のユーザー／グループの名前は使えません。
ホームディレクトリ、ワークスペース、ロボットのサービス実行ユーザー、初回パスワード登録先に同じ名前を使います。
**パスワードは生成時に指定しません。初回起動時に、利用者が本体の画面とキーボードで登録します。**
パスワードを生成コマンドやスクリプトに書く必要はありません。

スクリプトを直接実行する場合は、第 3 引数でユーザー名を指定できます（省略すると `ubuntu`）。

```bash
sudo bash scripts/build-pi-image.sh \
  "$PWD/output/pi/base/$PI_BASE_FILE" "$PWD/output/pi" robot
```

元の `.img.xz` は変更せず、新しい作業用ファイルへ展開します。物理 SD デバイスを引数に指定することはできません。
FAT の `system-boot` と ext4 の `writable` を確認し、最後の root パーティションを拡張してから、
専用のマウント名前空間で設定を行います。
既存の Ansible 処理が `/home/<ユーザー名>/questix` を指定したユーザーでビルドし、Robot Manager を設定します。
生成用ホスト上でロボットのサービスを起動することはありません。

公式イメージのファームウェア、カーネル・initramfs の設定、`root=` の識別情報を保持します。
I2C/SPI/UART は既存の `hardware_interfaces` ロールで設定し、コントローラーが UART を使えるようシリアルコンソールの指定を外します。
`config.txt`・`cmdline.txt` の全置換、オーバークロック、GPIO の一括 High 出力は行いません。

Ubuntu の OEM ユーザー作成処理は無効にし、一時ユーザー `oem` を削除します。
cloud-init も無効にして、起動時にユーザーや SSH の設定が書き換わらないようにします。
GNOME と Pi Desktop のパッケージは保持し、既定の起動先は `graphical.target` にします。
初回は QUESTiX のコンソール設定でパスワードを登録してから、Desktop のログイン画面に進みます。
初期パスワードと自動ログインはなく、SSH は登録成功後に有効になります。
言語・キーボード・タイムゾーン・ネットワークは、その後 GNOME の設定画面で変更できます。

展開後のイメージは既定で **24 GiB** です。書き込み先には **32 GB 以上**の SD カードまたは SSD を用意してください。
容量を変更する場合は、直接実行時に `QUESTIX_PI_SIZE_GIB` を指定します。
指定範囲は 16～256 GiB で、ベースイメージより大きな容量が必要です。

```bash
sudo env QUESTIX_PI_SIZE_GIB=40 bash scripts/build-pi-image.sh \
  "$PWD/output/pi/base/$PI_BASE_FILE" "$PWD/output/pi"
```

すべてのマウントとループデバイスを解放してから圧縮します。
成功すると、結果ディレクトリに次のファイルが出力されます。

| ファイル | 内容 |
| --- | --- |
| `questix-pi5-desktop-ubuntu<version>-ros2jazzy-<user>-<commit>.img.xz` | SD カード／SSD に書き込むイメージ |
| `SHA256SUMS` | イメージと付属ファイルのチェックサム |
| `build-info.txt` | ベースの URL・ハッシュ、QUESTiX のコミット、生成日時、容量、ユーザー名、ワークスペース |
| `packages.tsv` | 導入したパッケージと対応するソースパッケージのバージョン・アーキテクチャ |
| `package-copyrights.tar.gz` | 各パッケージの権利表示などのコピー |
| `base-config.txt`・`base-cmdline.txt` | 変更前の起動設定 |
| `config.txt`・`cmdline.txt` | 変更後の起動設定 |

ベースと QUESTiX のコミットは固定していますが、apt・pip のパッケージや外部リポジトリの内容は取得時期で変わる場合があります。
毎回まったく同じバイナリになるとは限らないため、比較する際は記録されたバージョンを確認してください。
既存の結果ディレクトリは上書きしません。同じコミット・ユーザー名で再生成する場合は、別の出力先を指定します。
Make の出力先は `PI_OUTPUT_DIR=/path/to/output` で変更できます。

## SD カードへの書き込みと Pi 5 での確認

1. 結果ディレクトリで `sha256sum --check SHA256SUMS` を実行します。
2. Raspberry Pi Imager の **Use custom** で生成した `.img.xz` を選び、書き込み先の SD カード／SSD を指定します。
   **選択したデバイスの内容は消去されます。** 書き込み先を確認してください。
   初回設定は QUESTiX が行うため、Imager 側のユーザー・SSH カスタマイズは適用しません。
3. Pi 5 に画面とキーボードを接続して起動し、tty1 で指定したユーザー（既定は `ubuntu`）のパスワードを 2 回入力して登録します。
   その後 Ubuntu Desktop にログインします。SSH は登録成功後に利用できます。
4. Desktop、ネットワーク、Robot Manager、`/home/<ユーザー名>/questix`、ROS 2 Jazzy を確認します。
   root ファイルシステムの容量を確認し、一度再起動してください。
5. 安全に動作確認できる状態で、GPIO5/GPIO27 の非常停止、UART のコントローラー入力、I2C/SPI 機器、モード選択、サービス起動を確認します。
   必要な操作許可や安全入力が揃う前にロボットが動かないことも確認してください。

スクリプトのテストだけでは、これらの実機動作は確認できません。
Pi 5 で上記を確認するまでは、issue #100 の実機に関する受け入れ条件は未確認です。
既存の AMD64 向け ISO 生成経路は別のもので、Pi の起動検証には使えません。
その Desktop インストーラーとしての動作も、今回の変更では検証していません。

## 生成に失敗した場合

エラーや INT/TERM を受けると、マウントした順序の逆順で解放を試みます。
遅延アンマウントや強制アンマウントは行いません。
失敗時の作業用イメージは、表示された `.questix-pi-build.*` ディレクトリに残します。

アンマウントやループデバイスの解放に失敗した場合は、対象デバイスが表示されます。
使用中のマウントとプロセスを調べてから片付けてください。**マウントされたままのディレクトリは削除しないでください。**
生成処理の終了時に専用の名前空間はなくなりますが、ファイルシステムを使用するプロセスが残っている場合は確認が必要です。
Pi イメージの復旧に、既存の `make clean` は使用しないでください。
再実行するときは途中まで設定した作業用イメージではなく、検証済みの公式ベースからやり直します。

<a id="licenses-and-distribution"></a>

## 利用・配布について

QUESTiX のコードには [リポジトリのライセンス](../../LICENSE) が適用されます。
イメージに含まれる OS や各種ソフトウェアには、それぞれの利用条件が適用されます。

このガイドは、公式ベースから自分の環境でイメージを生成する使い方を案内しています。
生成したイメージを外部へ提供する場合は、同梱ソフトウェアと配布元の条件を別途確認してください。
付属のパッケージ一覧や権利表示は、その確認に利用できます。
詳細は [Ubuntu の公式方針（英語）](https://canonical.com/legal/intellectual-property-policy) を参照してください。
