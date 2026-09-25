# web_joy_driver

PC・iPhone・iPad・Android のブラウザから QUESTiX を操作するための仮想コントローラーです
（Robot Manager の「ブラウザ・スマホで操作」。パッケージ名は `web_joy_driver` のままです）。
Android アプリのインストールは不要です。
Pi 上で HTTP + WebSocket サーバを立て、ブラウザのバーチャルスティック／ボタン入力を
`sensor_msgs/Joy` として `/joy` に配信します。

- 配列は `uart_joy_driver` と同じ **Switch2 ネイティブ配列** です。キー割り当て・速度・スティックの不感帯は
  Web 専用の操作設定 `questix_control_config/config/controls.web.yaml` で**固定**です
  （管理画面の「調整」では編集できず、`QUESTIX_CONFIG_DIR` の同名ファイルも使いません）。
  画面には十字キーがないため、射出角度は TILT ▲ / ▼ ボタン（buttons[4] / buttons[6]）で操作します。
- 教材（QUESTiX LAB）と同じく **操作できるのは 1 台だけ**、ほかの端末は断られて閲覧のみ、
  **「止める」はどの端末からでも押せます**（[操作権](#操作権)）。
- 下流（`joy_gate` → `joy_controller` / `shot_component` / `esc_motor_control`）は無変更。
  GPIO 非常停止によるゲートもそのまま効きます。
- 無通信 `message_timeout_sec`（既定 0.5 s）でニュートラルを配信する watchdog 付き。
- 教材が走行実験でロボットを動かしている間は「教材が走らせています」と表示し、「止める」は教材の走行と
  ローラーも止めます（[教材との関係](#教材との関係)）。
- `camera_topic`（`sensor_msgs/CompressedImage`）を設定すると、その映像を同じ WebSocket で中継し、
  操作画面の中央に表示します。既定は空（カメラなし）です。

## 使い方

```bash
# 単体起動
ros2 launch web_joy_driver web_joy_driver.launch.xml

# 統合起動（joy ソースを web に切り替え）
ros2 launch questix_launcher questix_core.launch.xml controller_type:=web
```

`launch.env` では `CONTROLLER_TYPE=web`（`robot_manager` の「コントローラー」から選択可）。

操作する端末を Pi と同じネットワークに載せ、`http://<robot-ip>:8899/` を開きます。
`auth_token` を設定した場合は `http://<robot-ip>:8899/?token=<value>`。
管理画面の「ブラウザ・スマホで操作」から「ブラウザで操作」を押しても開けます。
スマホのカメラで管理画面の QR を読み取って開くこともできます。
画面左上にロボット名（`robot_name`、空ならホスト名）が出るので、操作したいロボットか確かめてください。
どのロボットもアクセスポイントのアドレスが同じ（例: `10.42.0.1`）なので、違う Wi-Fi につながっていると
別のロボットの画面が開きます。

### PC のキーボード操作

画面上部の切り替えで **キーボード** を選び（`?mode=keyboard` を付けて開くと最初からキーボード）、
**Space を先に押して保持**しながら操作キーを押します。押しているキーは画面中央のキーマップで光ります。
キーはキーボード上の位置（英字配列の表示）で判定します。
マウスやトラックパッドのない端末（スマホ・タッチだけのタブレット。CSS の `any-pointer: fine` が偽）では
キーボードの切り替えを表示せず、`?mode=keyboard` も無視します。

| キー | 操作 |
| --- | --- |
| W / A / S / D または矢印 | 前後・左右移動（斜め入力は長さ 1 に正規化） |
| Q / E | 左 / 右旋回 |
| I / K | TILT ▲ / ▼ |
| F | FIRE |
| R | ROLLER（保持） |
| Space を離す / Esc | この端末の全入力をニュートラルに戻す |

キーボード入力の大きさは最大 1、速度の倍率は操作設定 `controls.web.yaml` に従います。
タッチ・マウス操作との同時入力はできません。操作方法の切り替え時にも全入力を解除します。
Space の押し直しだけでは以前の操作は再開しません。操作キーも離して押し直してください。

### iPhone・iPad / タッチ・マウス操作

「タッチ・マウス」を選び、スティックをドラッグ、各ボタンは押している間だけ入力します。
タッチでは複数の指で移動・旋回・ボタンを同時操作できます。縦・横向きにレイアウトが切り替わります。
全画面ボタンはブラウザが対応する場合に表示します。消灯防止が使えない場合は端末側で画面の消灯時間を調整してください。
ヘッダーの「?」で操作ガイドを開けます（`#help` を付けた URL でも開きます）。

## 画面

| 領域 | 出力 |
| --- | --- |
| 「移動」左スティック（土台付き、前後左右の目安を表示） | axes[0]=LX, axes[1]=LY（左/上 = +1） |
| 「移動」右スティック（土台付き、↶ ↷ の目安を表示） | axes[3]=RX（旋回）, axes[4]=RY |
| 「ショット」TILT ▲（FIRE の上） / TILT ▼（FIRE の下） | buttons[4]=L / buttons[6]=ZL |
| 「ショット」FIRE（中央の大きな丸ボタン） | buttons[5]=R |
| 「ショット」ROLLER（FIRE の左、押している間） | buttons[7]=ZR |

- 操作は「移動」と「ショット」の 2 つのカードにまとめています。画面全体を操作領域にせず、カードは内容に合わせた
  大きさなので、レイアウトの大半をスティックが占有しません。
  - 「移動」: 左に前後・左右のスティック、右に旋回のスティックを並べています。
  - 「ショット」: ゲームパッド風のクラスタ。親指が置きやすい位置に大きな FIRE、その上下に砲の向きと同じ方向の
    TILT ▲ / ▼、左に ROLLER です。
  - 横向きでは「移動」が左、「ショット」が右。縦向きでは「移動」が下段（親指の位置）、「ショット」がその上の右寄せです。
- 「カメラ」: `camera_topic` を設定し、映像が 1 枚でも届いてから、2 つのカードの間（横向きは中央の列、
  縦向きは最上段）にロボットのカメラ映像を表示します。それまでは 2 カードだけのレイアウトで、
  「カメラ待機中」の空の枠は出しません。余った領域いっぱいにアスペクト比を保って表示し、途絶えると
  「映像が止まっています」を重ねます。ラベルの右に受信フレームレートを表示します。
  キーボード操作ではキーマップをカメラの下に置き、映像を隠しません。
- スティックは各領域の定位置に土台を常時表示します。土台の中に触れるとその場を中心に固定スティックとして動き、
  土台の外に触れるとその位置にスティックが移動します（浮動）。指を離すと土台の位置に戻ります。
- ヘッダー: ロボット名、「非常停止」「接続」（操作中／閲覧のみ／切断／認証エラー）の状態チップ、
  再接続（認証エラー時のみ）、操作ガイド「?」、全画面「⛶」。
- ヘッダーの下: キーボード／タッチの切り替え（キーボードのある端末だけ）、操作のヒント、
  「操作をやめる」（操作中の端末だけ）、「止める」（全端末）。
- 帯（バナー）: 非常停止中 ＞ 直前の出来事（止めた・止められた・譲ってほしい・断られた） ＞
  「教材が走らせています」 ＞ 切断の順に 1 つだけ表示します。
- 接続前・切断中・認証エラー・閲覧のみの間は、操作カードの上に状態と対処を示すオーバーレイを重ね、
  入力を受け付けないことを明示します。閲覧のみのオーバーレイは薄く、カメラ映像とメーターが見えます。
- フッター: ロボットへ送っている「前後・左右・旋回」のメーター（閲覧のみの端末では操作中の端末の入力）。
  幅に余裕がある場合（幅 520 px 超かつ高さ 480 px 超）はノードの状態（送信中／タイムアウト、遅延 ms、接続数）と
  生の `axes` / `buttons` も表示します。スマホではメーターだけです。
- ヘッダーのボタン、「止める」「操作をやめる」、切り替え、オーバーレイ・帯のボタンはどれも 44 × 44 px 以上です。

機能の割り当て（どの入力で射出・角度調整・ローラーを動かすか）は `controls.web.yaml` で固定です（管理画面では変更しません）。
画面の入力と番号の対応そのものは `static/index.html` 冒頭の `LAYOUT` にあり、変更した場合は `controls.web.yaml` も合わせてください。

## 操作権

教材（QUESTiX LAB の走行実験）と同じ考え方です: **1 台だけが操作し、ほかの端末は断り、誰でも止められる**。

| 場面 | 動き |
| --- | --- |
| 最初に開いた端末 | 操作する端末（操作者）になります。チップは「操作中」。 |
| ほかの端末が開く | 断られ、閲覧のみ。「ほかの端末（iPhone・10.42.0.23）が操作中です」と、操作者の端末の種類（User-Agent から）・IP アドレス・操作している時間、この端末自身の種類と IP を表示します。スティック・ボタンの入力はロボットに届きません。 |
| 「操作したいと伝える」 | 操作者の画面に「〇〇 が操作したいと言っています」と「譲る」「あとで」を出します（同じ端末からは 5 秒に 1 回まで）。「譲る」でその端末が操作者になります（60 秒以内の依頼だけ）。 |
| 「操作をやめる」 | 操作者がやめます。全端末に「いまは誰も操作していません」と「操作する」が出て、先に押した端末が操作者になります。自動で誰かに移ることはありません。 |
| 「止める」 | どの端末からでも押せます。下の[止める](#止める)。 |
| 操作者がページを閉じる・別のアプリに切り替える（ページが非表示） | 全入力を離し、操作者をやめます。ページに戻ったとき、まだ誰も操作していなければ自動で操作者に戻ります。 |
| 操作者の接続が切れる（Wi-Fi 断など） | ロボットは `message_timeout_sec`（0.5 s）でニュートラル。ノードが切断に気づいた時点（ページが閉じれば即時、応答がなければ keepalive の `ping_interval_sec` + `ping_timeout_sec` ≈ 3 s 後）で操作者でなくなり、ほかの端末が「操作する」を押せます。 |
| 同じページが再接続する | ブラウザのタブごとの識別子（`cid`、`sessionStorage`）で自分の古い接続を置き換え、操作者に戻ります（古い接続がまだ残っていても断られません）。そのあいだにほかの端末が操作者になっていれば閲覧のみです。 |
| 閲覧のみの端末が再接続する | 閲覧のみのまま（操作者の席が空いていても勝手に取りません）。 |

`auth_token` は操作権とは別の、LAN 上の端末を絞るための共有の合言葉です。

### 止める

「止める」はどの端末（操作者でも閲覧のみでも）からでも押せ、次の 2 つを行います。

1. ノードへ `{"type":"stop"}`: ブラウザからの入力をすぐニュートラルにします（切断時と同じ）。
   さらに、操作者のページが全入力を離した（全軸・全ボタン 0 のフレームを送った）あとでないと、
   操作者のフレームを採用しません。止めた直後に届いた「押しっぱなし」のフレームで動き出すことはありません。
   操作者の画面には「〇〇 で「止める」が押されました」と出て、指を離して触れ直すと再び操作できます。
2. 教材の中継 `questix_lab_bridge`（同じホストの `lab_bridge_port`、既定 8897）へ `{"type":"stop"}` と
   `{"type":"roller_stop"}`: どのページの走行実験・ローラーでも止めます（教材の止めるバーと同じ要求。
   中継側で `allow_drive` / `allow_shoot` が偽なら無視されます）。
   中継が動いていないときは「教材の中継は動いていません」と控えめに知らせ、教材が走らせている最中に
   届かなかったときだけ「教材の走行を止められませんでした」と非常停止ボタンの使用を促します。

「止める」はこのページと教材からの指令を止めるもので、GPIO 非常停止の代わりではありません。
Esc（キーボード）はこの端末の入力を離すだけで、ほかの端末や教材には送りません。

## 教材との関係

- 練習用の起動（`questix_core.launch.xml`、`enable_autoreferee` なし）では `twist_arbiter` が
  コントローラー（この画面を含む）と教材の走行実験のどちらを `/target_twist` に通すかを選びます。
  スティックを動かせば、今までどおりすぐにコントローラーの操作に切り替わります（`twist_arbiter` の動き）。
- このノードは `arbiter_status_topic`（`/twist_arbiter/status`、`std_msgs/String` の JSON、latched）を
  **購読するだけ**で、`active` が `lab` の間、全端末に「教材が走らせています」を表示します。
  `twist_arbiter` がいない（競技用の起動）ときは何も出しません。
- 教材の走行を止める ROS の手段は `/target_twist/lab` などへの publish しかなく、それは
  `questix_lab_bridge` が「ほかの publisher」として拒否する（安全のための仕様）ため、
  ページがブラウザから中継の WebSocket に止める要求を送ります。このノードは publisher を増やしません。

## プロトコル

- `GET /` : 操作ページ（単一 HTML、ビルド不要）
- `GET /ws?token=<t>&cid=<page id>&claim=1|0&touch=1` (WebSocket) : JSON テキスト。
  `token` が違う・ない場合は接続を受け付けてからすぐ close code **4401** で閉じます（HTTP 401 で断ると
  ブラウザには 1006 にしか見えず、ページが「認証エラー」を出せないため）。
  `cid` はタブごとの識別子（英数字・`-`・`_`、64 文字まで）、`claim=0` は操作者の席が空いていても取らない、
  `touch=1` はタッチ画面（Mac を名乗る iPad を「iPad」と表示するため）。

ブラウザ → ノード:

| フレーム | 意味 |
| --- | --- |
| `{"type":"joy","axes":[lx,ly,0,rx,ry,0,dh,dv],"buttons":[0,1,...]}` | 操作者のみ採用。短い配列は 0 で補完、長すぎる配列・非数値・NaN は破棄（警告ログ）。ページは入力変化時に即送信し、操作者の間は 100 ms ごとに再送します。 |
| `{"type":"stop"}` | 誰でも。上の[止める](#止める)。 |
| `{"type":"claim"}` | 席が空いていれば操作者になる。ふさがっていれば `refused`。 |
| `{"type":"release"}` / `{"type":"release","to":<id>}` | 操作者のみ。やめる / 依頼してきた端末に譲る。 |
| `{"type":"request"}` | 閲覧のみの端末から操作者へ「操作したい」（5 秒に 1 回まで）。 |

ノード → ブラウザ:

| フレーム | 意味 |
| --- | --- |
| `{"type":"welcome","controller":bool,"you":{id,label,address},"owner":{...}\|null,"robot":{"name"},"lab_bridge_port":8897}` | 接続直後に 1 回。 |
| `{"type":"status","controller":bool,"owner":{id,label,address,since_sec}\|null,"stopped":bool,"clients":n,"hold":"active\|timeout\|released","rx_age_ms","timeout_ms","frames","axes":[...],"estop","estop_reason","estop_age_ms","arbiter":{active,reason,lab_locked}\|null,"camera","camera_age_ms","camera_frames"}` | `status_period_sec` ごと、および操作者が変わったとき。`axes` はいまロボットへ送っている値、`stopped` は止めたあと操作者が離すのを待っている間 true。`estop` は `/emergency_stop`（`questix_msgs/EmergencyStop`）の表示用リレーで、ゲートには使いません。`camera` は `disabled \| waiting \| live \| stale`。 |
| `{"type":"stopped","by":{id,label,address},"by_operator":bool}` | 誰かが「止める」を押した（全端末へ）。 |
| `{"type":"refused","reason":"busy","owner":{...}}` | `claim` が断られた。 |
| `{"type":"handover_request","from":{...}}` | 操作者へ: 閲覧のみの端末が操作したい。 |
| `{"type":"request_sent","owner":{...},"repeat"?:true}` | 依頼した端末へ: 伝えた（`repeat` は 5 秒以内の再依頼）。 |
| `{"type":"released","reason":"replaced"}` + close 4000 | 同じページの新しい接続に置き換えられた古い接続へ。 |
| バイナリ | カメラ画像 1 枚（JPEG または PNG のバイト列）を 1 メッセージとして、接続中の全端末へ。`camera_max_fps` で間引き、読み終えていない端末には次のフレームを送らず最新のフレームだけを送ります（キューを持ちません）。ブラウザ側も、デコード中に届いたフレームは最新の 1 枚だけを保持します。 |

### 安全動作

| 事象 | ノード側 | ブラウザ側 |
| --- | --- | --- |
| フレーム途絶（Wi-Fi 断・バックグラウンド） | `message_timeout_sec` 後にニュートラル配信、警告ログ | 自動再接続（0.5〜5 s バックオフ） |
| WebSocket 切断 | 操作者なら即ニュートラル、keepalive で検出後に操作者の席を空ける | 全入力を解除して再接続。以前の入力を復元しない |
| ページが非表示 / pagehide | 操作者の席を空ける（ページが `release` を送る） | 全入力を離してニュートラルを送信。戻ったとき席が空いていれば取り直す |
| blur | ― | 全入力を離してニュートラルを送信 |
| 「止める」（どの端末でも） | 即ニュートラル、操作者が全入力を離すまでそのフレームを無視 | 全入力を解除。教材の中継にも止めるを送る |
| 操作者が変わる（譲る・やめる・切断） | 即ニュートラル（前の操作者の指令を次に持ち越さない） | 操作者でなくなった端末は全入力を解除 |
| token 違い | close 4401 | 「認証エラー」。自動再接続しない（「再接続」ボタン） |

接続前・切断中・閲覧のみ・非表示・フォーカスがない間の操作は受け付けません。
非表示中の再接続は保留し、ページへ戻ったときに再開します。

## パラメータ

`config/web_joy_driver_params.yaml` が Single Source of Truth です（`deadzone` だけは操作設定
`controls.web.yaml` の `web_joy_driver` セクション）。主なもの:

| 名前 | 既定 | 説明 |
| --- | --- | --- |
| `joy_topic` | `/joy` | 出力トピック |
| `host` / `port` | `0.0.0.0` / `8899` | bind アドレス / ポート |
| `auth_token` | `""` | 空で認証なし。LAN 共有時は設定推奨。違う token は close 4401 |
| `publish_rate` | `50.0` | Joy 再送周期 (Hz) |
| `message_timeout_sec` | `0.5` | 無通信でニュートラルに戻すまでの秒数 |
| `deadzone` | `0.05` | 軸のデッドゾーン。`questix_control_config/config/controls.web.yaml` で設定 |
| `num_axes` / `num_buttons` | `8` / `14` | 配列長（Switch2 配列） |
| `ping_interval_sec` / `ping_timeout_sec` | `1.0` / `2.0` | WebSocket keepalive。応答のない操作者はこの合計（≈ 3 s）で席を失う |
| `close_timeout_sec` | `1.0` | 切断ハンドシェイクの上限。読まなくなった端末を引きずらないため |
| `status_period_sec` | `0.2` | `status` の送信周期 |
| `static_dir` | `""` | `index.html` の場所（空 = share ディレクトリ） |
| `emergency_stop_topic` | `/emergency_stop` | 表示用 E-stop 購読。`""` で無効 |
| `robot_name` | `""` | ヘッダーとタブ名に出すロボット名。空 = ホスト名（`questix_lab_bridge` の `robot_name` と同じ） |
| `arbiter_status_topic` | `/twist_arbiter/status` | 「教材が走らせています」の表示用に購読（読むだけ）。`""` で無効 |
| `lab_bridge_port` | `8897` | 「止める」で教材の中継（同じホスト）に止めるを送るポート。`questix_lab_bridge` の `port` と同じにする。`0` で送らない |
| `camera_topic` | `""`（なし） | 画面中央に表示する `sensor_msgs/CompressedImage`（JPEG/PNG）。例 `/camera/image_raw/compressed` |
| `camera_max_fps` | `15.0` | ブラウザへ送るフレームレートの上限。0 以下で間引きなし |
| `camera_timeout_sec` | `2.0` | 映像が途絶えたと表示するまでの秒数。0 以下で無効 |

### カメラ映像の入力

既定では購読しません（このリポジトリにカメラのドライバーは含まれず、`questix_lab_bridge` の `camera_topic` も既定は空です）。
使うときは `camera_topic` にトピックを指定します。ノードはカメラを直接扱わず、`sensor_msgs/CompressedImage` を購読して中継するだけです。
JPEG または PNG のバイト列だけを送り、`compressedDepth` などそれ以外は警告ログを出して捨てます。
QoS は sensor data（best effort）なので、reliable / best effort どちらの配信元にもつながります。

Raspberry Pi 5 でトピックを作る例（`camera_topic:=/camera/image_raw/compressed` とする場合）:

```bash
# USB カメラ (ros-jazzy-usb-cam)。image_transport の compressed プラグインが <topic>/compressed を出します。
ros2 run usb_cam usb_cam_node_exe --ros-args -r __ns:=/camera -p video_device:=/dev/video0 -p image_width:=640 -p image_height:=480
# Raspberry Pi カメラモジュール (ros-jazzy-camera-ros, libcamera)
ros2 run camera_ros camera_node --ros-args -r __ns:=/camera -p width:=640 -p height:=480
```

帯域の目安: 640x480 JPEG は 1 枚 30〜60 KB。`camera_max_fps: 15` で 0.5〜1 MB/s 程度です。
スマホの Wi-Fi が不安定なときは `camera_max_fps` を下げるか、配信元の解像度を落としてください。
カメラ映像はあくまで補助表示で、操作系（`/joy` の配信、タイムアウト、非常停止）には影響しません。

## 依存

- `python3-websockets`（Ubuntu 24.04 の 10.x と、13 以降の `websockets.asyncio` API の両方に対応）
- `rclpy`, `sensor_msgs`, `std_msgs`, `questix_msgs`

## テスト

```bash
colcon test --packages-select web_joy_driver
# または
cd web_joy_driver && python3 -m pytest test
# リポジトリルートからブラウザ入力・操作権・止める・再接続のテスト（Node.js）
node --test web_joy_driver/test/test_browser_controller.cjs
```

`test_ws_server.py` はインストールされている `websockets` に対する結合テストです（操作権・断り・誰でも止める・
譲る・再接続・4401 を含む）。

AMD64 の開発機で、ヘッドレス Chrome の 2 つのブラウザコンテキスト（操作者と断られる端末）と
`twist_arbiter` で確認済みです。Raspberry Pi 5 の実機（スマホ 2 台、Wi-Fi 断、実際のモーター、
教材の走行実験中の「止める」）での確認は未了で、そちらが正です。

## 接続用 QR

管理画面の「ブラウザ・スマホで操作」で `http://<robot-ip>:8899/` を指定し、接続用 QR を生成してください。
スマホのカメラで読み取ると、ブラウザで操作ページが開きます。
