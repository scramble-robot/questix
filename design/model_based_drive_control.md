# 走行制御のモデルベース化 実装計画（velocity: 状態機械 + 参照整形 / current: LQR+FF → MPC）

対象: `drive_component` → `ControlCore` → `DifferentialDrive` → `DdtMotorLib` の走行制御経路（DDT M0602C ×2、差動二輪）
前提: `design/drive_control_refactor.md` の Phase 0〜3（デフォルト単一ソース化・固定周期 tick・シリアル単一利用者化・`ControlCore` 抽出 + 閉ループシミュレーションテスト）が実装済みであること
状態: 実装計画 + 実装状況。各 Phase は独立した PR にできる粒度で切ってある
実装状況（2026-08-23 時点、未コミットの作業ツリー）:
- Phase A: 収集・同定ツールを実装（`scripts/identify/step_sequence.py`, `fit_models.py`, `README.md`, 合成データ検算 `test_fit_models.py`）。**実機データは未取得**。電流を直接ステップで与える経路は未実装
- Phase B: 実装済み（`motor_control_lib/drive_mode_fsm.hpp`, `ControlCore` 統合, `drive_fsm_run_*` パラメータ。既定で従来出力と同一 = `test_control_core` で回帰確認）
- Phase C: 推定器本体のみ実装（`motor_control_lib/wheel_observer.hpp`）。`DriveStatus.msg` への推定値フィールド追加（契約変更）は未実施
- Phase D: 未着手
- Phase E: 実装済み（`motor_control_lib/wheel_velocity_lqr.hpp`, `ControlCore` の RUN 域 LQR+FF, `velocity_run_*` パラメータ）。**既定は無効**。有効化は Phase A の同定結果（go/no-go 判定）後
- Phase F: 未着手
関連資料: `~/workspace/mpc_study`（MPC / LQR+FF / MPPI の解説と Python プロトタイプ。`README.md` 5.4 節「LQR+FF」、4 章「線形 MPC」）、`~/workspace/ddt_motor.md`（M0602C 仕様）

---

## 0. 結論（先に 4 行）

1. **velocity モードと current モードは制御対象が別物**。velocity はファーム速度ループ（ブラックボックス）、current はモータ物理（同定可能）。同じ「LQR+FF」でも中身と期待値が違うので、設計を分ける。
2. **velocity モード**: 低 RPM 域・停止・ブレーキでファームの振る舞いが変わるので、`RUN / CREEP / STOP` の**明示的な状態機械**を持たせ、線形制御（LQR+FF）は `RUN` 限定・低ゲイン・**同定で一次遅れが当てはまった場合のみ**入れる。それ以外は参照整形（FF）と既存ロジックの流用。
3. **current モード**: 既存 PI を残したまま、同じモデルで **LQR+FF（= 制約なし MPC）を基本形**として追加し、制約（電流・Δ電流・熱バジェット・左右協調）が効く場面で **MPC（QP）に昇格**する。QP 失敗/時間超過時は LQR+FF にフォールバック。
4. 最初の一歩はコードではなく**ステップ応答の収集と同定**（Phase A）。ここで得た $\tau$, むだ時間, $a, b$ の当てはまり具合が、Phase E（velocity 外側 LQR）の go/no-go を決める。

---

## 1. 背景と目的

### 1.1 現状（コード上の事実）

| 項目 | 事実 | 出典 |
|---|---|---|
| 制御周期 | 固定 50 Hz tick、dt は定数 | `drive_control_tick.hpp`, `control_rate: 50.0` |
| velocity モード | ホストは目標 rpm を送るだけ。加減速は `drive_slew`（レート・デマンド適応・テーパー）+ ファーム `accel_time`（=1、実質なし）の二重プロファイル | `control_core.hpp`, YAML コメント |
| current モード | ソフト PI: rpm 誤差 → 電流指令、`max_current_amp: 1.0` で固定クランプ、積分は純 P 起動 | `ddt_current_pi.hpp`, `DdtMotorLib::runCurrentLoopStep` |
| 低 RPM の問題 | ファーム速度ループが低速で減衰不足（目標 95 rpm で 59〜118 rpm を ≈1.8 Hz 往復）。対策は `min_command_rpm` 不感帯と `drive_stop_gate` ヒステリシス | YAML コメント, `drive_stop_gate.hpp` |
| 停止の問題 | ブレーキ再送の扱い（`stop_resend_interval_ms: 300`, `brake_on_stop: false`）で調整済み。2 段階停止はファーム目標再送が主因 | YAML コメント |
| フィードバック | 毎 tick 電流 raw・rpm（整数、ノイズ大）・位置。温度は Protocol 2 未実装で常に 0 | `MotorFeedback.msg` |
| 通信 | RS-485 1 問 1 答、2 モータ往復 ≈ 7 ms（落ちると 20 ms）。**最低 1 tick のむだ時間** | `drive_control_refactor.md` P2 |
| モータ定数 | $K_t = 0.44$ Nm/A、定格 1.2 A / 0.55 Nm、ストール ≤ 6 A、保護: 母線 3 A×8 s、相 4.6 A×5 s、ストール 5 s、5 回で無効化 | `ddt_motor.md` |

### 1.2 目的（何を得たいか）

- current モード: 固定 1 A クランプで捨てている起動トルクを、**保護しきい値（時間積分型）を守りながら**使えるようにする。飽和時に**左右協調**で直進性を保つ。加速プロファイル用の手作りルールを制約として一元化する。
- velocity モード: 低 RPM・停止・ブレーキ領域と走行領域を**状態として明示**し、走行領域だけにモデルベース制御を適用できる構造にする。ファーム遅れをモデルに入れて参照整形（FF）を一本化する。
- 両モード: 観測ノイズに耐える**車輪角速度の推定器**を持ち、制御用とレポート用で同じ推定値を使う。

### 1.3 得ないもの（期待値の調整）

- 帯域は 50 Hz + むだ時間 1 tick で決まる。LQR/MPC にしても応答は数 Hz 止まり。
- velocity モードの低 RPM 振動は非線形（摩擦・コギング・量子化）の可能性が高く、線形制御では止まらない前提で設計する（`CREEP` 状態として隔離する）。
- joy 入力は予測不能なので、MPC の「先読み」の恩恵は薄い。MPC の取り分は制約の扱いと多変数協調。

---

## 2. モデル

### 2.1 current モード: モータ物理（車輪 1 輪）

連続時間: $J\dot\omega = K_t\, i - b\,\omega - T_{load}$。離散化（dt = 1/control_rate、通信むだ時間 1 tick）:

$$
\omega_{k+1} = a\,\omega_k + b_i\, i_{k-1} + d_k,\qquad
a = e^{-\frac{b}{J}dt},\quad b_i \approx \frac{K_t}{b}(1-a)
$$

- 状態: $x = [\omega,\ i_{prev}]^\top$（むだ時間 1 tick を $i_{prev}$ で表す）。$d_k$ は負荷・摩擦・電圧変動をまとめた**外乱**で、オブザーバで推定する（2.3）。
- $a, b_i$ は Phase A の同定で決める。$K_t = 0.44$ Nm/A は仕様値で、$b_i$ の妥当性確認に使う。
- 単位: 内部は rad/s と A。I/O 境界で rpm ↔ rad/s、A ↔ raw（$\pm 8$ A ↔ $\pm 32767$）を変換（既存 `ddt_current_pi` と同じ換算）。

### 2.2 velocity モード: ファーム速度ループ（ブラックボックス）

目標 rpm $u$ → 実測 rpm $\omega$ を、まず**一次遅れ + むだ時間**で近似する。

$$
\omega_{k+1} = a_v\,\omega_k + (1-a_v)\,u_{k-d_v},\qquad a_v = e^{-dt/\tau_v}
$$

- Phase A で rpm 域ごと（例 50 / 100 / 200 / 400 rpm、正負）にステップ応答を取り、**一次で当てはまる領域（RUN）と当てはまらない領域（CREEP）の境界**を決める。2 次（減衰不足）が要る場合はその旨を記録し、Phase E の go/no-go 材料にする。
- 同定は `accel_time_0p1ms_per_rpm = 1`、`brake_on_stop = false` 固定で行う（ファーム側ランプ・ブレーキは別の系）。

### 2.3 観測器（両モード共通）

実測 rpm は整数量子化 + ノイズが大きい。制御用の $\hat\omega$ と外乱 $\hat d$ を、モデル予測と実測の混合で推定する（1 次の定常カルマン / 外乱オブザーバ）。

$$
\hat\omega_{k+1}^- = a\hat\omega_k + b_i i_{k-1} + \hat d_k,\quad
\hat\omega_{k+1} = \hat\omega_{k+1}^- + L_\omega(\omega^{meas}_{k+1} - \hat\omega_{k+1}^-),\quad
\hat d_{k+1} = \hat d_k + L_d(\omega^{meas}_{k+1} - \hat\omega_{k+1}^-)
$$

- 既存 `measured_lpf_tau_sec` はレポート専用のまま残す（位相遅れが大きく制御には不向き、という YAML の判断を踏襲）。将来レポートも推定値に統一するかは Phase C で評価。
- フィードバック途絶・モード遷移時は `reset(ω_meas)` で実測に上書き。

### 2.4 LQR+FF と MPC の関係（設計を共有する根拠）

評価関数 $J=\sum (x-x_{ref})^\top Q (x-x_{ref}) + R\,(i - i_{ff})^2 + R_d\,\Delta i^2$ に対し、**制約がなければ MPC の解は LQR（+FF）と同形**。したがって

```
current モード制御則 = i_ff（FF） + 状態 FB（LQR ゲイン） + 外乱補償（オブザーバ）   … Phase D
                      [+ 制約付き QP で同じ評価関数を解く]                           … Phase F
```

と段階的に積める。Phase F は Phase D のモデル・重み・オブザーバをそのまま使い、QP が解けないときは Phase D の式に戻す。

- FF: 定常条件 $\omega_{ref} = a\,\omega_{ref} + b_i\, i_{ff} + \hat d$ より $i_{ff} = \big((1-a)\,\omega_{ref} - \hat d\big)/b_i$
- FB: $i = i_{ff} - K\,(\hat x - x_{ref})$、$K$ は離散リカッチ反復（2×2 なので C++ で `on_configure` 時に計算可能。`mpc_study/controllers.py` の `LQRFeedforward.__init__` と同じ反復）
- クランプ: $|i| \le i_{max}$、$|\Delta i| \le \Delta i_{max}$（Phase D ではクランプ、Phase F では制約）

---

## 3. ターゲット構成（責務配置）

```
/target_twist ──▶ ControlCore::step()                                     [motor_control_app]
                  ├─ drive_slew（既存。Phase E 以降は RUN の参照整形と統合検討）
                  ├─ differential_kinematics（既存）→ 左右 目標 ω_ref
                  ├─ DriveModeFsm（新規, velocity 用）: RUN / CREEP / STOP  ← drive_stop_gate を包含
                  ├─ WheelObserver ×2（新規）: ω_meas, i_prev → ω̂, d̂
                  └─ WheelController（新規, モードで実体が変わる）
                       ├─ velocity: RUN → (参照整形 [+ 外側 LQR, 条件付き])、CREEP → 既存不感帯処理、STOP → commandStop
                       └─ current : "current_pi"（既存）| "current_lqr"（Phase D）| "current_mpc"（Phase F, LQR にフォールバック）
                                │
                                ▼ 左右 指令 rpm（velocity）/ 電流 raw（current）
              DifferentialDrive::setWheelRpm / setWheelCurrentRaw（新規 API）      [motor_control_lib]
                                │
                                ▼
              DdtMotorLib（送受信のみ。runCurrentLoopStep は "current_pi" のときだけ使う）
```

設計原則（`drive_control_refactor.md` §4 と AGENTS.md を踏襲）:

- 新規ロジックはすべて **ROS・シリアル・時刻に依存しない純粋関数/小クラス**として `motor_control_lib`（デバイス非依存の制御則）または `motor_control_app`（ControlCore 配下）に置き、`test_control_core` の閉ループシミュレーションで検証する。
- **制御状態には必ず `reset()`** を持たせ、モード遷移・停止・フィードバックタイムアウト・非常停止で呼ぶ。
- パラメータは YAML（`launcher/config/drive_component.yaml`）と `declare_parameter` の 2 箇所を同値に保つ（既存ルール）。
- 非常停止・ウォッチドッグ・フォールト停止の経路（`decideTickAction`）は**変更しない**。新制御則は `kDrive` の中でだけ動く。

---

## 4. Phase 計画

各 Phase は「目的 / 変更 / 成果物 / テスト / 受け入れ基準 / リスク」で記す。A → B → C → D は順序依存、E は A の結果次第、F は D の後。

### Phase A: 同定データ収集と同定（実機必須・コード変更は計測ツールのみ）

**目的**: 2.1 / 2.2 のモデル係数と、velocity モードの RUN/CREEP 境界を実測で決める。

**変更**
- `scripts/identify/` に以下を追加（Python、ROS 2 依存は rosbag 読みのみ）
  - `step_sequence.py`: `/target_twist` に所定のステップ列を publish する（車輪を浮かせた状態で使用）。velocity モード: 左右同 rpm で 0→50→100→200→400→200→100→50→0、各 4 s 保持、正負。current モード: 既存 PI を経由せず電流を直接与える経路が必要なため、`single_ddt_motor` ノード or 新規 `--current-raw` オプションで電流ステップ ±0.3 / 0.6 / 1.0 A（`max_current_amp` の範囲内）。
  - `fit_models.py`: rosbag（`/drive_status`: `left/right.current_amp, velocity_rpm, target_rpm`、header.stamp）から、一次遅れ + むだ時間（velocity）/ $a, b_i, d$（current）を最小二乗で当てはめ、rpm 域ごとの当てはまり（R²、残差の周期性）を出力。結果を `identified_params.yaml` として書き出す。
- 収集手順書 `scripts/identify/README.md`（安全手順含む: ジャッキアップ、非常停止の確認、`max_current_amp` 維持、温度監視は Protocol 2 未実装のため手で触って確認、連続通電時間の上限）。

**成果物**: rosbag 一式、`identified_params.yaml`、当てはまりレポート（rpm 域 × 一次/二次の可否）。

**受け入れ基準**
- current: 3 水準の電流ステップで $a, b_i$ がレベル間で ±20 % 以内に収まる。$b_i$ から逆算した $K_t$ が 0.44 Nm/A の ±30 % 以内（外れたら負荷・単位を疑う）。
- velocity: RUN とみなす rpm 域で一次遅れ + むだ時間の R² ≥ 0.9。CREEP 境界（一次で当てはまらなくなる rpm）を数値で記録。
- むだ時間 $d$ を tick 単位で特定（期待 1〜2）。

**リスク**: 車輪浮かせ状態では負荷が実走行と違う（$d$ が小さい）。実走行での再同定は Phase D 後に行い、オブザーバが差を吸収できるかを見る。

### Phase B: velocity モードの状態機械を明示化（挙動を変えないリファクタ）— 実装済み

**目的**: 既存の停止ヒステリシス + 不感帯を `RUN / CREEP / STOP` の状態機械として取り出し、Phase C/E の制御則が「どの状態で動くか」を固定する。**既定パラメータでは現行と同一の出力**にする。

**変更**
- `motor_control_lib/include/motor_control_lib/drive_mode_fsm.hpp`（純粋関数）
  ```cpp
  enum class DriveMode { kStop, kCreep, kRun };
  struct FsmConfig { int min_command_rpm; int run_enter_rpm; int run_exit_rpm; /* 既定は min_command_rpm + kExitMarginRpm 相当 */ };
  DriveMode updateDriveMode(DriveMode prev, int max_abs_cmd_rpm, const FsmConfig&);
  ```
  - `kStop ↔ kCreep` は `drive_stop_gate::updateStopMode` と同じ閾値・ヒステリシス（包含して使う）。
  - `kCreep ↔ kRun` は新しい閾値対（入り/抜けを分ける）。既定では `run_enter_rpm = run_exit_rpm = min_command_rpm + kExitMarginRpm` とし、`kCreep` が空集合になる = 現行挙動。
- `ControlCore::Output` に `DriveMode mode` を追加（`stop` は `mode == kStop` の別名として残す）。
- `ControlCore::step()` 内で遷移を検出したら、保持している制御状態（Phase C/D/E で増える）を `reset()` する。

**テスト**: `test_drive_mode_fsm.cpp`（境界でトグルしない、入り/抜けヒステリシス、既定で CREEP に入らない）、`test_control_core` に「既定パラメータで出力が Phase B 前と同一」の回帰テストを追加。

**受け入れ基準**: 既定パラメータで `test_control_core` の全シナリオの出力が変わらない。

### Phase C: 車輪観測器（推定値の導入。まずはレポート比較のみ）— 推定器のみ実装済み（msg 変更は未）

**目的**: 2.3 の $\hat\omega, \hat d$ を純粋関数で実装し、まず `/drive_status` に**推定値を追加フィールドとして併記**して実機で妥当性を見る（制御にはまだ使わない）。

**変更**
- `motor_control_lib/include/motor_control_lib/wheel_observer.hpp`: `struct Params {a, b_i, L_omega, L_d}`、`struct State {omega_hat, d_hat}`、`predict()/update()/reset(omega_meas)`。velocity モード用には $a_v, 1-a_v$ を入れて同じ型で使う。
- `DriveStatus.msg` に `float32 left_omega_hat_rpm, right_omega_hat_rpm`（または `MotorFeedback` に `velocity_rpm_est`）を追加。契約は `questix_msgs/README.md` に追記。
- パラメータ: `observer_a`, `observer_b`, `observer_l_omega`, `observer_l_d`（Phase A の `identified_params.yaml` から転記。単一ソースは YAML）。

**テスト**: 量子化（整数 rpm）+ 白色ノイズ + 1 tick 遅れの合成データで、推定誤差が生値 LPF より小さく位相遅れが小さいこと（`test_wheel_observer.cpp`）。

**受け入れ基準**: 実機 rosbag で $\hat\omega$ が実測の包絡に追従し、ステップ時の遅れが `measured_lpf_tau_sec=0.15` より小さい。

### Phase D: current モード LQR+FF（`control_mode: "current_lqr"`）

**目的**: 既存 PI の上位互換として、モデルベースの FF + 状態 FB + 外乱補償を追加。PI は残す。

**変更**
- `motor_control_lib/include/motor_control_lib/wheel_lqr_ff.hpp`（純粋関数）
  - `struct Params {a, b_i, q_omega, q_iprev, r_i, r_di, i_max_amp, di_max_amp_per_tick}`
  - `Gains computeGains(const Params&)`: 2×2 離散リカッチ反復（収束しない場合は `std::nullopt` を返し、呼び出し側は PI にフォールバックしてログ）。
  - `int16_t stepToRaw(State&, const Params&, const Gains&, double omega_ref, double omega_hat, double d_hat, double* i_cmd_amp_out)`: $i_{ff}$ + FB、クランプ、Δi クランプ、raw 換算。`reset()` あり。
- `DdtMotorLib`: `sendMotorCurrentRaw(motor_id, raw)` を public 化（既存 private 関数の公開）。`DifferentialDrive::setWheelCurrentRaw(left_raw, right_raw)` を追加。
- `ControlCore`: `control_mode == "current_lqr"` のとき、目標 ω_ref（運動学変換後）と `WheelObserver` の推定値から `wheel_lqr_ff::stepToRaw` を左右で呼ぶ。停止判定は Phase B の FSM に従う（`kStop` では目標 0 として同じ制御則で減速、実測が停止閾値以下になったら電流 0 + 既存の停止処理）。
- `drive_component`: パラメータ追加（`current_lqr_*`）、`on_configure` でゲイン計算結果をログ出力、`control_mode` の受理値に `"current_lqr"` を追加。未知値は従来どおり velocity にフォールバック。
- ゲイン計算のオフライン版として `scripts/identify/lqr_gains.py`（同じ式。C++ と突き合わせテストの期待値生成に使う）。

**テスト**
- `test_wheel_lqr_ff.cpp`: Python 生成の期待ゲインと一致、クランプ、Δi 制限、`reset()`。
- `test_control_core`: 同定モデル + 量子化 + むだ時間 1 tick + 負荷ステップ外乱の閉ループで、PI（現行パラメータ）と LQR+FF を比較。指標は 90 % 到達時間・オーバーシュート・負荷外乱後の定常誤差・電流のピーク。
- 非常停止・タイムアウト・フォールトの各遷移で `reset()` が呼ばれることのテスト（AGENTS.md 制御状態リセット項目）。

**受け入れ基準**（シミュレーション）: 同じ $i_{max}$ のもとで、PI 比で 90 % 到達時間が短縮またはオーバーシュート減、負荷外乱後の定常誤差が $\hat d$ 補償で収束。**実機**: 現行 PI と同条件で前進・旋回・停止の A/B を rosbag で取り、同じ指標で比較。悪化していれば `current_pi` に戻せる（切替はパラメータのみ）。

**リスク**: 実走行での負荷が同定時と異なる → オブザーバの $\hat d$ が吸収する設計だが、$L_d$ が大きすぎるとノイズで暴れる。$L_d$ は小さめから。

### Phase E: velocity モード RUN の外側 LQR+FF（条件付き）— 実装済み（既定無効、有効化は A の結果待ち）

**go/no-go**: Phase A で RUN 域が一次遅れ + むだ時間で R² ≥ 0.9 **かつ** 実測で追従誤差（定常 or 遅れ）が運用上問題になっている場合のみ実施。どちらかが満たされなければ「参照整形のみ」で終える。

**実装（コードは入れてあり、`velocity_run_lqr_enabled: false` で眠っている。go の場合に YAML で有効化）**
- `motor_control_lib/wheel_velocity_lqr.hpp`: スカラー DARE でゲイン計算、`u = ref + lead*(Δref)/b − dist*d̂/b − K(x̂ − ref)`、補正量を `max_correction_rpm` でクランプ。積分は持たず、定常誤差は $\hat d$ で補償。
- `ControlCore`: RUN かつ FB 有効のときだけ適用。FB 無効・遷移・`reset()` でオブザーバ/LQR 状態を破棄。`drive_component` は `getMotorFeedbackData().velocity_rpm_raw`（生値）を両輪の鮮度 ≤ `velocity_run_feedback_max_age_sec` のときに渡す。
- 外側ループは内側より十分遅く（q 小・r 大、K ≲ 0.3 目安）、位相進み（lead）は控えめに。
- `kCreep` では従来処理、`kStop` では `commandStop()`。`kRun → kCreep/kStop` 遷移でリセット。
- 既存 `drive_slew` との二重化を避けるため、RUN では「参照整形 = drive_slew の出力」に対して外側 FB を足す形にする（drive_slew は残す）。

**テスト**: 同定した一次遅れ + むだ時間モデルでの閉ループ（`test_control_core`）、ゲイン上限で内側ループとの干渉（位相余裕）を確認。

**受け入れ基準**: 実機で RUN 域の追従遅れが改善し、CREEP 境界付近の振動が悪化しない。悪化する場合はゲインを 0（= 参照整形のみ）にできる。

### Phase F: current モード MPC（`control_mode: "current_mpc"`、LQR へフォールバック）

**目的**: Phase D と同じモデル・重みで、制約を明示的に扱う。

**定式化**（`mpc_study/README.md` 4 章と同形。変数は左右の電流列 $U=[i_{L,0..N-1}, i_{R,0..N-1}]$、$N$ = 10〜20）
- 状態: 左右 $[\hat\omega, i_{prev}]$ + 熱バジェット $E_L, E_R$
- 評価: 車体 $(v,\omega_{body})$ の追従誤差（左右 ω の線形結合なので二次形式のまま）+ $R\,(i-i_{ff})^2$ + $R_d\Delta i^2$
- 制約: $|i| \le i_{max}$、$|\Delta i| \le \Delta i_{max}$、$|\omega| \le \omega_{max}$（475 rpm）、$E \le E_{max}$（ソフト制約、スラック付き）
- 熱バジェット: $E_{k+1} = \max\!\big(0,\ E_k + dt\,(i_k^2 - I_{cont}^2)\big)$。$I_{cont}$ は定格 1.2 A を上限、$E_{max}$ は母線保護（3 A × 8 s）から安全率 0.5 以下で初期設定。**仕様書の保護は電源再投入まで無効化する条項があるため、初期値は保守的に取り、実機で段階的に緩める**。
- 左右協調: 片輪が制約に当たる場合、評価関数が $(v,\omega_{body})$ なので自動的にもう片輪が追従する。

**変更**
- `motor_control_lib/include/motor_control_lib/qp_admm.hpp`: `mpc_study/qp_solver.py` の ADMM（適応 ρ 付き）を C++ に移植（Eigen 使用可否は `package.xml` 依存で判断。不可なら固定サイズ配列）。最大反復・時間上限を持ち、超過時は `nullopt`。
- `motor_control_lib/include/motor_control_lib/wheel_pair_mpc.hpp`: 予測行列構築 + QP 呼び出し + ウォームスタート。解が得られなければ Phase D の LQR+FF を返す（フォールバック回数をカウントして `/drive_status` か診断ログに出す）。
- パラメータ: `mpc_horizon`, `mpc_q_linear`, `mpc_q_angular`, `mpc_r_i`, `mpc_r_di`, `mpc_i_max_amp`, `mpc_di_max_amp_per_s`, `mpc_thermal_i_cont_amp`, `mpc_thermal_budget_a2s`, `mpc_qp_max_iter`, `mpc_qp_time_budget_ms`。

**テスト**: `test_qp_admm.cpp`（Python 版と同一問題で同一解）、`test_wheel_pair_mpc.cpp`（制約が活性のとき左右比が保たれる、熱バジェット超過時に電流が絞られる、QP 失敗時に LQR 出力と一致）、`test_control_core` で PI / LQR+FF / MPC の三者比較。

**受け入れ基準**: Pi 5 で QP 1 回 ≤ 2 ms（tick 予算 20 ms のうちシリアル 7〜20 ms を考慮）。シミュレーションで LQR+FF に対し、飽和条件下の進路ずれ（ヨー誤差）と熱バジェット超過回数が減少。実機 A/B で起動トルク改善と保護非発動を確認。

---

## 5. パラメータ設計

- 単一ソース: `launcher/config/drive_component.yaml`。`declare_parameter` のデフォルトは同値に保つ（既存ルール）。
- 命名: モード接頭辞で分ける（`current_lqr_*`, `current_mpc_*`, `velocity_run_*`, `observer_*`, `drive_fsm_*`）。モード限定パラメータは YAML コメントに適用モードを明記し、別モードでは無視ログを出す（AGENTS.md）。
- 同定値（`a`, `b_i`, `tau_v`, `d`）は `identified_params.yaml` を参照して YAML に転記し、転記元の rosbag 名・日付をコメントに残す。
- 実行時変更: 重み・ゲイン系は `setConfig()` 経由で再計算可能にする（走行中の指令飛びを避けるため、ゲイン変更時も制御状態は保持）。

## 6. 検証戦略

| 層 | 手段 | 主な確認事項 |
|---|---|---|
| 単体 | gtest（純粋関数） | ゲイン計算、クランプ、FSM 遷移、オブザーバ、QP 解の一致 |
| 閉ループ sim | `test_control_core` 拡張（同定モデル + 量子化 + むだ時間 + 外乱） | PI / LQR+FF / MPC の指標比較、リセット挙動、飽和時の左右協調 |
| 実機 | rosbag A/B（同一コース・同一操作列は `step_sequence.py` で再現） | 90 % 到達時間、オーバーシュート、停止収束時間、旋回振動、電流ピーク、保護非発動、tick overrun 警告 |

指標の算出は `scripts/identify/` に評価スクリプトを置き、Phase A の収集ツールと共用する。

## 7. 安全・運用上の注意

- 電流直接指令は保護しきい値（3 A / 4.6 A / ストール）に直結する。`i_max` の既定は現行 1.0 A を据え置き、Phase F の熱バジェットで段階的に緩める。**保護 5 回で電源再投入まで無効化**されるため、同定・A/B は必ず非常停止が効く状態で行う。
- 温度フィードバックは未実装（常に 0）。Protocol 2 の実装は別トラックだが、熱バジェットの実測検証には欲しい。
- 非常停止・タイムアウト・フォールトの経路は既存のまま。新制御則は `TickAction::kDrive` 内に閉じる。
- モード切替（`control_mode`）は起動時のみ。走行中の切替は対象外（ファームのモード切替手順の制約もある）。
- 制御状態のリセット規則: `DriveMode` 遷移、`reset()` 呼び出し元（武装解除・停止・フィードバック途絶 ≥ 0.5 s・非常停止）で必ずオブザーバ・LQR・MPC 状態を初期化し、オブザーバは実測で上書き。

## 8. やらないこと（non-goals）

- 車体速度（`/odom`）に対する外側ループ（`drive_control_refactor.md` Phase 4 の領域）。本計画は車輪レベルまで。
- 経路追従（nav2 側。`nav2_mppi_controller` 等の採用は別トラック）。
- ファーム速度ループの内部パラメータ変更（不可）。
- 非線形 MPC、学習ベースの同定。

## 9. 未解決の論点 / 判断ポイント

1. **Phase E の go/no-go** は Phase A の結果で決める（R² と実測の追従誤差）。no-go なら velocity モードは FSM + 参照整形で完了。
2. current モードの**停止**を「制御則で 0 まで減速 → 電流 0」にするか、既存の `commandStop()`（ブレーキフレーム）に渡すか。ファームが current モードでブレーキ指令をどう扱うかは仕様書に明記がなく、実機確認が必要。
3. 熱バジェットの $E_{max}$ 初期値。仕様の保護条件が「継続時間」で書かれているため I²t への換算は近似。保守的な初期値と段階的な緩和で運用し、Protocol 2（温度）実装後に見直す。
4. C++ 側の線形代数: Eigen を `motor_control_lib` に依存追加してよいか（ビルド環境・Pi 5 の負荷）。不可なら 2×2 / 小規模固定サイズの自前実装。
5. `DriveStatus.msg` への推定値フィールド追加（Phase C）は契約変更。購読側（`robot_manager` など）への影響を確認。

---

## 付録 A: 実装の参照元（`~/workspace/mpc_study`）

| 本計画の要素 | 参照 |
|---|---|
| LQR ゲイン計算（離散リカッチ反復） | `controllers.py` `LQRFeedforward.__init__` |
| 予測行列 $X=Fx_0+GU+SW$ の構築 | `controllers.py` `LinearMPC._build_prediction` |
| ADMM QP ソルバ（適応 ρ） | `qp_solver.py`、検算 `test_qp.py` |
| 遅れを持つアクチュエータのモデル化（$\tau$） | `README.md` 3.2 / 3.4 節（ステア一次遅れ） |
| MPC / LQR+FF の関係 | `README.md` 5.4 節 |

## 付録 B: Phase A の収集プロトコル（要約）

1. 車輪を浮かせ、非常停止を確認。`control_mode: velocity`、`accel_time_0p1ms_per_rpm: 1`、`brake_on_stop: false`、`max_linear_accel` は十分大きく（ステップが鈍らないように。例 20）。
2. `step_sequence.py --mode velocity` で正負のステップ列、各レベル 4 s、2 往復。rosbag: `/drive_status`, `/target_twist`。
3. `control_mode: current`（既存 PI）で同様に収集（PI 経由の応答。参考データ）。
4. 電流直接ステップ（`--mode current-raw`、±0.3 / 0.6 / 1.0 A、各 3 s、計 6 回）。連続通電は 1 レベルあたり 10 s 以内、間に 20 s 休止。
5. `fit_models.py` を実行し、`identified_params.yaml` と当てはまりレポートを `design/identification/` に保存（rosbag 名を記録）。
