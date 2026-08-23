# 同定ツール（Phase A: design/model_based_drive_control.md）

ファーム速度ループ（velocity モード）／モータ物理（current モード）のステップ応答を取り、
`control_core` の RUN 域 LQR+FF（`velocity_run_*`）と状態機械（`drive_fsm_run_*`）の
パラメータを決めるためのスクリプト。

| ファイル | 役割 |
|---|---|
| `record.sh` | **1 コマンド記録**：メタ情報（ロボット ID・床・電池・積載・ファーム）を聞いて `meta.yaml` に保存し、bag 記録 + ステップ列 publish を実行 |
| `step_sequence.py` | `/target_twist` にステップ列を publish（車輪 RPM 指定、直進 or 旋回） |
| `fit_models.py` | rosbag2 または CSV 1 本から一次遅れ + むだ時間を最小二乗で同定し、`identified_params.yaml` を出力 |
| `batch_fit.py` | `record.sh` の出力を**まとめて同定**し、一覧表（`summary.md/csv`）・1 枚図（`summary.png`）・十分性判定（`sufficiency.md`）を出力 |
| `handout.md` | 講義用 1 ページ手順書（受講者がログを取って提出するまで） |
| `test_fit_models.py` | 合成データでの検算 |

## 最短の流れ（講義で「1 回ずつ取って順次回収」する運用）

```bash
bash scripts/identify/record.sh                      # 受講者: 対話でメタ情報 → 記録（約 3 分）
python3 scripts/identify/batch_fit.py ~/ident_data/ident_* --out results   # 運営: 一括同定
cat results/summary.md results/sufficiency.md       # τ / d / R² / RUN 境界と「十分か」
```

## 手順（velocity モード）

1. 車輪を浮かせ（ジャッキアップ）、非常停止が効くことを確認する。
2. `launcher/config/drive_component.yaml` を同定用に: `control_mode: velocity`,
   `accel_time_0p1ms_per_rpm: 1`, `brake_on_stop: false`, `max_linear_accel: 20.0`
   （ステップが鈍らないよう十分大きく。終わったら元に戻す）。`drive_fsm_run_*` と
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
