# 同定ツール（Phase A: design/model_based_drive_control.md）

ファーム速度ループ（velocity モード）／モータ物理（current モード）のステップ応答を取り、
`control_core` の RUN 域 LQR+FF（`velocity_run_*`）と状態機械（`drive_fsm_run_*`）の
パラメータを決めるためのスクリプト。

> **`record.sh` の位置づけ**：Phase A システム同定用の計測ハーネスであり、授業の通常手動操縦
> ロガーではない。`step_sequence.py` が `/target_twist` へ**自動でステップ指令を publish する**ため、
> 原則として車輪を浮かせ、教員／開発者の管理下で実行する。
> Classroom passive logging / live visualization is intentionally out of scope of PR #147.

| ファイル | 役割 |
|---|---|
| `record.sh` | **1 コマンド記録**：preflight → メタ情報（ロボット ID・床・電池・積載・ファーム）→ 証跡保存（source identity・実効パラメータ）→ bag 記録 + ステップ列 publish → bag integrity 保存 |
| `lib_evidence.sh` | `record.sh` 用の証跡ヘルパー（source identity、記録対象 topic の選択、パラメータ差分、bag info 検査） |
| `step_sequence.py` | `/target_twist` にステップ列を publish（車輪 RPM 指定、直進 or 旋回） |
| `fit_models.py` | rosbag2 または CSV 1 本から一次遅れ + むだ時間を最小二乗で同定し、`identified_params.yaml` を出力 |
| `batch_fit.py` | `record.sh` の出力を**まとめて同定**し、一覧表（`summary.md/csv`）・1 枚図（`summary.png`）・十分性判定（`sufficiency.md`）を出力 |
| `ripple_analysis.py` | 車輪速度の揺れを「回転に同期する成分」と「周波数が一定の成分」に分ける（振動の切り分け、下の「振動の切り分け」）。rosbag2 または CSV |
| `handout.md` | 講義用 1 ページ手順書（受講者がログを取って提出するまで） |
| `test_fit_models.py` | 合成データでの検算 |
| `test_step_sequence.py` | `step_sequence.py` の他の送り手検出・スケジュールの検算（ROS 不要） |
| `test_ripple_analysis.py` | `ripple_analysis.py` の検算（回転同期の 1 次 + 1.8 Hz 一定の合成データ。ROS 不要） |
| `test_evidence.sh` | `lib_evidence.sh` と `record.sh` preflight の実機なし検証（`ros2` をスタブに差し替え） |

## 最短の流れ（講義で「1 回ずつ取って順次回収」する運用）

```bash
bash scripts/identify/record.sh                      # 受講者: 対話でメタ情報 → 記録（約 3 分）
python3 scripts/identify/batch_fit.py ~/ident_data/ident_* --out results   # 運営: 一括同定
cat results/summary.md results/sufficiency.md       # τ / d / R² / RUN 境界と「十分か」
```

## `record.sh` の preflight（満たさないと記録しない）

同定に使えないデータを取ってしまわないよう、記録開始前に次を確認し、欠けていれば **hard fail** する。

- `/drive_component` ノードが存在する
- `/drive_status` と `/target_twist` が見えている
- `/target_twist` に他の送り手（`twist_arbiter` / `joy_controller` など）から指令が流れていない
  （`IDENT_LISTEN_SEC` 秒、既定 2 秒聞く）
- `/drive_component` の `control_mode` パラメータが取得できる
- `/drive_component` の `wheel_radius` / `wheel_separation` が取得できる（車輪 RPM → twist の換算に使う）
- `questix_msgs/msg/MotorFeedback` に `velocity_rpm_raw` がある
- 指定したレベルが `drive_component` の停止判定（`min_command_rpm`）で止められない（下の「微速」）

最後の 1 つは τ・むだ時間の意味に直結する。`velocity_rpm_raw` が無い旧 msg で記録すると
LPF 後 RPM しか残らず、`fit_models.py` は（黙って切り替えずに）エラーで止まる。
それなら記録する前に止めるほうがよい、という判断。

`/target_twist` の検査は、コントローラ接続中の統合起動を想定したもの。`twist_arbiter`（練習）や
`joy_controller`（競技）は `/joy` のたびに `/target_twist` へ流すため、ステップ入力に中立の 0 や
スティック操作が混ざってデータが汚れ、スティック優先の仕組みも素通りする。`twist_arbiter` は
publisher を常に持つが入力が無ければ何も流さないので、publisher の数ではなく実際の流れで判定する。
`step_sequence.py` 自身も開始前に聞き、実行中に自分が送っていない値を受けたら中断して 0 を送り、
終了コード 3 で終わる。また `/emergency_stop` を購読し、非常停止の押下を受けたら（または受信が 1 秒
途絶えたら）中断して 0 を送り、終了コード 4 で終わる（押下の後に解除しても、残りのステップは再開しない。
drive_component は押下中は指令を止めるが、送り続けると解除した瞬間に残りのステップで再び動くため）。
開始前に解除を受信できなければ開始しない（押下を受信していれば終了コード 4、1 件も受信できない・開始前に
途絶えたときは終了コード 6。最初の受信は購読を始めてから `--estop-wait` 秒（既定 10 s）まで待ち、開始前に
最初の受信までの時間・受信件数・publisher の数・`RMW_IMPLEMENTATION` を表示する。2026-10-06 に、
`/emergency_stop` は流れていたのに 2 秒の待ちで 1 件も受け取れずに拒否した例が 3 回あったため）。
`record.sh` はそれぞれ `meta.yaml` の
`step_sequence: "aborted_foreign_publisher"` / `"aborted_emergency_stop"` / `"refused_estop_not_received"`
として残し（完走は `"completed"`、Ctrl-C で途中終了なら `"interrupted"`）、`batch_fit.py` は
completed 以外のデータセットを除外する。ステップ列が終われば `record.sh` は自分で後片付け
（bag 停止・パラメータ再取得・bag info）まで進むので、Ctrl-C は途中で止めたいときだけ使う。

## 記録される証跡（出力ディレクトリ契約）

```
ident_<robot>_<floor>_<YYYYmmdd_HHMM>/
├── meta.yaml                            # 試験条件 + source/環境の要約（単純値のみ）+ step_sequence の完走可否
├── source_identity.txt                  # 完全 commit SHA・ブランチ・detached・dirty・ROS 環境・host
├── git_status.txt                       # dirty なら git status --porcelain（clean なら空）
├── drive_component_params_before.yaml   # 記録直前の実効パラメータ（ros2 param dump）
├── drive_component_params_after.yaml    # 記録直後の実効パラメータ
├── parameter_diff.txt                   # before/after に差分があるときだけ生成
├── bag/                                 # rosbag2
├── bag_info.txt                         # ros2 bag info の保存
└── bag_record.log                       # ros2 bag record の標準出力/エラー
```

- **source identity は完全 SHA**で残す（短縮 SHA は後から一意に辿れないことがある）。
  dirty な作業ツリーで取った bag は commit だけでは再現できないので、記録時に warning を出し、
  `git_status.txt` に変更一覧を残す。diff 本体は自動保存しない。
- **実効パラメータ**は YAML の記述ではなく、実行中ノードから `ros2 param dump` で取る。
  Phase A はパラメータ固定が前提なので、before/after に差分があれば warning を出し
  `parameter_diff.txt` を残す（証跡品質の低下であって、記録済み bag を捨てる理由ではないので
  hard fail にはしない）。
- **記録 topic**：必須は `/drive_status` `/target_twist`。`/odom` `/emergency_stop`
  `/drive_control_sample`（制御 tick ごとの診断サンプル）は存在するときだけ足す（無くても失敗しない）。`/joy` `/joy_gated` は足さない
  — `step_sequence.py` が `/target_twist` へ直接 publish する同定試験では、これらは
  同定入力の authority ではないため。
- **bag integrity**：停止後に `ros2 bag info` を保存し、必須 topic が見当たらない／
  メッセージ総数が 0 のときに warning を出す。rosbag2 の出力書式に強く依存する parser は作らない。

## 実機なしの確認

```bash
bash scripts/identify/test_evidence.sh   # ros2 をスタブに差し替えた 84 assertion
python3 scripts/identify/test_step_sequence.py
bash scripts/identify/record.sh --help
bash -n scripts/identify/record.sh scripts/identify/lib_evidence.sh
```

`test_evidence.sh` がカバーするのは source identity（完全 SHA・dirty・detached）、
記録対象 topic の組み立て、パラメータ before/after、bag info 検査、preflight の hard fail 経路、
および出力ディレクトリ契約。**実機の挙動（実際のステップ応答、`ros2 bag record` の停止処理、
非常停止）はカバーしない**ので、Pi 5 での実行が引き続き authoritative。

手動 dry-run 手順（実機で記録まではしたくないとき）:

1. 通常どおり統合起動して `drive_component` を上げる。
2. `bash scripts/identify/record.sh --help` で出力契約を確認。
3. `ros2 node list` / `ros2 topic list` / `ros2 param dump /drive_component` /
   `ros2 interface show questix_msgs/msg/MotorFeedback` を手で叩き、preflight の 4 条件が
   満たされることを確認する（満たされていれば `record.sh` は preflight を通過する）。
4. 車輪を浮かせたことを確認してから本番実行する。

## 手順（velocity モード）

1. 車輪を浮かせ（ジャッキアップ）、非常停止が効くことを確認する。コントローラは外す（または joy を
   止める）。`/target_twist` に他から流れていると `step_sequence.py` は開始しない／中断する。
2. `launcher/config/drive_component.yaml` を同定用に: `control_mode: velocity`,
   `brake_on_stop: false`。加速度上限は操作設定側にあるので、Robot Manager の「調整」タブ
   （保存先 `controls.<controller>.yaml`、`questix_control_config/README.md` 参照）で
   `max_linear_accel` を `20.0` にする。drive_component.yaml に書いても操作設定が後から
   読み込まれて上書きされる。いずれもステップが鈍らないよう十分大きく、終わったら元に戻す。
   ファーム側加速時間は
   `drive_component` 内部で 1 固定なので設定不要。`drive_fsm_run_*` と
   `velocity_run_lqr_enabled` は既定（無効）のまま。
3. 統合起動し、別端末で記録と刺激を開始:
   ```bash
   ros2 bag record /drive_status /target_twist -o ident_velocity_$(date +%Y%m%d_%H%M)
   python3 scripts/identify/step_sequence.py --levels 50,100,200,400 --hold 4.0 --sign both
   ```
   旋回側（低 RPM 域が多い）も取る場合:
   `python3 scripts/identify/step_sequence.py --levels 20,40,80,140 --hold 4.0 --turn`
4. 同定:
   ```bash
   python3 scripts/identify/fit_models.py --bag ident_velocity_XXXX --mode velocity --out design/identification/velocity_XXXX.yaml
   ```
   実測 RPM は `/drive_status` の `left/right.velocity_rpm_raw`（LPF 前の生値）を使う。
   `velocity_rpm` は `measured_lpf_tau_sec` のローパス後で τ・むだ時間を歪めるため使わない。
   `velocity_rpm_raw` を持たない旧定義の `questix_msgs` ではエラーで止まる（黙って切り替えない）。

   レポートの見方:
   - `overall`: 全区間の一次遅れ当てはめ（τ, むだ時間, R²）
   - `per_level`: |目標 RPM| ごとの R²。**R² ≥ 0.9 の最小レベルが `drive_fsm_run_enter_rpm` の目安**。
     低レベルで R² が低い（振動が一次で表せない）なら、その領域は CREEP に残す。
   - R² は**自由応答**で測る（求めたモデルを実測の初期値と指令だけで走らせ、実測と比べる）。
     `R2_1step`（1 tick 先予測の R²）は参考値。50 Hz では「次の値 ≒ 今の値」だけで 1 に近づき、
     一次遅れで表せない振動でも 0.97 以上になるため、判定には使わない。
   - レベル別の窓は「指令のランプ（加速度上限による坂）の始まり .. レベルの終わり」。一定区間だけ
     だと過渡が入らず、定常のノイズだけで R² が決まってしまう。`ramp[s]` 列がランプの長さで、
     0.5 s（または 5τ）を超えると「加速度上限が小さいまま記録した」旨の warning を出す。
   - `suggested`: YAML に転記する値（`velocity_run_model_tau_sec`, `velocity_run_model_delay_ticks`,
     `drive_fsm_run_enter_rpm`）。`drive_fsm_run_exit_rpm` は enter より 5〜10 RPM 低く。
5. 結果の YAML と rosbag 名を `design/identification/` に残し、`launcher/config/drive_component.yaml`
   へ転記するときはコメントに出典（bag 名・日付）を書く。

## 手順（current モード、参考）

`control_mode: current`（既存 PI）で同じステップ列を取り、`--mode current` で同定する。
このとき入力は `/drive_status` の `current_amp`（実測トルク電流）になる。
電流を直接ステップで与える経路（PI を通さない）は未実装（計画 Phase A の残項目）。

## 振動の切り分け（車輪を浮かせた試験）

前後方向の振動の原因を、(a) 1 回転周期の機械要因（偏心・コギング・タイヤ）、(b) ファーム速度ループの
約 1.8 Hz の振動、(c) 両者の重なり（回転周波数が ~1.8 Hz = ~108 rpm 付近で共振）に切り分ける。
解析は `ripple_analysis.py`。`/drive_control_sample`（`drive_component` の既定で出ている）が記録に
あれば、tick ごとの欠落（`seq`）と同じフレームの重複（`feedback_new`）を除いた生の速度・位置で解析する。
旧 bag は `/drive_status` の車輪ごとの受信時刻で重複を除く。

### 1. 回転数を変えて記録する

1. 車輪を浮かせ、非常停止が効くことを確認する。コントローラは外す。`control_mode: velocity`、
   `velocity_run_lqr_enabled: false`（既定）のまま。加速度上限は通常の設定でよい（各レベルの始め
   1 s は解析で捨てる）。
2. 各レベルで **10 回転以上**（= 600 / rpm 秒以上）保持する。`--hold` は全レベル共通なので、
   いちばん遅いレベルで決める（20 rpm なら 30 s）:
   ```bash
   bash scripts/identify/record.sh --levels 20,30,40,60,80,100,120,150 --hold 30
   ```
   正転・逆転の両方を回すので約 9 分（8 レベル × 2 方向 × (30 + 3) s）。共振が疑われる
   95〜110 rpm を細かく見たいときは `--levels 90,95,100,105,110,115 --hold 10` を別に取る。
3. 解析:
   ```bash
   python3 scripts/identify/ripple_analysis.py --bag ~/ident_data/ident_<ID>_<床>_<日時>/bag \
       --json ripple.json --plot ripple_png
   ```
   ROS 2 の無い PC では、先に Pi で `--bag <dir> --export-csv samples.csv` として CSV に書き出し、
   `--csv samples.csv` で解析する。QUESTiX LAB の生データ CSV（`-messages.csv`）も `--csv` で読める
   （20 Hz に間引かれ、位置が無いので回転角は速度の積分になる。目安として使う）。

### 2. 結果の読み方

- **区間ごとの行**: 平均回転数、卓越周波数とその振幅、**1 次**（1 回転に 1 回）の同期成分の振幅、
  1〜8 次の同期成分を引いた**残差**の卓越周波数、**追跡する次数**（`--track-orders`、既定 20）の振幅。
  残差には 9 次以上の同期成分が残るので、残差のピークを「回転に同期しない成分」と決めつけない。
- **追跡する次数**: 最大のピークを選ぶ代わりに、指定した次数の振幅を回転角の位相への当てはめで
  直接求める（`--json` の `tracked_orders`）。測定どうし・機体どうしで同じ成分を比べるときはこれを使う。
  20 は ID13 の浮かせた試験（2026-10-05、50 Hz）の 20〜60 rpm で最大だった次数。
- **標本化の上限と折り返し**: 50 Hz の記録で見えるのは 25 Hz まで。それより高い成分は低い周波数に
  折り返して見える（例: 150 rpm の 20 次 49.7 Hz は 0.3 Hz に見える）。追跡する次数の周波数が上限を
  超える区間は「折り返し」と表示し、その振幅は参考値（元の周波数の振幅として一意に決まらない）。
  卓越ピークが追跡する次数（またはその折り返し先）と一致するときは `[20次]` / `[20次の折り返し]` と付く。
- **卓越周波数の判定**: 回転数を変えても周波数が一定 →「回転数によらず一定（ループ・構造）」、
  回転周波数に比例 →「回転同期」（次数も出る）。点が足りないと「判別不能」で、理由（定速区間が
  2 つ未満か、判別できるピークが足りないか）を表示する。
- **1 次の同期成分の振幅と回転数**（`--json` の `order1.by_rpm`、PNG の左図）: 振幅が ~100 rpm 付近で
  山になるなら、1 回転周期の外乱がファームのループの共振で増幅されている（(c)）。回転数によらず
  ほぼ一定なら (a) の機械要因がそのまま見えている。
- **forward / turn**: 左右の和（前後）と差（旋回）。前後の振動が左右同相の揺れ（和に残る）か、
  左右で逆相（差に残る）かが分かる。
- **[判別不能]**: エンコーダの誤差による見かけの変動（既定: 平均速度の 1 % × 次数。
  `--encoder-error-pct`）を下回る成分。実際の揺れか測定の誤差か区別できない。1 % は校正していない
  仮定で、統計的な検出限界ではない（ピークが無いという意味ではない）。
- `angle_speed_ratio`（JSON）: 位置から求めた回転の速さ ÷ 速度の平均。1 から外れたら、
  「0..32767 で 1 回転」の前提か巻き戻しのつなぎ直しを疑う（ワイヤ値は 1 LSB 刻みで動く）。

### 3. 手回しでディテント（コギング）の数を数える

モータの電源を切った状態で（ID13 では非常停止の押下で切れる。下の「4.」の注意）、車輪をゆっくり 1 回転手で回し、引っかかり
（ディテント）の数を数える。その数が次数スペクトルに強く出る次数（`orders`）と一致すれば、
その成分はコギングトルクによる。左右とも数える。

### 4. 電源を入れ直して `position_raw` を比べる（絶対位置か）

**注意（電源）**: **ID13 では、非常停止の押下で DDT モータの駆動電源が切れる**（無電圧になることを作業者が
確認、2026-10-06）。RS485 の信号線（A/B/GND）は押下中も生きているが、ドライバは給電されないので応答しない。
解除のたびに DDT が起動し直し、最初の応答まで 1.3〜1.6 s かかる（この間の問い合わせは無応答になる）。
2026-10-05 に「切れない」と記録したのは誤り。他の機体は配線を確かめる。DDT は電源ケーブル（VCC/GND）と
信号ケーブル（GND/A/B、RS485）が別のコネクタで、**信号ケーブルや USB-RS485 変換器の端子を抜いても電源は
切れない**。電源の入れ直しは、非常停止（ID13）か電源ケーブル側で、作業者が行う。

非常停止を押している間、`drive_component` は DDT と送受信しない（フィードバックを取り直さず、古い値が
残る。`feedback_new` は送っていないから false。電源の有無は、このデータからは分からない）。値は非常停止を解除して
から、新しいフレーム（`feedback_new` が true、`feedback_count` が増える）だけを読む。停止中のフィードバックの更新は約 0.32 s ごと（停止フレームの再送の間引き
`stop_resend_interval_ms: 300`）。読み取りは短い bag に記録する方が確実（`ros2 topic echo` は
起動直後の取りこぼしやバッファの残りがある）。

1. 車輪と車体にテープで合わせ印を付け、読む。
2. 車輪を動かさずにモータの電源を入れ直し、読む。差が数 LSB 以内なら、電源をまたいで値が保たれている。
3. 電源を切った状態で車輪を手で回し（角度は分度器の型紙などで測る）、電源を入れて読む。
   値が回した分変わっていれば絶対位置、電源投入時に毎回同じ値（例 0）なら相対位置。

**結果（ID13、2026-10-05）**: 2. は ±1 LSB で同じ値に戻った。3. では、手で約 90° 回したのに値の
変化は左 約 17°・右 約 9° で、約 270° 回すと逆向きに同じくらい変わり、同じ印に戻すと同じ値に戻った
（「電源を入れたまま」と記録した手回しも非常停止の押下中で、実際には電源が切れていた）。一方、モータで回したときは 1 回転で 1 周し、回転数は目視と
合った。この食い違いの理由は未解明（角度との関係が大きく非線形、停止時と駆動時で値の出し方が違う、
読む前に車輪が動いた、などの候補）。分度器の型紙で 30° ずつ 1 周の値を取り、解除の前後で印が
ずれないかを動画で確かめる追加の試験で区別する。それまで `position_raw` を校正済みの絶対角として
使わない。

**結果（ID13、2026-10-06）**: 非常停止の押下中（DDT の電源断）に型紙で 30° ずつ 0→360→0° 回し（17 か所）、
押下したまま記録を始めて解除した。

- 使えた値はすべて解除の後のもの（押下中は送受信なし）。解除の後、約 0.32 s ごとの問い合わせが 4〜5 回
  続けて無応答で、最初の応答は解除の 1.28〜1.61 s 後。その間に車輪が動いたかはデータからは分からない。
- 値の変化は型紙の角度と一致しない（例: 30° で左 −7.2°、右 +26.2°）が、同じ型紙の角度では往路・戻りとも
  ほぼ同じ値に戻る。値の帯は 2 回転回しても 30〜32° の幅に収まる。
- 「値の変化 ≡ 型紙の角度（mod 36°）」で残差は左 −1.2〜+2.7°、右 −6.6〜+1.8°（仮説。電源を切った間の
  回転を、電源投入時に 1/10 回転の中の位置としてしか取り戻さない、など）。30° 刻みでは「−型紙の角度 / 5
  （mod 36°）」と区別できないので、10° 刻みの手回しで区別する。
- 結論: 電源断（ID13 では非常停止の押下）をまたいだ `position_raw` は、角度としても回転数としても
  使わない。モータで回している間の値（1 回転で 1 周）とは扱いを分ける。

### 5. 定速中の送信頻度を変える（ファームが受信フレームごとに状態を更新するか）

停止フレームを高頻度で送るとファームが減速を完了できない（`stop_resend_interval_ms` の経緯）ことから、
ファームが受信したフレームごとに内部状態（ランプや積分）を更新している可能性がある。定速走行中の
揺れが送信頻度に左右されるかを確かめる:

1. `launcher/config/drive_component.yaml` の `control_rate` を 50 / 25 にして（実行時変更不可。
   変えたら `drive_component` を再起動）、それぞれ同じレベルで記録する:
   `bash scripts/identify/record.sh --levels 60,105 --hold 20`。
2. `ripple_analysis.py` で比べる。残差の成分の周波数・振幅が送信頻度で変わるなら、ファームのループは
   フレームの受信と結びついている。変わらなければ送信頻度とは独立。
3. 終わったら `control_rate: 50.0` に戻す（`velocity_run_*` の tick 単位の値は 50 Hz 前提。
   LQR が有効だと起動時に WARN が出る）。

### 6. 床の上で取る

床上では `record.sh`（自動でステップ指令を出す）を使わず、コントローラで一定速度に保って
Robot Manager の記録（rosbag）を取る。解析は `--window T0,T1`（受信時刻 [s]）で定速の範囲を
指定する。浮かせた試験と同じ回転数で比べ、共振の山が負荷（慣性・摩擦）でどう動くかを見る。
ただし微速の信地旋回（下の 8.）は `record.sh` で取れる。

### 7. 停止指令の間引きを比べる（`stop_resend_interval_ms`）

停止中は停止フレームの再送を `stop_resend_interval_ms`（既定 300 ms）ごとに間引く。その間は
フィードバックも来ないので、停止直前の速度は約 0.32 s ごとにしか分からない（LAB の生値の段差）。
間引きは「高頻度で送るとファームが減速を終えられない（2 段階停止）」という床上の体感の比較で
決めた値で、記録されたデータは無い。浮かせた状態で比べる（0 なら毎周期送って毎周期応答が来る）:

```bash
bash scripts/identify/record.sh --levels 20,40,80,150 --hold 10              # 既定 300 ms
bash scripts/identify/record.sh --levels 20,40,80,150 --hold 10 --set-param stop_resend_interval_ms=0
```

`--set-param` は記録の間だけ値を変え（設定した直後に読み戻して確かめ、違えば記録しない）、終了時
（Ctrl-C・失敗を含む）に元の値へ戻して確かめる（`meta.yaml` に `param_override_*` と `param_restored_*`）。
戻せなかったときは手で戻すコマンドを表示し、`meta.yaml` に `param_restore_failed_*` を残して
終了コード 5 で終わる。変えてよいのは `min_command_rpm` と
`stop_resend_interval_ms` だけ。比べるのは、停止指令からの停止までの時間と回った角度（position の差。
300 ms でも正確に出る）、速度の符号の反転（行き過ぎ）、減速の曲線の折れ（0 のときだけ見える）。
無負荷で差が出なくても、床の上で出ないとは言えない。

### 8. 微速（3〜10 rpm、さらに 1〜2 rpm）と信地旋回

`drive_component` の停止判定（`motor_control_lib/drive_stop_gate.hpp`）は、車輪 RPM が
`min_command_rpm`（既定 5）未満なら停止指令にし、止まった状態から動き出すには
`min_command_rpm + 2` 以上を要る（`min_command_rpm` を 0 にしても下限 1、動き出し 3 rpm）。
`record.sh` は記録の前にこれを確かめ、回らないレベルがあれば理由を出して止まる。

```bash
# 3 / 5 / 10 rpm（記録の間だけ min_command_rpm を 0 に）
bash scripts/identify/record.sh --schedule 3:60,5:60,10:30 --set-param min_command_rpm=0
# 1 / 2 rpm も: 4 rpm で 1 s 助走してから 0 を通らずに下げる
bash scripts/identify/record.sh --schedule 1:150,2:90,5:60,10:30 --set-param min_command_rpm=0 \
    --lead-in-rpm 4 --lead-in-sec 1
# 信地旋回（床の上で負荷をかける。左の車輪を止め右だけ回す。レベルは回す輪の RPM）
bash scripts/identify/record.sh --schedule 3:60,5:60 --set-param min_command_rpm=0 --pattern pivot-left
```

- `--schedule rpm:秒,...` はレベルごとの保持時間（`--levels`/`--hold` より優先）、`--sign pos|neg|both`
  で向きを選べる（既定 both）。
- `min_command_rpm` は「低速域でファームの速度ループが収束せず振動する」ための不感帯として入った
  値（経緯は未検証）。車輪を浮かせ、非常停止に手を添えて行い、振動が大きければ止める。
- 信地旋回は機体が回る。周りに十分な空間を取り、5 rpm（車輪の周速 約 0.05 m/s）以下で行う。
  止める側の車輪には速度 0 の指令が出る（停止フレームではない）。
- 解析: `ripple_analysis.py` は既定で 10 rpm 未満・3 回転未満の区間を捨てるので、
  `--min-rpm 0.5 --min-revs 2` を付ける（1 rpm × 150 s = 2.5 回転）。微速では `velocity_rpm_raw` が
  整数（モータ側で切り捨てとみられる）でほとんど 0 か 1 になるため、回転の速さは position から求める。
  助走（1 s）は区間の最短時間（3 s）より短いので解析から外れる。

## CSV で試す（ROS なし）

```
t,left_target,left_meas,right_target,right_meas
0.00,0,0,0,0
...
```
`python3 fit_models.py --csv sample.csv` で動く。合成データでの検算は `test_fit_models.py`。
