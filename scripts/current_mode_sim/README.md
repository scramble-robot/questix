# 電流モード試験台（current_mode_sim）

QUESTiX の足回りの current モード（ホスト側 PI＋摩擦補償＋暴走ガード）を、**本物の
drive_component** と擬似モータで動かし、ブラウザでリアルタイムに見るための開発ツールです。
ロボットもモータも要りません。

停止後の中立待ちに対応し、シミュレーションのidle中は20msごとにゼロを送ります。
profile・manualの新しい操作でも、最初の0.1秒（5 tick）はゼロを先行させます。
profileの時間はこの準備後から数えるので、最初のstepを短縮しません。これはdepth 1での
配送保証ではありません。driveの再activateやfaultの復帰後も、操作をいったん止めて始め直します。
このPC専用診断経路は非常停止・motion permissionを明示的にopt-outします。
`--robot` は読取り専用で、ゼロを含め指令をpublishしません。

```
ブラウザ ──WebSocket── sim_server.py ──/target_twist・パラメータ──▶ drive_component（このワークスペースのビルド）
 http://127.0.0.1:8765/      │    ◀──/drive_control_sample──────────┘        │ serial_port
                             └── fake_ddt_motor.py（疑似端末上の M0602C ×2 と車輪の運動モデル）◀──┘
```

## 起動

```bash
colcon build --symlink-install --packages-up-to motor_control_app   # ワークスペースのルートで
source install/setup.bash
python3 scripts/current_mode_sim/sim_server.py
# → http://127.0.0.1:8765/ を開く
```

必要なもの: ROS 2 Jazzy、このワークスペースのビルド、Python の `websockets`（16 で確認）と PyYAML。

このディレクトリだけを別の場所に置いて動かすときは、QUESTiX のチェックアウトの設定を指定する:
`python3 sim_server.py --params-file ~/questix/launcher/config/drive_component.yaml`
（`source install/setup.bash` も同じチェックアウトのもの）。擬似モータは仕様書どおりのモード
切替フレームで応答するので、2026-10 より前の drive_component では current モードに切り替わらず、
起動を拒否する修正も無いため電流指令が速度目標として読まれる。古いビルドで試すときは
`--mode-frames legacy`。

主なオプション:

| オプション | 既定 | 意味 |
|---|---|---|
| `--plant` | `lifted` | 最初の負荷（`lifted` / `lifted_light` / `lifted_heavy` / `floor6` / `floor10`）。ページで切り替えられる |
| `--control-mode` | `current` | drive_component の `control_mode`（`velocity` も動くが、擬似モータの速度ループは一次遅れの近似） |
| `--mode-frames` | `spec` | 擬似モータが受け付けるモード切替フレーム。`legacy` は 2026-10 までの独自レイアウト、`never` は切り替わらないモータ（current モードが起動を拒否することの確認用） |
| `--domain-id` | 87 | シミュレーションの `ROS_DOMAIN_ID` |
| `--no-spawn` | — | drive_component を起動しない（表示された疑似端末を `serial_port` に指定して自分で起動する） |
| `--robot` | — | 実機の `/drive_control_sample` を読むだけの表示（下） |
| `--report-dead-time-ms` / `--report-tau-ms` | 0 / 0 | 擬似モータが報告する回転数を、むだ時間＋一次遅れだけ遅らせる（実機の記録に合う値は 約 40 / 100。Issue #222）。角度は遅らせない |

**安全のため**、シミュレーションは `ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST` と専用の
`ROS_DOMAIN_ID` で動き、`/target_twist` が同じネットワークのロボットに届かないようにしています。
drive_component は `require_emergency_stop:=false` と `require_motion_permission:=false`
（operation_manager のいない単体診断の明示 opt-out）で起動します。
Ctrl-C（または SIGTERM）で、ゼロ指令 → ノード停止 → 疑似端末の後片付けをして終わります。

## ページでできること

- **負荷**: 浮かせた車輪（標準・軽い・重い）／床の上（6 kg・10 kg）。「持ち上げる」で走行中に
  浮かせた状態へ、「床に置く」で戻す。「応答を止める」でモータの応答の途絶を試す。
- **走行指令**: 段階（12 s）・一定 100 rpm・低速・その場旋回・四角形・S 字・円のパターン、手動
  （前後・旋回のスライダ、または矢印キー / WASD、Space で停止）。
- **ロボットの動き**: 上から見た図に、擬似モータの車体の真の軌跡と drive_component の `/odom`
  の軌跡・推定位置を重ねて表示。前後速度・旋回角速度の指令（加速度制限の後）・真の値・オドメトリの
  グラフ、位置・向き・走行距離・オドメトリのずれ。「位置をリセット」で原点に戻す（`/odom` は
  その時点の値を原点として表示するだけで、ノードには触れない）。
- **パラメータ**: `current_kp` などを drive_component に `set_parameters_atomically` で送る
  （ノードが拒否したら理由を表示）。浮かせた車輪用・床の上用のゲイン、摩擦補償の推定値のプリセット。
- **表示**: 車輪ごとに速度（目標・モータが報告した実測・擬似モータの真の速度）と電流（指令・実測・
  ±上限）、暴走ガードの作動（理由と時刻の印）、最新値の表、ノードのログ。
- **ガードの解除**: 作動すると計測エリアの一番上に警告が出て、理由に合った「直して解除」の
  ボタンが並ぶ（発振: 床に置いて解除・浮かせた車輪用ゲインにして解除、ブレーキ電流で加速:
  符号を反転して解除、目標超過: 摩擦補償を 0 にして解除）。作動は安全のためラッチなので、
  床に置くだけでは戻らない。「そのまま解除」は今の `current_kp` を同じ値で設定し直す
  （current モードのパラメータ変更で解除される仕様を使う）、「ノードを再起動して解除」は
  lifecycle を再構成する。原因（例: 浮かせたまま床用ゲイン）を直さずに解除すると、走らせた
  瞬間にまた止まる。

## 実機の表示（読み取りのみ）

```bash
source install/setup.bash          # ロボットと同じ ROS_DOMAIN_ID・ネットワーク設定で
python3 scripts/current_mode_sim/sim_server.py --robot
```

実機の `/drive_control_sample` と drive_component のログ（`/rosout`）を表示するだけで、
`/target_twist` もパラメータも送りません（サーバ側でも拒否します）。

## 擬似モータのモデル（推定値）

- 浮かせた車輪: 1 輪ずつの運動方程式 J dω/dt = K<sub>t</sub> i − 摩擦。
- 床の上: 左右の車輪が 1 台の車体（質量 6 / 10 kg、旋回慣性は 0.4 × 0.5 m の一様な箱）を
  滑らずに押す。前後速度と角速度を積分して位置・向きを出す（右輪は鏡像に取り付け）。床に置いた
  瞬間は車輪の速度から車体の速度を決め、持ち上げた瞬間は車体が止まって車輪だけが回る。
- K<sub>t</sub> 0.44 Nm/A・無負荷回転 約 470 rpm（25.6 V）は M0602C 仕様書の値。慣性と摩擦は
  推定（車輪とロータ 約 4.7e-4 kg·m²、転がり抵抗は車輪 1 つあたり 0.15〜0.2 A 相当）で、実機では
  測っていない。車輪の滑り・キャスタ・床の凹凸は入っていない。
- 応答は指令を受け取った時点の状態（実測は 1 周期遅れ）、速度は 1 rpm 単位＋ノイズ（`--noise-rpm`）。
  既定では報告回転数に遅れは無い（実機は 約 100〜120 ms 遅い。`--report-dead-time-ms 40
  --report-tau-ms 100` で近づく）。
- 物理は約 1 kHz のスレッドで進み、フレームの間も車輪は回る（惰性も出る）。
- 指令が途絶えると最後の電流を保持する（実機の挙動は仕様書に無いので最悪の場合を想定）。
- モード切替を受けていない（速度ループの）モータは、電流指令の値を速度目標として読む。

実機の値ではないので、ゲイン・摩擦補償の最終値は実機（Raspberry Pi 5）で決めてください。
足回りの約 1.5〜1.75 Hz の振動の原因（共振・回転の次数・接触など）もこのモデルには入っていません。

このツールで見つかったこと: drive_component は `/odom` の位置を、ローパス後の車輪速度で、
制御とは別のタイマーから「手元の最新の実測 × 経過時間」で積分していたため、旋回しながら進むと
向きの遅れが位置のずれとして残っていた（S 字 3.2 m で約 0.5 m）。2026-10 から、生の実測
（`velocity_rpm_raw`）を受信時刻で台形積分し、配信時刻まで延ばして出す（同じ条件で約 0.017 m）。
ページの「オドメトリのずれ」は、その `/odom` が届いた瞬間の真の位置と比べる（`/odom` は 20 ms
ごとの配信なので、今の位置と比べるとその遅れまでずれに数えてしまう）。速度グラフの「オドメトリ」
は `/odom` の twist で、`measured_lpf_tau_sec`（0.15 s）のローパス後なので遅れて見える
（位置の積分には使っていない）。残りのずれは実測の 1 rpm 単位の量子化とノイズ。実機ではこれより、
車輪の滑り・車輪径と車輪間隔の誤差が大きく効く。
手順は `motor_control_app/README.md` の「current モード（実験的）の評価前提と安全注意」。

## 故障の注入（Python から。ページには出していない）

`fake_ddt_motor.FakeDdtBus` は、どれも既定では働かない次の設定を持つ（Issue #222 の G2）:

- `report_dead_time` / `report_tau`: 報告回転数（DATA[4..5]）のむだ時間と一次遅れ [s]。角度
  （DATA[6..7]）は遅らせない。
- `silence(motor_id, seconds, deaf=False)`: 片輪だけ、指定した時間、応答しない（指令は受け取る）。
  `deaf=True` は指令も受け取らず、最後の電流を出し続ける（通信が切れたときの最悪の場合。実機の
  ふるまいは仕様書に無い）。
- `reboot(motor_id, boot_silence=0.0)`: モータだけが再起動する（速度ループに戻り、電流 0。以後の
  電流指令は速度目標として読まれる）。`boot_silence` の間は応答も指令の受け取りもしない。
- `at(delay, action, *args)`: バスの時計で `delay` 秒後に実行する（例: `bus.at(2.0, bus.set_plant,
  'floor6')` で負荷を急に変える、`bus.at(2.0, bus.reboot, 5)`）。
- `on_frame(motor_id, mode, value, answered)`: 指令フレームごとに呼ぶ観測用のフック（モータがその
  とき受け取ったモード、`deaf` の間は None）。

## テスト

```bash
python3 -m pytest scripts/current_mode_sim   # 擬似モータと Monitor の publisher 分岐（ROS 不要）
```


`--robot` では `/target_twist` を含む publisher を作らず、
シミュレーション時だけこの2つを作る分岐を、ROSモジュールをスタブにした試験で確認する。
実際のROS通信とWebSocketの画面は、この試験では未確認。
