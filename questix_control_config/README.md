# QUESTiX 操作設定

Joy のキー割り当てと速度調整は、コントローラーごとに `config/controls.uart.yaml`（UART / Switch）、
`config/controls.dualshock.yaml`（DualShock）、`config/controls.web.yaml`（Web：ブラウザ・スマホ、
`web_joy_driver`）にまとめています。走行、射出、ローラーが同じファイルを
読み、ROS のノード名ごとのセクションを使用します。シリアルポート、GPIO、非常停止、
ライフサイクル、モータ制御ループの設定は各パッケージの YAML に残ります。

## 編集・反映

robot_manager の「調整」タブでコントローラーを選び、値を編集して保存します。
保存先は `${QUESTIX_CONFIG_DIR:-/etc/questix_robot}/controls.<controller>.yaml` です。
保存は実行中のロボットには反映されません。安全に停止できる状態でロボットを再起動してください。
管理画面の「初期値に戻す」はフォームだけを戻し、「操作設定を保存」で確定します。
「実行中の値を取得」で ROS ノードの値を読み取り、保存済み・変更後の値と比較できます。
実行中の列は取得時刻のスナップショットで、設定の書き換えは行いません。
ノード停止中や ROS 未導入の場合は取得不可を表示します。

編集対象の選択と、Launch 設定の `CONTROLLER_TYPE`（実際に使用するコントローラー）は
別です。UART 用・DualShock 用・Web 用の調整は互いに上書きされません。

`controller_type` は `uart` / `dualshock` / `web` のいずれかです（それ以外は起動前にエラー）。

起動時の選択優先順位:

1. `control_config_file:=/absolute/path/to/controls.yaml` で指定したファイル。
2. 設定ディレクトリに保存済みの、`controller_type` に対応するファイル。
3. このパッケージにインストールされた同コントローラーの初期値。

保存済みプロファイルは全項目を保持するため、再ビルドでも調整値は維持されます。
各ノードのハードウェア YAML の後に操作設定を読み、その後に launch の `joy_topic`
指定を適用します。GPIO ゲートの選択は操作設定で上書きされません。
`config_file` はハードウェア側、`control_config_file` は操作側の変更に使用してください。

通常の統合起動に加え、Joy / 射出 / ESC / 走行 / UART / Web の単体 launch も同じ設定を選びます。
ROS ノードを `ros2 run` で直接起動する場合は、このファイルを `--params-file` で明示してください。
独自ノード名を使う場合は、YAML のセクション名も一致させる必要があります。

## 調整項目

- `joy_controller`: 前後・左右・旋回の軸番号と速度。符号で方向を反転します。
  左右速度は全方向移動用で、標準の差動駆動では使用しません。
- `drive_component`: 車輪の最大 RPM、加速度、目標付近の緩和幅、低速不感帯。
  `max_motor_rpm` は M0602C の指令上限 475 以下、`min_command_rpm` はその値未満です。
- `shot_component`: 射出ボタン、射出角度を上げる入力・下げる入力。
  図の「上げる」「下げる」から別々に選べます（例：上げる＝十字キー上、下げる＝B）。
  `tilt_up_axis` / `tilt_down_axis` は方向ごとの軸番号で、-1 の場合だけ対応する
  `tilt_up_button_index` / `tilt_down_button_index` を使います。
  軸操作時の `tilt_up_axis_sign` / `tilt_down_axis_sign` は +1 が正方向、-1 が負方向です。
  初期値は十字キー上／下。同一入力の重複割り当ては拒否し、上下同時押しでは動かしません。
  従来の `tilt_axis` 形式は管理画面で読み込む際に上下それぞれへ変換し、保存時に新形式になります。
  ノードも旧形式を受け付けます（新しい軸パラメータが未指定、内部値 -2 の場合のみ継承）。
  この変更を使うには `motor_control_app` を再ビルドし、robot_manager を更新してください。
- `esc_motor_control`: ローラー回転ボタンと出力（0〜1）。出力は実測 RPM ではありません。
- `joy_node` / `uart_joy_driver`: 入力ドライバのスティック不感帯（UART・DualShock 用ファイルのみ）。
- `web_joy_driver`: ブラウザのスティックの不感帯（Web 用ファイルのみ）。ポート・認証・タイムアウト・カメラなどは
  `web_joy_driver/config/web_joy_driver_params.yaml` に残ります。
- `joy_controller_dual_stick` / `joy_axis_drive`: それぞれの単体起動モード専用。
  通常の統合起動には影響しません。dual-stick の速度スケールは従来どおり 0.05 です。

軸・ボタン番号は 0 始まりです。管理画面の範囲は 0〜63（一部の無効指定は -1）ですが、
実際の配列長はコントローラーごとに異なります。受信メッセージの範囲外ならノード側で
参照をスキップします。DualShock の配列は接続方式等により異なるため、実機で確認してください。

### 加速度の調整

`max_linear_accel` と `max_angular_accel` は追従の速さを決めます。0 は制限なしです。
M0602C の低 RPM 域では、旋回加速度を上げると振動が再発することがあるため、
既定の 3.0 から段階的に調整します。`slew_taper_band_*` は目標速度付近の加速変化を
緩和する幅で、0 は無効です。幅を大きくすると目標への収束は緩やかになります。
`min_command_rpm` を大きくしすぎると、低速旋回ができなくなります。
詳細な実機評価の経緯は `design/drive_control_refactor.md` を参照してください。

### Web（ブラウザ・スマホ）用の設定

`web_joy_driver` の操作画面は「移動」カード（左スティック＝軸 0/1、右スティック＝軸 3/4）と
「ショット」カード（TILT ▲＝ボタン 4、FIRE＝ボタン 5、TILT ▼＝ボタン 6、ROLLER＝ボタン 7）だけを送ります。
十字キーがないため、`controls.web.yaml` の初期値は射出角度を TILT ▲ / ▼ ボタンで操作します
（`tilt_up_axis` / `tilt_down_axis` = -1）。UART 用の設定（十字キー上下）をそのまま使うと角度調整が効きません。
管理画面の Web 用の操作図は、この画面の操作名（TILT ▲・FIRE など）で表示します。
キーボード操作（I / F / K / R、W A S D、Q / E）も同じ番号を送るため、同じ設定が適用されます。

## 既存設定からの移行

- 各パッケージのキー割り当て・速度項目を本パッケージに移しました。
  既存の独自 YAML に書いていた調整値は、共通プロファイルの対応項目へ移してください。
- 重複していた `shot_config.uart.yaml` / `shot_config.dualshock.yaml` と
  `esc_motor_control_cpp.uart.yaml` / `esc_motor_control_cpp.dualshock.yaml` は廃止しました。
  ハードウェア設定はそれぞれ `shot_config.yaml` / `esc_motor_control_cpp.yaml` に統一しました。
- `shot_component.launch.xml` の `fire_button` 引数は廃止しました。共通プロファイルを使用します。
- dual-stick の XML 起動時のノード名を `/joy_controller_dual_stick` に統一しました。
  `/joy_controller` を対象にしていた dual-stick 用の監視・パラメータ設定は変更してください。
- 新パッケージを含めてワークスペースをビルドし、robot_manager も更新してください。
  管理画面は `launch.env` の `ROBOT_WS` にあるインストール済み初期値を読みます。
  ソース YAML と保存済み YAML の両方を編集する必要はありません。

`QUESTIX_CONFIG_DIR` を変更する開発環境では、robot_manager と ROS launch の両方に
同じ値を指定してください。通常のサービス起動は双方とも `/etc/questix_robot` を使用します。
