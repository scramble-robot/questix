# 走行制御アーキテクチャ リファクタリング提案

対象: `joy_controller` → `drive_component` → `DifferentialDrive` → `DdtMotorLib` の走行制御経路
きっかけ: PR #141（`fix: enhance motor control parameters and improve drive responsiveness`、19 files / +861 -68 / 16 commits）
状態: 設計提案（コード変更は含まない）

改訂メモ: 初版の分析をコードベースに対して検証した改訂版。主要な主張（P1〜P6）は
現ファイルの内容と一致することを確認済み。以下を修正・追記した。

- 旋回の到達時間を 2.0 秒 → **約 2.9 秒**に修正（デマンド適応の下限とテーパーの尾を含む検算。§3.1）。
- 「旋回指令の全域が不安定域」→「**大半が実測された不安定域と重なる**」に修正（フルスティック ≈ 143 RPM。§3.2）。
- P2 のシリアル負荷見積りを精密化（`refreshMotorFeedback` の鮮度ゲートとアイドル時再送。§2 P2）。
- 新規発見: `declare_parameter` デフォルトと `launcher/config/drive_component.yaml` の**乖離 5 件**（§2 P8、Phase 0）。
- P7（観測遅れ）の本文を補完。
- §4 以降（あるべき構成・移行計画・検証戦略）を追加。

---

## 0. 結論（先に3行)

1. 現状の限界は「制御層が無い」ことではなく、**制御が3層に分散したまま、制御周期そのものが存在しない**ことにある。`twistCallback` が制御ステップを兼ねているため、制御周期 = joy の到着間隔（DualShock 20 Hz / UART 50 Hz）になっている。
2. `control_module` を入れる方向性は正しい。ただし最初に入れるべきは PI や新しい制御則ではなく、**固定周期ループ**と**シリアル I/O の制御パスからの分離**である。この2つを入れないと、どんな制御則もチューニングが再現しない。
3. `target_twist` に追従できない件は、**実機だけの問題ではない**。現在のパラメータでは、フルスティックの角速度指令 6.0 rad/s への整定に設計上**約 2.9 秒**かかる（レート上限 3.0 rad/s² のランプ 1.8 秒 + デマンド適応下限 0.15 rad/s² とテーパーによる尾 約 1 秒。検算は §3.1）。加えて旋回指令の車輪 RPM（0〜約 143 RPM）の大半がファーム速度ループの実測不安定域（目標 95 RPM で 59〜118 RPM を約 1.8 Hz で往復）と重なる。実機なしで検算・切り分けできる部分が残っている。

---

## 1. 現状の責務配置

コード上の実態を層ごとに並べる（推測ではなく現ファイルの内容）。

| 層 | ファイル | 実際に持っている責務 |
|---|---|---|
| 入力 | `joy_controller/src/joy_controller_component.cpp` | 軸 → `Twist` の線形写像のみ。`/target_twist` を joy 受信ごとに publish |
| ゲート | `joy_gate/src/joy_gate_component.cpp` | `/gpio/controllable` による joy 遮断 |
| ノード | `motor_control_app/src/drive_component.cpp` | Lifecycle、auto_start リトライ、非常停止購読、**スルーレート/デマンド適応/テーパー**、コマンドウォッチドッグ、`/drive_status` publish、**オドメトリ積分 + TF**、パラメータ（37 個） |
| 運動学 | `motor_control_lib/src/differential_drive.cpp` | twist ↔ 左右 RPM 変換、**停止/走行ヒステリシス状態機械**（`stop_mode_`）、`min_command_rpm` 不感帯 |
| デバイス | `motor_control_lib/src/ddt_motor_lib.cpp` | シリアル fd、プロトコル送受信、リトライ、**電流モード PI**、**実測 RPM ローパス**、**停止再送スロットル**、ブレーキ、ファーム `accel_time`、最終フレーム保持 |

「制御」に相当するロジックは `drive_slew`（ホスト側加減速）、`drive_stop_gate`（停止判定）、`ddt_current_pi`（電流 PI）、`DdtMotorLib::setMeasuredLowpassTau`（平滑化）の4箇所に分かれ、それぞれ別の層にある。

純粋関数として切り出しテストされているのは良い（`test_drive_slew`, `test_drive_stop_gate`, `test_ddt_current_pi`, `test_drive_watchdog`）。しかし**それらを組み合わせた閉ループ挙動をテストする場所がどこにも無い**。だから PR #141 は実機で試す以外に検証手段がなく、16 コミット・パラメータ十数個の追加になった。これは実装者の問題ではなく構造の帰結である。

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

つまり**単体 launch と統合起動で走行フィーリングが違う**。さらに `drive_component.hpp` のクラス内デフォルト（`brake_on_stop_{true}`, `accel_time_0p1ms_per_rpm_{50}`, `min_command_rpm_{8}`, `stop_resend_interval_ms_{200}`, `slew_taper_band_*{0.15/0.3}`）は `readParameters()` で必ず上書きされるデッド値だが、3 種類目の「デフォルトらしき値」としてコードを読む人を誤導する。AGENTS.md の defect-prevention checklist「Single source of truth for defaults」の違反そのものであり、Phase 0 で先に潰す（§5）。

---

## 3. 実機なしでできる検算と切り分け

### 3.1 フルスティック旋回の整定時間 ≈ 2.9 秒（設計値）

現 YAML（`angular_input_ratio: 6.0`, `max_angular_accel: 3.0`, `min_angular_accel: 0.15`,
`accel_demand_ref_angular: 0.5`, `slew_taper_band_angular: 0.2`）でのステップ応答:

1. **残差 ≥ 0.5 rad/s の区間**（0 → 5.5 rad/s）: `demandScaledAccel` は max に張り付き 3.0 rad/s² の一定ランプ。**約 1.83 秒**。
2. **残差 0.5 → 0.2 rad/s**: 加速度が 3.0 → 1.29 rad/s² へ線形に低下。**約 0.15 秒**。
3. **残差 < 0.2 rad/s（テーパー帯）**: ステップ上限が残差比例で縮み、かつデマンド適応が加速度を min 0.15 rad/s² へ引き下げる。二重の絞りで実効時定数は終端付近で `taper_band / min_accel ≈ 1.3 秒`まで伸びる。車輪 RPM の量子化（1 RPM ≈ 0.042 rad/s）以内に入るまで**約 0.9 秒**。

合計 **約 2.9 秒**。「レート上限 6.0/3.0 = 2.0 秒」は楽観値で、実際の設計値はデマンド適応の下限が尾を引いてさらに 5 割増しになる。「追従が遅い」体感のうちこの分は実機なしで説明がつき、ファームや通信を疑う前に切り分けられる。

副作用の指摘: デマンド適応（`min_angular_accel`）は「ゆっくり倒したとき穏やかに」が目的だが、**ステップ入力の終端でも同じ絞りが掛かる**。目的（入力の丁寧さに応じた応答）と手段（残差の大小で加速度を変える）が一致しておらず、残差は「入力の丁寧さ」と「追従の遅れ」を区別できない。これは P3 の非直交性の具体例。

### 3.2 旋回指令の車輪 RPM は大半が実測不安定域

旋回のみのフルスティックで車輪 RPM = ω·(wheel_separation/2)/(2π·wheel_radius)·60 = 6.0 × 0.25 / 0.628 × 60 ≈ **143 RPM**。実機ログでは目標 95 RPM 一定で実測 59〜118 RPM が約 1.8 Hz で振動し「低速側はさらに悪化」（YAML コメント）。つまり旋回指令のレンジ 0〜143 RPM のうち、少なくとも半分以上が実測済みの不安定域に入り、フルスティックでもその 1.5 倍以内にとどまる。**「旋回が安定しない」のはチューニング不足である前に、動作点の選定の問題**。`min_command_rpm: 5` では旋回レンジの下端しか除外できていない。

### 3.3 切り分けの含意

- 追従遅れの一部（〜2.9 秒）はホスト側パラメータの設計値であり、実機なしで再現・修正評価できる。
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

### Phase 0: デフォルトの単一ソース化（実機不要・リスク極小）

- §2 P8 の乖離 5 件を解消する。`launcher/config/drive_component.yaml` を正として `declare_parameter` を合わせる（YAML が実機チューニングの結果であるため）。
- `drive_component.hpp` のクラス内初期化子を `declare_parameter` と同値に揃える（またはコメントで「宣言側が正」と明記）。
- 検証: 既存テスト + `ros2 param dump` の比較手順を YAML コメントに追記。

### Phase 1: 固定周期制御ループ（意味論の最小変更で dt を固定化）

- `control_rate` パラメータ（既定 50.0）と制御 tick タイマーを追加。
- `twistCallback` は目標値と受信時刻の保存のみに縮退（シリアル送信・スルーレート計算を tick へ移動）。
- ウォッチドッグは tick 内の経過時間チェックに統合（100 ms タイマーを廃止）。
- `drive_slew` 系の呼び出しは tick 内で dt = 1/control_rate の定数に。**パラメータの意味は不変**（[単位/s] のまま）だが、実効挙動が joy レート非依存になる。
- 挙動変化として明示するもの: 指令送信が joy 到着時 → 固定 50 Hz になる（DualShock 時は送信頻度が 20→50 Hz に増える。DDT は周期指令前提のプロトコルなので問題ない見込みだが、実機で確認する）。
- 検証: `test_drive_slew` 等は不変。tick パイプライン（保存→slew→送信判断）を純粋関数化してユニットテスト追加。実機でチューニング済みフィーリングの回帰確認。

### Phase 2: シリアルバスの単一利用者化（観測経路の統合）

- `statusTimerCallback` から `refreshMotorFeedback` 呼び出しを削除。tick の指令応答で得たフィードバック快照を publish するだけにする。
- 停止継続中のフィードバック更新は tick 内の停止再送（既存 `stop_resend_interval_ms` スロットル経由）に一本化。`stop_resend_interval_ms` の既定を 0 から実機検証値（例 200）へ見直す（§7 未解決論点）。
- 検証: バス上のフレーム頻度が「tick × 2 モータ」のみになることをログで確認。tick の実測所要時間（正常 ≈ 7 ms / 最悪 20 ms）を計測し、50 Hz 予算 20 ms に収まらない場合のみ Phase 2b（I/O 専用スレッド + 指令メールボックス）へ進む。**スレッド化は計測が必要と示すまでやらない**。

### Phase 3: ControlCore 抽出 + 閉ループシミュレーションテスト

- `motor_control_app` に純粋な `control_core.hpp` を新設し、slew / stop gate / （current モードの）PI 呼び出しの合成を移す。`drive_component` は「ROS I/F + ControlCore + シリアル」だけになる。
- **閉ループテストの導入が本命**: ファーム速度ループの簡易プラントモデル（一次遅れ + 低 RPM 域の減衰不足を模した二次振動 + 量子化）を test 内に置き、「フルスティック旋回の整定時間」「停止時のリミットサイクル有無」「20/50 Hz 入力での挙動同一性」を CI で回帰チェックする。PR #141 型の「実機でしか検証できない」を構造的に解消する。
- パラメータ整理（P3 の解消）: 固定 dt になった時点でデマンド適応（`min_*_accel` / `accel_demand_ref_*`）の存在理由の一部（メッセージレート依存の平滑化）が消えるため、`max_*_accel` + `slew_taper_band_*` の 2 軸へ縮退できるか実機 A/B で判断し、縮退できるなら deprecated を経て削除する。

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

1. `stop_resend_interval_ms` は「停止直後のリミットサイクル対策」として導入されたのに現 YAML では 0（無効）。導入時の rosbag 解析と現設定が矛盾しており、実機で 0 / 200 の A/B が必要。
2. Phase 1 で DualShock 時の指令送信が 20→50 Hz に増えることの実機影響（DDT M0602C の最小コマンド間隔要件は未確認。`command_wait_ms` が保険として存在）。
3. 旋回動作点の不安定域問題（§3.2）はアーキテクチャでは解けない。(a) 機構側の見直し、(b) current モード整備、(c) 指令整形のどれを選ぶかは実機計測（不安定域の上限 RPM の同定）が先。
4. デマンド適応の縮退可否（Phase 3）。フィーリング要件が「ゆっくり倒したら穏やか」を本当に要求しているなら、残差ベースではなく入力微分ベースの整形に置き換える選択肢もある。
