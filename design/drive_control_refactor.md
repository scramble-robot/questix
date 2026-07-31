# 走行制御アーキテクチャ リファクタリング提案

対象: `joy_controller` → `drive_component` → `DifferentialDrive` → `DdtMotorLib` の走行制御経路
きっかけ: PR #141（`fix: enhance motor control parameters and improve drive responsiveness`、19 files / +861 -68 / 16 commits）
状態: 設計提案（コード変更は含まない）

改訂メモ: 初版の分析をコードベースに対して検証した改訂版。主要な主張（P1〜P6）は
現ファイルの内容と一致することを確認済み。以下を修正・追記した。

- 旋回の到達時間を 2.0 秒 → **2.44 秒**に修正（§3.1）。初版の手計算は 2.9 秒としていたが、
  Phase 3 で導入した閉ループシミュレーション（`test_control_core`）で実測したところ
  2.44 秒だった。手計算は終端の実効時定数を過大評価していた（詳細は §3.1 の注記）。
  **提案書の検算誤りをシミュレーションが検出した**形で、これが Phase 3 の狙いそのもの。
- 「旋回指令の全域が不安定域」→「**大半が実測された不安定域と重なる**」に修正（フルスティック ≈ 143 RPM。§3.2）。
- P2 のシリアル負荷見積りを精密化（`refreshMotorFeedback` の鮮度ゲートとアイドル時再送。§2 P2）。
- 新規発見: `declare_parameter` デフォルトと `launcher/config/drive_component.yaml` の**乖離 5 件**（§2 P8、Phase 0）。
- P7（観測遅れ）の本文を補完。
- §4 以降（あるべき構成・移行計画・検証戦略）を追加。

---

## 0. 結論（先に3行)

1. 現状の限界は「制御層が無い」ことではなく、**制御が3層に分散したまま、制御周期そのものが存在しない**ことにある。`twistCallback` が制御ステップを兼ねているため、制御周期 = joy の到着間隔（DualShock 20 Hz / UART 50 Hz）になっている。
2. `control_module` を入れる方向性は正しい。ただし最初に入れるべきは PI や新しい制御則ではなく、**固定周期ループ**と**シリアル I/O の制御パスからの分離**である。この2つを入れないと、どんな制御則もチューニングが再現しない。
3. `target_twist` に追従できない件は、**実機だけの問題ではない**。現在のパラメータでは、フルスティックの角速度指令 6.0 rad/s への整定に設計上**2.44 秒**かかる（レート上限のみなら 2.00 秒。差の 0.44 秒はデマンド適応とテーパーの尾。前進 2.0 m/s では 1.22 秒に対しレート上限のみ 0.67 秒で、相対的にはこちらの尾のほうが大きい。§3.1）。加えて旋回指令の車輪 RPM（0〜143 RPM）のうち **84%** がファーム速度ループの実測不安定域（目標 95 RPM で 59〜118 RPM を約 1.8 Hz で往復）と重なる。実機なしで検算・切り分けできる部分が残っている。

---

## 1. 現状の責務配置

コード上の実態を層ごとに並べる（推測ではなく現ファイルの内容）。

| 層 | ファイル | 実際に持っている責務 |
|---|---|---|
| 入力 | `joy_controller/src/joy_controller_component.cpp` | 軸 → `Twist` の線形写像のみ。`/target_twist` を joy 受信ごとに publish |
| ゲート | `joy_gate/src/joy_gate_component.cpp` | `/gpio/controllable` による joy 遮断 |
| ノード | `motor_control_app/src/drive_component.cpp` | Lifecycle、auto_start リトライ、非常停止購読、**スルーレート/デマンド適応/テーパー**、コマンドウォッチドッグ、`/drive_status` publish、**オドメトリ積分 + TF**、パラメータ（37 個） |
| 運動学 | `motor_control_lib/src/differential_drive.cpp` | twist ↔ 左右 RPM 変換、**停止/走行ヒステリシス状態機械**（`stop_mode_`）、`min_command_rpm` 不感帯 <br>（Phase 3 以降: 変換式は `differential_kinematics` の純粋関数へ、通常経路の停止判定は `control_core` へ移動） |
| デバイス | `motor_control_lib/src/ddt_motor_lib.cpp` | シリアル fd、プロトコル送受信、リトライ、**電流モード PI**、**実測 RPM ローパス**、**停止再送スロットル**、ブレーキ、ファーム `accel_time`、最終フレーム保持 |

「制御」に相当するロジックは `drive_slew`（ホスト側加減速）、`drive_stop_gate`（停止判定）、`ddt_current_pi`（電流 PI）、`DdtMotorLib::setMeasuredLowpassTau`（平滑化）の4箇所に分かれ、それぞれ別の層にある。

純粋関数として切り出しテストされているのは良い（`test_drive_slew`, `test_drive_stop_gate`, `test_ddt_current_pi`, `test_drive_watchdog`）。しかし**それらを組み合わせた閉ループ挙動をテストする場所がどこにも無い**。だから PR #141 は実機で試す以外に検証手段がなく、16 コミット・パラメータ十数個の追加になった。これは実装者の問題ではなく構造の帰結である。

（Phase 3 で `control_core` + `test_control_core` を追加し、この穴は埋めた。§5 参照）

---

## 2. 構造上の限界（8点）

### P1. 制御周期が存在しない（最重要）

`drive_component.cpp:562-564` — スルーレート制限の `dt` は `/target_twist` の到着間隔である。

```cpp
double dt = drive_slew::normalizeDt(has_last_cmd_, has_last_cmd_ ? (now - last_cmd_time_).seconds() : 0.0);
```

帰結:

- 制御周期が上流依存。`joy_node` の `autorepeat_rate: 20.0`（DualShock）と `uart_joy_driver` の `publish_rate: 50.0` で、**同じパラメータのまま実効加速度プロファイルが変わる**。
- `/target_twist` の QoS は depth 1（`drive_component.cpp:207-208`）。エグゼキュータが詰まって取りこぼすと、その分のランプが単純に消える（`normalizeDt` の上限 `kMaxDtSec = 0.1 s` で取り戻せない）。設定値より**実効加速度が必ず小さくなる**方向。
- スティックを離した瞬間の減速も同じ経路なので、停止応答も joy レートに依存する。

### P2. ブロッキング I/O が制御コールバック内にある

`twistCallback` → `DifferentialDrive::setVelocity` → 左右それぞれ `DdtMotorLib::sendFrameWithFeedback`。中身は `tcflush` → `write` → **最大 10 ms の応答待ち**（`ddt_motor_lib.cpp:529-548`）。

57600 baud 8N1 = 5,760 B/s。10 バイトフレーム = 1.74 ms、指令+フィードバックの往復で約 3.5 ms。

- 正常時: 2 モータ = 約 7 ms をサブスクリプションコールバック内で消費。
- フィードバック落ち: 10 ms × 2 = **20 ms** ブロック。
- さらに `statusTimerCallback`（50 Hz、`status_publish_rate: 50.0`）が `refreshMotorFeedback` を左右に呼ぶ。鮮度ゲート（`max_age_sec = 0.05`）付きなので走行中（UART 50 Hz）はほぼ no-op だが、**DualShock（20 Hz、指令間隔 50 ms）では鮮度切れの周期に入り、再送（最悪 10 ms × 2）が指令経路と交互に走る**。アイドル時は `stop_resend_interval_ms: 0`（現 YAML）でスロットルが無効のため、鮮度切れのたび（約 17 Hz × 2 モータ）に停止フレームを再送し続ける。
- twist/status/watchdog/auto_start は**意図的に同一 MutuallyExclusive グループ**（`drive_component.hpp:150-153`）。つまり全部直列。

20 ms 周期のステータスタイマーが最悪 20 ms 使い得る状況で、joy レートの指令が同じスレッドと同じシリアルバスを取り合っている。**指令経路と観測経路が互いを劣化させる**構造になっている。P1 の dt ジッタの主因もこれ。

### P3. 加速プロファイルの多重化

同じ「加速の緩やかさ」を決める機構が並列に存在する。

1. ホスト `max_*_accel`（`drive_slew::clampRate`）
2. ホスト デマンド適応（`min_*_accel` / `accel_demand_ref_*`）
3. ホスト テーパー（`slew_taper_band_*`）
4. ファーム `accel_time_0p1ms_per_rpm`
5. ファーム速度ループ自体の応答
6. `min_command_rpm` 不感帯 + `stop_mode_` ヒステリシス
7. `stop_resend_interval_ms` / `brake_on_stop`

`on_configure` が「加速プロファイル支配側: firmware / host」をログに出している（`drive_component.cpp:185-203`）こと自体が、この多重性の症状である。さらに `accel_time` は左右共通の単一ファームパラメータで前後と旋回を分離できないため、コメントにあるとおり「旋回の振動は `slew_taper_band_angular` 側で押さえる」という迂回が必要になっている。

パラメータが直交していないので、1つ触ると他の効き方が変わる。これが「無理やり合わせる形」の実体。

### P4. 車体速度に対する閉ループが存在しない

- `control_mode: "velocity"` はファーム速度ループへの丸投げで、ホスト側は完全にオープンループ。
- `control_mode: "current"` は**車輪 RPM** の PI（`ddt_current_pi`）で、車体速度 (v, ω) の PI ではない。しかも実行タイミングは指令送信経路の中（= P1 と同じイベント駆動）。
- 実測 twist は `/odom` として publish されているのに（`publishOdometry`）、**それが制御に戻る配線が存在しない**。

ここが一番大きな構造上の穴で、「`target_twist` に追従できない」に対して打つ手が現状ホスト側に無い理由でもある。

### P5. 指令の調停点が無い

`/target_twist` は `joy_controller` 単独 publisher 前提（トピック名も `drive_component.cpp:208` でハードコード）。将来 nav2 / 自律走行 / 自動照準が入ったとき、誰の指令を優先するかを決める場所がない。

非常停止も同様に分散している: `drive_component` / `shot_component` / `esc_motor_control` がそれぞれ `/emergency_stop` を購読し、各自の解釈で停止する。契約は `questix_msgs/README.md` に書かれていて運用できているが、**安全ロジックの実装単一ソースは無い**。

### P6. デバイス層の関心事が混ざっている

`DdtMotorLib` 1クラスが、シリアル fd / termios / プロトコル codec / リトライ / モード管理 / 電流 PI / 実測 LPF / 停止再送スロットル / 最終フレーム保持を持っている（ヘッダ 302 行、`recursive_mutex` で自己再入を許している = 責務が絡んでいる証拠）。

`ddt_protocol` が純関数として分離されているのは良い。残りが混ざっている。

### P7. 観測遅れが症状の見え方を歪めている

- `measured_lpf_tau_sec: 0.15`（現 YAML）は一次ローパスで遮断周波数 fc ≈ 1.06 Hz。実機で観測された振動は約 1.8 Hz なので、レポート経路では振幅が約 **0.5 倍**に減衰し（1/√(1+(1.8/1.06)²) ≈ 0.51）、位相遅れ約 60° ≈ 92 ms を伴って `/drive_status` と `/odom` に現れる。**rosbag で見える振動は実際の半分**であり、チューニングの合否判定が甘くなる方向に歪む。
- フィードバックは独立した観測ではなく、**指令フレームへの応答としてしか届かない**（`sendFrameWithFeedback` / `refreshMotorFeedback` の再送）。観測レートが指令レートに拘束され、停止スロットル中はフィードバックが凍結する。「観測が指令に依存する」構造なので、指令を止めて挙動だけ観察することができない。
- オドメトリはローパス済み実測を `status_publish_rate` 周期で積分するため、積分にも同じ位相遅れが乗る。
- 一方で current モードの PI は生値を使う（`runCurrentLoopStep` は `fb.speed` 直読み）。**制御が見る世界とログが見る世界が既に別物**であり、ログから制御を推論すると誤る。

### P8. 宣言デフォルトと YAML の乖離（新規、初版に無し）

`launcher/config/drive_component.yaml` の冒頭は「宣言デフォルトはこの yaml の値と同値に保っている」と明言しているが、PR #141 後の実態は 5 件乖離している。

| パラメータ | `declare_parameter`（単体launch時） | YAML（統合起動時） |
|---|---|---|
| `max_angular_accel` | 2.0 | 3.0 |
| `min_angular_accel` | 0.35 | 0.15 |
| `slew_taper_band_linear` | 0.4 | 0.2 |
| `slew_taper_band_angular` | 0.9 | 0.2 |
| `measured_lpf_tau_sec` | 0.1 | 0.15 |

つまり**単体 launch と統合起動で走行フィーリングが違う**。さらに `drive_component.hpp` のクラス内デフォルト（`brake_on_stop_{true}`, `accel_time_0p1ms_per_rpm_{50}`, `min_command_rpm_{8}`, `stop_resend_interval_ms_{200}`, `slew_taper_band_*{0.15/0.3}`）とコンストラクタ初期化子（`cmd_timeout_sec_(0.5)` vs 宣言 1.0）は `readParameters()` で必ず上書きされるデッド値だが、3 種類目の「デフォルトらしき値」としてコードを読む人を誤導する。AGENTS.md の defect-prevention checklist「Single source of truth for defaults」の違反そのものであり、Phase 0 で先に潰す（§5）。

**→ 対応済み（本ブランチ）**: 宣言デフォルト 5 件を YAML（実機チューニング済みの値）に合わせ、クラス内初期化子・コンストラクタ初期化子も同値に揃えた。両ファイルに「YAML が単一ソース、変更時は両方更新」の相互参照コメントを追加。

---

## 3. 実機なしでできる検算と切り分け

### 3.1 フルスティック旋回の整定時間 = 2.44 秒（シミュレーション実測）

現 YAML（`angular_input_ratio: 6.0`, `max_angular_accel: 3.0`, `min_angular_accel: 0.15`,
`accel_demand_ref_angular: 0.5`, `slew_taper_band_angular: 0.2`）でのステップ応答。
以下は Phase 3 で導入した `test_control_core` の実測値（制御周期 50 Hz、整定判定は
車輪 RPM の量子化 1 RPM ≈ 0.042 rad/s 以内）。

| 区間 | 内容 | 所要 |
|---|---|---|
| ランプ | 残差 ≥ 0.5 rad/s。`demandScaledAccel` は max に張り付き 3.0 rad/s² の一定ランプ（0 → 5.5 rad/s） | 1.84 秒 |
| 減速 | 残差 0.5 → 0.2 rad/s。加速度が 3.0 → 1.29 rad/s² へ線形に低下 | 0.14 秒 |
| 尾 | 残差 < 0.2 rad/s（テーパー帯）。ステップ上限が残差比例で縮み、同時にデマンド適応が加速度を引き下げる | 0.46 秒 |
| | **合計** | **2.44 秒** |

機構ごとの寄与（同じシミュレーションで各機構を無効化して実測）:

| 設定 | 整定時間 |
|---|---|
| 両方無効（純粋なレート上限のみ = 6.0 / 3.0） | 2.00 秒 |
| デマンド適応のみ無効（テーパー有効） | 2.04 秒 |
| テーパーのみ無効（デマンド適応有効） | 2.18 秒 |
| 現 YAML（両方有効） | 2.44 秒 |

単独の寄与は 0.04 秒（テーパー）と 0.18 秒（適応）だが、両方有効だと 0.44 秒になる。
テーパー帯の中で「ステップ幅の絞り」と「加速度の引き下げ」が乗算的に効くため。
尾の主因はデマンド適応で、テーパー単独の寄与は小さい。

**前進のほうが相対的な尾は大きい**: 前進フルスティック（0 → 2.0 m/s）は 1.22 秒で、
レート上限のみなら 0.67 秒（+82%）。旋回の +22% より悪い。「前進の追従が重い」体感は
主にこちらで説明できる。

初版の手計算（2.9 秒）の誤り: 終端の実効時定数を `taper_band / min_accel ≈ 1.3 秒` と
見積もったが、デマンド適応の加速度が下限 0.15 rad/s² に近づくのは残差がほぼ 0 のときで、
整定判定（残差 0.042 rad/s）の時点では加速度はまだ 0.39 rad/s² ある。尾は約 0.9 秒では
なく 0.46 秒だった。**この誤りはシミュレーションを書いて初めて分かった**（Phase 3 の
狙いそのもの）。

副作用の指摘: デマンド適応（`min_angular_accel`）は「ゆっくり倒したとき穏やかに」が目的だが、**ステップ入力の終端でも同じ絞りが掛かる**。目的（入力の丁寧さに応じた応答）と手段（残差の大小で加速度を変える）が一致しておらず、残差は「入力の丁寧さ」と「追従の遅れ」を区別できない。これは P3 の非直交性の具体例。

### 3.2 旋回指令の車輪 RPM は 84% が実測不安定域

旋回のみのフルスティックで車輪 RPM = ω·(wheel_separation/2)/(2π·wheel_radius)·60 = 6.0 × 0.25 / 0.628 × 60 = **143 RPM**（`test_differential_kinematics` で固定）。実機ログでは目標 95 RPM 一定で実測 59〜118 RPM が約 1.8 Hz で振動し「低速側はさらに悪化」（YAML コメント）。不安定域の上限を控えめに 120 RPM と置くと、旋回指令のレンジ 0〜143 RPM のうち **84%** が不安定域に入り、フルスティックでもその 1.2 倍にとどまる。**「旋回が安定しない」のはチューニング不足である前に、動作点の選定の問題**。`min_command_rpm: 5` では旋回レンジの下端 3% しか除外できていない。

Phase 3 の閉ループテスト（`ConstantHostCommandStillOscillatesInsideUnstableRegion`）は、この
帰結を数値で固定している: 目標 4.0 rad/s（車輪 95 RPM = 実機ログの不安定動作点）で
**ホスト指令は完全に一定（p-p 0 RPM）なのに、プラントの実測は約 50 RPM p-p で振動する**。
ホスト側のスルーレート・テーパー・LPF をどう調整してもこの振動には触れない。

### 3.3 切り分けの含意

- 追従遅れの一部（旋回 2.44 秒 / 前進 1.22 秒）はホスト側パラメータの設計値であり、実機なしで再現・修正評価できる（Phase 3 で CI 化済み）。
- 旋回の振動はファーム速度ループの特性であり、ホスト側でどれだけ平滑化しても動作点が不安定域にある限り消えない。対策の軸は (a) 動作点を上げる（ギア比・車輪径・`angular_input_ratio` の再設計）、(b) ファーム速度ループを使わない（current モードの整備）、(c) 不安定域を避ける指令整形、のいずれかで、スルーレートのチューニングではない。

---

## 4. あるべき責務配置（ターゲット構成）

方針: ノード構成・トピック契約は変えない。`drive_component` の内部を「固定周期の制御コア + 非同期の I/O」に組み替える。

```
[/target_twist] ──> twistCallback: 最新値の保存のみ（I/O・計算なし）
                          │
             control tick（固定周期, 既定 50 Hz）
                          │
        ControlCore::step(target, measured, dt_fixed)   ← 純粋関数（新設）
        （slew → stop gate → [将来: 車体速度 PI] → 左右 RPM）
                          │
        シリアル送受信（指令+フィードバック往復、tick 内で唯一のバス利用者）
                          │
        フィードバック快照の更新
                          │
statusTimerCallback: 快照の publish のみ（シリアルに触らない）
```

- **制御周期はパラメータ `control_rate`（既定 50.0 Hz）で固定**。dt が定数になり、チューニングが joy ソース（20/50 Hz）から独立する。
- **観測は指令の副産物として tick ごとに 50 Hz で得られる**（DDT プロトコルは指令応答がフィードバックなので、固定周期送信にした時点で追加コストなしに観測周期も固定される）。`statusTimerCallback` はシリアルに触らず快照を読むだけになり、P2 のバス競合が消える。
- **ControlCore は純粋関数**（入力: 目標 twist・実測車輪 RPM・dt、出力: 左右指令 RPM + 停止フラグ）。既存の `drive_slew` / `drive_stop_gate` / `ddt_current_pi` を呼ぶ合成層で、閉ループシミュレーションテストの置き場になる。
- 車体速度 PI（P4 の解）は ControlCore の中の**将来の追加点**であって、最初に入れるものではない。固定 dt と 50 Hz 観測が揃って初めて意味を持つ。
- `DdtMotorLib` は段階的に「transport（fd/termios/リトライ）+ codec（既存 `ddt_protocol`）+ device state」へ分割するが、これは P1/P2 解消の後で良い（P6 は急所ではない）。

---

## 5. 移行計画

各 Phase は独立にレビュー・ロールバック可能な小さい PR にする。Phase 0–3 は AMD64 の `colcon build` / `colcon test` で検証可能。実機（Raspberry Pi 5 + 実車）検証が必須なのは Phase 1 以降の走行フィーリング確認のみ。

### Phase 0: デフォルトの単一ソース化（実機不要・リスク極小）— 実施済み（本ブランチ）

- §2 P8 の乖離 5 件を解消した。`launcher/config/drive_component.yaml` を正として `declare_parameter` を合わせた（YAML が実機チューニングの結果であるため）。統合起動（launcher 経由）の挙動は不変で、単体 launch のみ統合起動と同じチューニング済み挙動に変わる。
- `drive_component.hpp` のクラス内初期化子とコンストラクタの `cmd_timeout_sec_` を `declare_parameter` と同値に揃え、両ファイルに相互参照コメントを追加した。
- 検証: `clang-format --dry-run -Werror`（リポジトリ `.clang-format`）/ `git diff --check` パス。デフォルト値を参照するテスト・ドキュメントが無いことを grep で確認。colcon build/test は実機側 CI に委ねる。

### Phase 1: 固定周期制御ループ（意味論の最小変更で dt を固定化）— 実装済み（本ブランチ、実機回帰確認待ち）

- `control_rate` パラメータ（既定 50.0）と制御 tick タイマーを追加した。
- `twistCallback` は目標値と受信時刻の保存のみに縮退（シリアル送信・スルーレート計算を tick へ移動）。非常停止中は目標を保存しない（解除後は次の指令まで停止のまま = 従来挙動維持）。
- ウォッチドッグは tick 内の経過時間チェックに統合（100 ms タイマーを廃止）。判定は新設の純粋関数 `drive_control_tick::decideTickAction`（kIdle / kTimeoutStop / kFaultStop / kDrive）に集約し、タイムアウト境界は従来の `shouldTimeoutStop` と同一。
- `drive_slew` 系の呼び出しは tick 内で dt = 1/control_rate の定数に。**パラメータの意味は不変**（[単位/s] のまま）だが、実効挙動が joy レート非依存になる。
- 挙動変化として明示するもの: 指令送信が joy 到着時 → 固定 50 Hz になる（DualShock 時は送信頻度が 20→50 Hz に増える。DDT は周期指令前提のプロトコルなので問題ない見込みだが、実機で確認する）。tick 所要時間が周期予算を超えた場合は "Control tick overrun" 警告を出す（実機での control_rate 選定の材料）。
- 検証: `test_drive_slew` 等は不変。`test_drive_control_tick` を追加（判定マトリクス・タイムアウト境界・dt フォールバック）。実機でチューニング済みフィーリングの回帰確認が残タスク。

### Phase 2: シリアルバスの単一利用者化（観測経路の統合）— 実装済み（本ブランチ、実機計測待ち）

- `statusTimerCallback` から `refreshMotorFeedback` 呼び出しを削除した。tick の指令応答で得たフィードバック快照を publish するだけになり、シリアルバスの利用者は制御 tick の1箇所になった。
- 未武装（アイドル）中の観測は tick 内の低頻度ポーリング（鮮度 0.2 s、≈5 Hz）に一本化。外力で車輪が回された場合の観測と `/drive_status` の鮮度を維持しつつ、従来の 50 Hz ステータスタイマー由来の再送より頻度を下げた。停止再送は従来どおり `stop_resend_interval_ms` スロットル経由（既定 0 の見直しは §7 未解決論点のまま）。
- 検証（実機）: バス上のフレーム頻度が「tick × 2 モータ」のみになることをログで確認。tick の実測所要時間（正常 ≈ 7 ms / 最悪 20 ms）を overrun 警告で観測し、50 Hz 予算 20 ms に収まらない場合のみ Phase 2b（I/O 専用スレッド + 指令メールボックス）へ進む。**スレッド化は計測が必要と示すまでやらない**。

### Phase 3: ControlCore 抽出 + 閉ループシミュレーションテスト — 実装済み（本ブランチ）

- `motor_control_app` に純粋な `control_core.hpp` を新設し、スルーレート（`drive_slew`）→ 運動学 → 停止ヒステリシス（`drive_stop_gate`）の合成と、その状態（前回指令 + 停止モード）を 1 つのオブジェクトに閉じ込めた。`drive_component` は「ROS I/F + ControlCore + シリアル」だけになった。
- 運動学の変換式を `motor_control_lib/differential_kinematics.hpp` の純粋関数へ抽出し、`DifferentialDrive` も委譲するようにした（変換式の単一ソース）。旧インライン式との等価性は 15.8 万点でビット単位一致を確認。併せて `wheel_radius <= 0` で `inf`（`lround(inf)` は未定義動作）を返していた箇所にガードを入れた。
- `DifferentialDrive` に `setWheelRpm`（生の車輪 RPM 送信）と public な `commandStop` を追加し、制御コアの判定結果を送る経路を分けた。停止判定の状態機械が二重に走らないよう、通常経路は制御コアの判定のみを使う。
- **閉ループテストの導入が本命**（`test_control_core`、13 ケース）: ファーム速度ループの簡易プラントモデル（一次遅れ + 低 RPM 域の減衰不足を模した 1.8 Hz 振動 + 量子化）を test 内に置き、以下を CI で回帰チェックする。
  - 目標更新レート（50 / 25 / 10 Hz）を変えても固定周期 tick の指令列が完全一致する（Phase 1 の不変条件）
  - フルスティック旋回・前進の整定時間と、デマンド適応 / テーパーそれぞれの寄与（§3.1 の表がそのまま期待値）
  - 低速不感帯と停止ヒステリシス（閾値保持でトグルしない）
  - 減速から停止到達（0.8 秒）と、停止/走行間のリミットサイクルが起きないこと
  - リセット後は 0 からのランプで再開すること
  - 不安定動作点ではホスト指令が一定でも実測が振動すること（§3.2）
- 副産物: このシミュレーションが**提案書 §3.1 の手計算の誤り（2.9 秒 → 実測 2.44 秒）を検出した**。PR #141 型の「実機でしか検証できない」の解消が目的だったが、机上検算の検証にも効いている。
- パラメータ整理（P3 の解消）は**未実施**: 固定 dt になった時点でデマンド適応（`min_*_accel` / `accel_demand_ref_*`）の存在理由の一部（メッセージレート依存の平滑化）が消えるため、`max_*_accel` + `slew_taper_band_*` の 2 軸へ縮退できるか実機 A/B で判断する。縮退できるなら deprecated を経て削除する。フィーリング要件の判断が要るので実機確認後に回す。

### Phase 4: 車体速度閉ループ（必要性が実測されたら）

- ControlCore 内に (v, ω) の PI（ファーム速度ループへのトリム出力）を追加。tick ごとの実測フィードバック（Phase 2 で 50 Hz 化済み）を入力とする。積分リセットはモード遷移・停止・フィードバック timeout で行う（checklist「Control-loop state」準拠）。
- 前提: Phase 1–3 完了。Phase 3 のプラントモデルでゲインの初期値を決めてから実機に持ち込む。

### Phase 5: 指令調停と安全の一元化（別トラック、任意）

- `/target_twist` の publisher が増える時点で調停ノード（`twist_mux` 相当）を入れる。それまでは着手しない。
- 非常停止は現行の「operation_manager が発行、各ノードが購読して各自停止」を維持する（分散購読は defense in depth として妥当）。実装単一ソース化は契約テストの追加（`questix_msgs/README.md` の機械化）で代替する。

---

## 6. やらないこと（non-goals）

- トピック名・ノード分割・launch 構成の変更（`/target_twist` の rename を含む）。
- ファームウェア側の変更。`accel_time` は実機検証済みの 1 に固定のまま。
- nav2 / 自律走行対応の先回り実装（Phase 5 の調停はトリガー条件を満たすまで凍結）。
- 最初からのスレッド化・エグゼキュータ変更。MutuallyExclusive 直列は Phase 2 までむしろ前提として活用する。

## 7. 未解決の論点

1. `stop_resend_interval_ms` は「停止直後のリミットサイクル対策」として導入されたのに現 YAML では 0（無効）。導入時の rosbag 解析と現設定が矛盾しており、実機で 0 / 200 の A/B が必要。**制御 tick 導入後は 0 のままだと停止再送が 50 Hz で走る**（従来は joy レート）ため、優先度が上がった。
2. Phase 1 で DualShock 時の指令送信が 20→50 Hz に増えることの実機影響（DDT M0602C の最小コマンド間隔要件は未確認。`command_wait_ms` が保険として存在）。
3. 旋回動作点の不安定域問題（§3.2）はアーキテクチャでは解けない。(a) 機構側の見直し、(b) current モード整備、(c) 指令整形のどれを選ぶかは実機計測（不安定域の上限 RPM の同定）が先。
4. デマンド適応の縮退可否（Phase 3）。フィーリング要件が「ゆっくり倒したら穏やか」を本当に要求しているなら、残差ベースではなく入力微分ベースの整形に置き換える選択肢もある。
