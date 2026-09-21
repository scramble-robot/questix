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
| `handout.md` | 講義用 1 ページ手順書（受講者がログを取って提出するまで） |
| `test_fit_models.py` | 合成データでの検算 |
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
- `/drive_component` の `control_mode` パラメータが取得できる
- `questix_msgs/msg/MotorFeedback` に `velocity_rpm_raw` がある

最後の 1 つは τ・むだ時間の意味に直結する。`velocity_rpm_raw` が無い旧 msg で記録すると
LPF 後 RPM しか残らず、`fit_models.py` は（黙って切り替えずに）エラーで止まる。
それなら記録する前に止めるほうがよい、という判断。

## 記録される証跡（出力ディレクトリ契約）

```
ident_<robot>_<floor>_<YYYYmmdd_HHMM>/
├── meta.yaml                            # 試験条件 + source/環境の要約（単純値のみ）
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
- **記録 topic**：必須は `/drive_status` `/target_twist`。`/odom` `/emergency_stop` は
  存在するときだけ足す（無くても失敗しない）。`/joy` `/joy_gated` は足さない
  — `step_sequence.py` が `/target_twist` へ直接 publish する同定試験では、これらは
  同定入力の authority ではないため。
- **bag integrity**：停止後に `ros2 bag info` を保存し、必須 topic が見当たらない／
  メッセージ総数が 0 のときに warning を出す。rosbag2 の出力書式に強く依存する parser は作らない。

## 実機なしの確認

```bash
bash scripts/identify/test_evidence.sh   # ros2 をスタブに差し替えた 52 assertion
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

1. 車輪を浮かせ（ジャッキアップ）、非常停止が効くことを確認する。
2. `launcher/config/drive_component.yaml` を同定用に: `control_mode: velocity`,
   `brake_on_stop: false`, `max_linear_accel: 20.0`
   （ステップが鈍らないよう十分大きく。終わったら元に戻す）。ファーム側加速時間は
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
   - `suggested`: YAML に転記する値（`velocity_run_model_tau_sec`, `velocity_run_model_delay_ticks`,
     `drive_fsm_run_enter_rpm`）。`drive_fsm_run_exit_rpm` は enter より 5〜10 RPM 低く。
5. 結果の YAML と rosbag 名を `design/identification/` に残し、`launcher/config/drive_component.yaml`
   へ転記するときはコメントに出典（bag 名・日付）を書く。

## 手順（current モード、参考）

`control_mode: current`（既存 PI）で同じステップ列を取り、`--mode current` で同定する。
このとき入力は `/drive_status` の `current_amp`（実測トルク電流）になる。
電流を直接ステップで与える経路（PI を通さない）は未実装（計画 Phase A の残項目）。

## CSV で試す（ROS なし）

```
t,left_target,left_meas,right_target,right_meas
0.00,0,0,0,0
...
```
`python3 fit_models.py --csv sample.csv` で動く。合成データでの検算は `test_fit_models.py`。
