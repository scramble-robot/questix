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
- `questix_msgs/msg/MotorFeedback` に `velocity_rpm_raw` がある

最後の 1 つは τ・むだ時間の意味に直結する。`velocity_rpm_raw` が無い旧 msg で記録すると
LPF 後 RPM しか残らず、`fit_models.py` は（黙って切り替えずに）エラーで止まる。
それなら記録する前に止めるほうがよい、という判断。

`/target_twist` の検査は、コントローラ接続中の統合起動を想定したもの。`twist_arbiter`（練習）や
`joy_controller`（競技）は `/joy` のたびに `/target_twist` へ流すため、ステップ入力に中立の 0 や
スティック操作が混ざってデータが汚れ、スティック優先の仕組みも素通りする。`twist_arbiter` は
publisher を常に持つが入力が無ければ何も流さないので、publisher の数ではなく実際の流れで判定する。
`step_sequence.py` 自身も開始前に聞き、実行中に自分が送っていない値を受けたら中断して 0 を送り、
終了コード 3 で終わる。`record.sh` はそれを `meta.yaml` の `step_sequence: "aborted_foreign_publisher"`
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
bash scripts/identify/test_evidence.sh   # ros2 をスタブに差し替えた 64 assertion
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
  同期成分を引いた残り（**非同期**）の卓越周波数。
- **卓越周波数の判定**: 回転数を変えても周波数が一定 →「回転数によらず一定（ループ・構造）」、
  回転周波数に比例 →「回転同期」（次数も出る）。回転数が 1 水準だけ・範囲が狭いと「判別不能」。
- **1 次の同期成分の振幅と回転数**（`--json` の `order1.by_rpm`、PNG の左図）: 振幅が ~100 rpm 付近で
  山になるなら、1 回転周期の外乱がファームのループの共振で増幅されている（(c)）。回転数によらず
  ほぼ一定なら (a) の機械要因がそのまま見えている。
- **forward / turn**: 左右の和（前後）と差（旋回）。前後の振動が左右同相の揺れ（和に残る）か、
  左右で逆相（差に残る）かが分かる。
- **[判別不能]**: エンコーダの誤差による見かけの変動（既定: 平均速度の 1 % × 次数。
  `--encoder-error-pct`）を下回る成分。実際の揺れか測定の誤差か区別できない。
- `angle_speed_ratio`（JSON）: 位置から求めた回転の速さ ÷ 速度の平均。1 から外れたら、
  「0..32767 で 1 回転」の前提か巻き戻しのつなぎ直しを疑う（位置の分解能は 4096/回転 = 8 LSB 刻み）。

### 3. 手回しでディテント（コギング）の数を数える

非常停止を押してモータの電源を切った状態で、車輪をゆっくり 1 回転手で回し、引っかかり
（ディテント）の数を数える。その数が次数スペクトルに強く出る次数（`orders`）と一致すれば、
その成分はコギングトルクによる。左右とも数える。

### 4. 電源を入れ直して `position_raw` を比べる（絶対位置か）

1. 車輪にテープで印を付け、停止中に `ros2 topic echo --once /drive_control_sample` で
   `left.position_raw` / `right.position_raw` を読む。
2. 車輪を動かさずに非常停止 → 解除（モータの電源を入れ直す）。`drive_component` が再接続したら
   もう一度読む。8 LSB 程度の差なら電源をまたいで位置が保たれている。
3. 電源を切った状態で車輪を手で約半回転回し、電源を入れて読む。値が回した分（約 16384）
   変わっていれば絶対位置、電源投入時の位置が毎回同じ値（例 0）なら電源投入時を 0 とする相対位置。
   結果を `questix_msgs/README.md` の `position_raw` の説明に反映する。

### 5. 定速中の送信頻度を変える（ファームが受信フレームごとに状態を更新するか）

停止フレームを高頻度で送るとファームが減速を完了できない（`stop_resend_interval_ms` の経緯）ことから、
ファームが受信したフレームごとに内部状態（ランプや積分）を更新している可能性がある。定速走行中の
揺れが送信頻度に左右されるかを確かめる:

1. `launcher/config/drive_component.yaml` の `control_rate` を 50 / 25 にして（実行時変更不可。
   変えたら `drive_component` を再起動）、それぞれ同じレベルで記録する:
   `bash scripts/identify/record.sh --levels 60,105 --hold 20`。
2. `ripple_analysis.py` で比べる。非同期成分の周波数・振幅が送信頻度で変わるなら、ファームのループは
   フレームの受信と結びついている。変わらなければ送信頻度とは独立。
3. 終わったら `control_rate: 50.0` に戻す（`velocity_run_*` の tick 単位の値は 50 Hz 前提。
   LQR が有効だと起動時に WARN が出る）。

### 6. 床の上で取る

床上では `record.sh`（自動でステップ指令を出す）を使わず、コントローラで一定速度に保って
Robot Manager の記録（rosbag）を取る。解析は `--window T0,T1`（受信時刻 [s]）で定速の範囲を
指定する。浮かせた試験と同じ回転数で比べ、共振の山が負荷（慣性・摩擦）でどう動くかを見る。

## CSV で試す（ROS なし）

```
t,left_target,left_meas,right_target,right_meas
0.00,0,0,0,0
...
```
`python3 fit_models.py --csv sample.csv` で動く。合成データでの検算は `test_fit_models.py`。
