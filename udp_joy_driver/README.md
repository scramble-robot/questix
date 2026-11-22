# QUESTiX UDP コントローラー（段階1、Issue #269）

Sender → UDP v3 → `udp_joy_driver` → `/joy` と `/motion_vote/controller`。
UART は引き続き利用できる。Sender の変更、ネットワークの設定、受信状況の管理カード、
`ControllerLinkStatus`、DDS 探索範囲、DOWN/HALT は今回の範囲に含まない。

## 起動と設定

`controller_type:=udp` を選ぶ。`questix_core.launch.xml` は必要票を起動前に合成し、
lesson は teacher だけ、practice は controller、competition は referee+controller を要求する。
`controller_votes: {udp: {practice: [controller], competition: [controller]}}` のように
モード別に指定し、書いていないモードには票を追加しない。
他の種類は従来どおり。合成に失敗したらプロセスを起動せず失敗する。
`MotionPermissionManager` の既存 INFO ログに実際の必要票一覧が出る。
生成ファイルは `tempfile.TemporaryDirectory(prefix='questix-permission-')` の専用ディレクトリ
（所有者のみアクセス可）に排他的作成し、launch 終了時とプロセス正常終了時に削除する。
SIGKILL では残る場合があるが、次の起動は別のディレクトリを作り、残骸を再利用しない。

段階1では管理者が `/etc/questix_robot/control_link.env` を用意する。
root 所有、ロボットのユーザーは読み取りだけにする。以下はひな形であり、自動配置されない。
ネットワーク自体の固定 IPv4 設定は作業者が別途行う。
段階1では Robot Manager で「大会用（有線 LAN）」を選べるが、`control_link.env` を作る仕組みは段階2。
選択しただけでは準備は完了せず、ファイルが無ければランチャーが制御の起動を拒む。

```ini
ENABLED=true
INTERFACE=eth0
ROBOT_ADDRESS=192.168.3.100/24
PEER_ADDRESS=192.168.3.50
PORT=5000
```

ランチャーはこのファイルをシェルとして実行しない。未知・重複・欠落キー、空値、
不正な IPv4/CIDR、同じホスト、別サブネット、ネットワーク/ブロードキャスト、
不正ポート、ENABLED が true 以外なら ROS 起動前に拒否する。
`INTERFACE` は形式検査のみで、インターフェースの設定やリンク操作はしない。

単体起動では YAML に具体的なアドレスを設定するか、launch の
`udp_local_address` / `udp_peer_address` / `udp_port` を指定する。
統合起動の同名引数はランチャーが渡す。空の引数は YAML を上書きしない。

| パラメーター | 配布値 | 説明 |
|---|---|---|
| local_address / peer_address | 空 | 具体的な IPv4 が必須。0.0.0.0 は拒否 |
| port | 5000 | 5000〜5009 |
| publish_rate | 50.0 | 入力が無い間の Joy と票の再発行 Hz |
| message_timeout_sec | 0.5 | 有効な新しいパケットが無い時間。ちょうどの時点で無効 |
| input_stale_sec | 1.0 | HID のみ。XInput では使わない（起動ログにも表示） |
| deadzone | 0.1 | `controls.udp.yaml` だけに既定を置く。Manager は #266 の 5〜99% 検査・注意・履歴を使用 |
| arm_button / stop_button | 10 / 8 | Joy 番号。0〜13、互いに異なる値 |
| allow_rearm_after_stop | false | 単体の既定。core が competition=false、lesson/practice=true を選ぶ |

S4 改修前の Sender は静止中に status を 500 ms ごとに送るため、机上試験では
`message_timeout_sec: 1.2` を別 YAML で設定する。配布の 0.5 は S4 の 100 ms 周期が前提。

## パケットと読み替え

UTF-8 JSON、768 byte 以下。v=3、16キーをすべて要求し、未知・欠落・重複・不正型を拒否する。
`v,type,seq,ms,connected,protocol,vid,pid,addr,ep,raw,reports,dropped,user_valid,user_age_ms,user_raw`。
input の raw は連続 HEX で 1〜64 byte、status は空、ep=0。
protocol は none/hid/xinput。VID/PID は4桁HEX、カウンターは uint32（bool 不可）。
user_raw は32 byte、無効時はゼロと user_age_ms=UINT32_MAX を要求し、制御には使わない。
XInput は標準20 byte と束の互換形式、HID は assumed PS4 をデコードする。
未対応・短いレポートでは古い値を使わない。XInput の軸はリトルエンディアン。

送り元 IP が peer_address と一致したものだけ処理する。status を連番も含め受け付けたときだけ、
その送り元 IP/port へ `GPACK001` + seq + ms（各ビッグエンディアン uint32、合計16 byte）を返す。
ロボットから送る UDP は ACK だけ。毎秒100パケット超で1エピソード1回WARNを出し、
毎秒100以下の窓または無通信の窓に戻った後は、次の超過を再び警告する。
受信スレッドが例外で止まった場合はノードを維持し、中立Joyと不許可の票を発行し続ける。
`failed`を5秒ごとにERRORログへ出し、制御の再起動が必要な状態であることを示す。
専用スレッドが select で待機し、到着済みデータを順番に読み切る。
20 ms の select タイムアウトは終了確認用で、受信待ちの周期ではない。
状態と ROS 発行は1つのロックで保護し、別の50 Hzタイマーで再発行・期限判定する。

| Joy | 対応（物理位置） |
|---|---|
| buttons 0,1,2,3 | 右・下・上・左（XInput B,A,Y,X / PS4 ○,×,△,□） |
| 4,5,6,7 | L,R,ZL,ZR |
| 8,9,10,11 | BACK,START,HOME(GUIDE),Capture(PS4 TOUCH、XInputなし) |
| 12,13 | 左右スティック押し込み |
| axes 0,1 / 3,4 | 左右スティック、左正・上正 |
| axes 6,7 | 十字キー、左正・上正 |
| axes 2,5 | 常に0（トリガー強度を出さない） |

束のボタンビットと Joy 番号は異なるため joy_map の対応表で変換する。
UART と同じ byte 軸量子化・符号・不感帯を使用する。
BACK/HOME は入力のボタンとして保持するが、OFF/STOPPED/中立待ちの出力は全体を中立にする。
配布プロファイルは [8]/[10] をアクチュエーター操作に割り当てない。

## ON/OFF と中立待ち

| 状態 | 入り方 | Joy / 票 |
|---|---|---|
| OFF | 起動直後 | 中立 / 不許可 |
| ON | 健全な新規 input で HOME の立ち上がり | 全操作解放後に入力 / 通信健全なら許可 |
| STOPPED | ON 中に BACK を1入力 | 中立 / 不許可を保持 |

起動直後と通信無効化後は HOME を押されているとみなし、健全な新規inputで
HOMEが離れているのを一度見てから、次の押下を立ち上がりとして受け付ける。
押したままのHOMEでは起動時もSTOPPEDからの通信復帰時もONにならない。

**教材モードでは、BACKと通信途絶で止まるのはコントローラーの入力だけ（`/joy`が中立）で、
ロボット全体の停止ではない。QUESTiX LABからの走行は先生の許可と既存の安全条件に従って動く。**
教材モードのMotionPermissionManagerはコントローラーの票を要求しない。

BACK は HOME 同時押しより優先。大会では STOPPED はノード再起動まで戻らない。
練習・教材は HOME で再 ON できる。古い/重複 seq は期限を更新しない。
uint32 の周回を扱い、2秒途絶で連番追跡と接続情報を破棄するが STOPPED は保持する。

通信途絶、抜去、接続情報変更、未知レポート、HID input 期限切れで中立・不許可。
復帰後は HOME を要求せず、ON のまま全軸中立・全ボタン解放の新規 input を待つ。
status は HOME/BACK の操作や中立待ち解除には使わない。
web は deadzone 適用前の厳密0、UDP は deadzone 適用後の0で中立を判定する点が異なる。

input は完全な状態なので reports が飛んでもその入力を使う。
status.reports が最後の input.reports より uint32 の前進比較で新しければ、最初の通知から100 msの猶予を開始する。
その間は最後の入力を保持し、後続statusでは猶予を延ばさない。新規inputが届けば解消する。
100 ms以上届かなければ不明・中立・不許可にし、復帰後は中立待ちを通す。
通信途絶・HID期限は猶予中も独立して有効。間引いた125 Hzの入力列も試験する。

## 検証と実機の受け入れ

x64 は localhost と分離した ROS_DOMAIN_ID で試験する。実機には接続しない。

```bash
source /opt/ros/jazzy/setup.bash
colcon build --symlink-install
source install/setup.bash
ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST ROS_DOMAIN_ID=230 colcon test --packages-select udp_joy_driver questix_control_config
# 送信器を別プロセスにして受信ノードだけの CPU を測る（loopback のみ）
python3 udp_joy_driver/test/benchmark_node.py
```

benchmark は受信 recvfrom 直後から ROS publish 完了までを測り、中央値・99パーセンタイルと
無入力/約100 packet/s の受信プロセス CPU（1コア=100%）を出す。DDS配送完了時間や
Sender → カーネル → recvfrom の待ち時間は含まない。x64 の数値は目安で、Pi 5 は作業者が測る。

作業者の机上試験（このエージェントは行わない）：

1. **大会で使う機種が HOME(GUIDE) を送ることを最初に確認する。送らなければ ON にできない。**
2. Sender と Pi を直結し、設定した IP とポートで全ボタン・軸・十字キーを照合する。
3. OFF → HOME解放を観測 → HOME押下 → 全解放 → 操作を確認する。起動時のHOME保持、STOPPEDでHOMEを押したままの通信復帰、スティック保持では再開しないことを確認する。
4. ケーブル抜去、Sender電源断・再起動、ゲームパッド抜去で中立・不許可になること、保持した操作で再始動・射出しないことを確認する。
5. BACK 単押し・HOME同時押しで停止し、大会は再起動まで、練習/教材はHOMEと全解放まで戻らないことを確認する。
6. Sender S1〜S4 の変更前後で ACK、静止・連続入力、毎秒100以下、受信→Joy p99 2 ms以下を測る。
7. 浮上状態の機体で走行・発射、Pi 5の負荷と遅延を確認する。LAN の不要通信の抑止と会場の中継条件は後続段階の受け入れ事項。

今のSender（#269のS4改修前）では、最新のinputが届かなかった後、操作を変えて新規inputが
届くまで中立のままになる。復帰後も全操作を離した新規中立inputが必要。
IP選別は認証ではない。BACKの誤操作でもコントローラー入力は直ちに中立になり、
練習・大会はコントローラーの票でも止まる。教材ではLABを含む全体停止にはならない。
大会は制御の再起動まで戻らない。
物理E-stop、DOWN/HALT とエネルギー遮断の検証を代替しない。

## 出典

packet/report/link_state は指定された CoRE 配布束から移植・適応した。
`Ported from the CoRE gamepad UDP bundle (sender uart32-tx-20261114 / receiver uart32-rx-20261114), provided by Scramble and used with the author's permission.`
束にはライセンスの明記を確認できなかったが、作業責任者から作者の許可による利用の指示を受けた。
ZIPや元ソース一式はリポジトリに含めない。同梱 VALIDATION の過去の試験結果を今回の実行結果とは扱わない。
