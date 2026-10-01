# QUESTiX Blockly

QUESTiXをブロックで操作する、任意で起動できるROS 2パッケージです。
前進・後退・左右回転・待機・くり返しに対応し、ROSの位置と軌跡をブラウザとRVizに表示します。
操作元はBlockly／ゲームコントローラーから選択できます。

現在は**デスクトップシミュレーション専用**です。実機ドライバー、自動起動サービス、
既存の実機launchは変更しません。実機用の停止解除や制御権切替には使用しないでください。

## ビルド

ROS 2 Jazzy、C++17、Node.js 22.12以上（推奨24）が必要です。
以下はQUESTiXを `~/robot_ws/src/questix` に置いた例です。実際の配置に読み替えてください。

```bash
source /opt/ros/jazzy/setup.bash
cd ~/robot_ws
rosdep install --from-paths src --ignore-src -r -y

cd src/questix/questix_blockly/web
npm ci
npm test
npm run build

cd ~/robot_ws
colcon build --packages-up-to questix_blockly
source install/setup.bash
```

フロントエンドの依存は `package-lock.json` で固定します。`colcon` はnpmやネットワーク
取得を自動実行しません。Webをビルドしなくても既存のROSビルドは継続できますが、
Blocklyの起動には `web/dist` の生成後にこのパッケージを再ビルドする必要があります。
`node_modules`・`dist`・ビルド済み共有ライブラリはGitへ追加しません。

## 起動

```bash
ros2 launch questix_blockly simulation.launch.py
```

[Blockly画面](http://127.0.0.1:5174/)とRVizで同じシミュレーションを操作します。
サンプルは「前進→待機→左回転→待機」を4回繰り返します。緑の旗で実行し、赤いボタンで停止。
変更はブラウザへ自動保存されます。終了は起動ターミナルでCtrl+Cです。

```bash
# GUIや物理コントローラーがない環境
ros2 launch questix_blockly simulation.launch.py rviz:=false controller:=false
# 独立した検証用インスタンス（ポートとdomainの両方を分ける）
ros2 launch questix_blockly simulation.launch.py domain:=79 port:=5175 rviz:=false controller:=false
```

既定はlocalhost限定、ROS domain 75、HTTPポート5174です。旧試作版や単独RViz版が
同じdomainで動いている場合は、先にその起動ターミナルでCtrl+Cしてください。
同一domainへ複数のシミュレーターを起動しないでください。ポート競合は起動前に検出します。
ブラウザの開発だけなら `web/` で `npm start` を使えますが、開発サーバーからのROS実行は無効です。

| launch引数 | 既定値 | 意味 |
|---|---|---|
| `rviz` | `true` | RVizも起動 |
| `controller` | `true` | SDLゲームコントローラーを起動 |
| `controller_name` | `Generic X-Box pad` | SDLのデバイス名 |
| `domain` | `75` | このシミュレーションのROS domain |
| `port` | `5174` | localhost HTTPポート |
| `model_yaw` | `1.5707963267948966` | CADモデルの見た目のみの向き補正（rad） |

## 操作と制限

- 前進・後退は最大0.8 m/s、回転は最大85度/秒、各動作は0.1〜10秒。
- 1回の実行は最大200動作・合計120秒。手順生成はWeb Workerで5秒以内に制限。
- 秒数による開ループ操作です。加減速やRPMの丸めにより、距離・角度は厳密ではありません。
- 制御コアは `motor_control_app` と `motor_control_lib` の本体コードを使用します。
  車輪は指令へ理想的に追従します。摩擦、衝突、センサー、実モーターの応答は再現しません。
- 文字表示・条件評価は動作列を生成する段階で行います。センサーに応じた実行中の分岐は未対応です。
- 操作元切替時は停止し、実行中の動作列を破棄します。コントローラーは中央位置でAを押して開始、Bで停止。
- Blockly通信が1.2秒、コントローラー入力が0.5秒、位置情報が0.7秒途切れると停止。
  通信復帰だけでは再開しません。これらはシミュレーション用の制御で、実機の安全機構ではありません。

## 構成

```text
web/                         Blockly画面・ブロック定義・生成器・npmテスト
scripts/bridge.py            HTTP動作列受付、操作元切替、Joy変換
scripts/drive_sim.py         ROS位置・TF・軌跡と模擬GPIO
scripts/differential.py      設定読み込み・C++コアへの接続
src/control_bridge.cpp      本体の制御コアへの薄いC ABIアダプター
launch/simulation.launch.py 任意起動用launch（実機起動から独立）
config/questix.rviz          RViz表示設定
test/                       制御テストと起動中の結合検証
```

入力経路は `/blockly/controller_joy` またはBlockly → bridge → `/joy` →
既存 `joy_gate` → `joy_controller` → `/target_twist` → simulator → `/odom`。
操作許可は既存の `operation_manager` を通します。

車輪の寸法は `questix_launcher/config/drive_component.yaml`、加速度・RPM上限・Joy倍率などの操作設定は
`questix_control_config/config/controls.uart.yaml`（パッケージの初期値）、モデルは `description_launch` から取得します。
共有ライブラリ・画面はインストール先から取得し、外側の試作ディレクトリやユーザー固有パスには依存しません。

## 検証

```bash
colcon test --packages-select questix_blockly
colcon test-result --verbose
# web/ で
npm test
npm run build
```

起動中・操作元Blockly・停止中に実際のHTTP→ROS経路を検証できます。
この検証はシミュレーターを動かし、終了時は停止させます。

```bash
python3 src/questix/questix_blockly/test/check_running.py
# 別ポートで検証する場合
QUESTIX_BLOCKLY_URL=http://127.0.0.1:5175 python3 src/questix/questix_blockly/test/check_running.py
```

既存ROS CIはこのパッケージのC++ビルドとPythonテストを実行します。
`.github/workflows/blockly-web.yaml` はnpm依存取得・ブロック生成テスト・画面ビルドを検証します。
