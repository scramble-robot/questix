# QUESTiX Android コントローラー

既存の `web_joy_driver` 操作ページを開く Kotlin WebView アプリです。
Android 8.0（API 26）以上に対応します。

## 接続

1. ロボットの管理画面でコントローラーを **Web** に設定・保存し、サービスを起動または再起動します。
2. スマホをロボットと同じ Wi-Fi に接続します。
3. アプリに `http://<robot-ip>:8899/` を入力するか、管理画面の「スマホで操作」で生成した QR をアプリの「QR を読み取る」で読み取ります。
4. 接続先を確認し、「接続する」を押します。前回接続した URL は端末内に保存します。

QR の内容は通常の HTTP(S) URL です。アプリ内スキャナーはデコーダーを同梱しているので、
実行時のインターネット接続や Google Play 開発者サービスは不要です。
初回の読み取りでカメラを許可してください。拒否・キャンセル時も URL の手入力は使えます。
標準カメラで QR を読む場合は、通常のブラウザで開かれます。

管理画面をロボット上の `localhost:8888` で開いている場合、QR の URL 欄には
**スマホから到達できるロボットの IP アドレス**を入力します。
`web_joy_driver` の `port` や `auth_token` を変更した場合は、その値を URL に反映します。
例: `http://192.168.1.100:8899/?token=<URL-encoded-token>`。
QR にトークンも含まれます。保存 URL はアプリ専用領域に保持し、アプリのバックアップは無効です。

## 操作中の表示と復帰

- 操作ページは全画面で表示します。画面端からのスワイプで Android のシステムバーを一時表示できます。
- 表示中は Android の `FLAG_KEEP_SCREEN_ON` で自動消灯を防ぎます。HTTP のページでも有効です。
- Android の「戻る」で操作ページを閉じ、接続設定へ戻ります。
- ホームへの移動・アプリ切り替え・画面ロックなどで Activity が一時停止すると WebView を破棄します。
  復帰時は接続設定に戻り、ユーザーが再接続するまで入力送信を再開しません。
- 通信途絶時のニュートラル配信は `web_joy_driver` の watchdog が担当します。
  実機では `message_timeout_sec` を正の値に設定してください（既定 0.5 秒）。

WebView にネイティブ機能への JavaScript ブリッジは公開しません。
メインページの遷移は選択した接続先と同じ origin に限定します。
ロボット LAN 用に HTTP/ws を許可しますが、HTTPS の証明書エラーは回避しません。
ロボット側 USB カメラの映像配信は、このアプリには含まれていません。

## ビルド

Android Studio でこの `android/` ディレクトリを開きます。
JDK 17 以上、Android SDK Platform 35、Build Tools 35.0.0 が必要です。
AGP 8.9.2、Kotlin 2.1.20、Gradle 8.11.1 を固定しています。
初回ビルド時には依存ライブラリのダウンロードが必要です。

コマンドラインでは SDK の場所を `local.properties` の `sdk.dir` または `ANDROID_HOME` で指定します。

```bash
cd android
sh gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Windows では `gradlew.bat` を使用してください。
デバッグ APK は `app/build/outputs/apk/debug/app-debug.apk` に出力されます。
`COLCON_IGNORE` があるため、ROS のビルド対象には入りません。

## Android 実機での確認

- URL 手入力・保存・QR 読み取り・カメラ拒否・不正な QR の扱い。
- 縦横の全画面表示、一定時間無操作でも消灯しないこと、戻る操作。
- 操作中のホーム移動・ロック・Wi-Fi 断でロボット側入力がニュートラルになること。
- 復帰時は再接続操作が必要で、以前のボタン・スティック入力が再送されないこと。
- Android の画面回転、カットアウト、ジェスチャーナビゲーションで操作部が隠れないこと。

## 参照

- [Android: Keep the screen on](https://developer.android.com/develop/background-work/background-tasks/awake/screen-on)
- [Android: Immersive mode](https://developer.android.com/develop/ui/views/layout/immersive)
- [AGP 8.9 の互換性](https://developer.android.com/build/releases/agp-8-9-0-release-notes)
- [ZXing Android Embedded](https://github.com/journeyapps/zxing-android-embedded)（4.3.0、Apache-2.0）
- [Gradle Wrapper](https://docs.gradle.org/8.11.1/userguide/gradle_wrapper.html)（Apache-2.0）
