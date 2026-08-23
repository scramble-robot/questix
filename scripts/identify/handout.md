# 講義ハンドアウト：ロボットの「くせ」を測る — ステップ応答とシステム同定（1 コマ）

**ねらい**：指令どおりに車輪が回らない「遅れ」を実測し、一次遅れモデル $\omega_{k+1}=a\,\omega_k+(1-a)\,u_{k-d}$ の時定数 τ とむだ時間 d を自分のロボットで求める。結果は QUESTiX の制御パラメータ改善に使われる（みんなのデータを集めると床・個体のばらつきが分かる）。

## 0. 準備（5 分）
- ロボットを**ジャッキアップして車輪を浮かせる**（床の上でやる場合は先生の指示で、広い場所・短い列）。
- 非常停止が効くことを確認。電池電圧をメモ（表示 or テスタ）。
- 端末 2 つ：① `ros2 launch questix_launcher ...`（いつもの起動）、② 記録用。

## 1. 記録（5 分）
端末②で：
```bash
cd ~/questix   # リポジトリの場所
bash scripts/identify/record.sh
```
聞かれたら入力：ロボット ID（機体のラベル）、床（`lifted` など）、電池電圧、積載、メモ。
Enter で開始 → 車輪が 20〜400 rpm を段階的に正転・逆転する（約 2.5 分）。**手を近づけない**。
終わると `~/ident_data/ident_<ID>_<床>_<日時>/` ができる（`meta.yaml` と `bag/`）。

## 2. 自分のデータを見る（10 分）
```bash
python3 scripts/identify/batch_fit.py ~/ident_data/ident_* --out ~/ident_data/results
```
- `results/summary.md`：τ [ms]、むだ時間 d [tick]、レベル別の当てはまり R²。
- `results/summary.png`：左 = レベル別 τ、右 = レベル別 R²。

**見るポイント**
1. 高い回転数では R² ≈ 1 に近く、τ はほぼ一定 → 一次遅れで表せる領域（RUN）。
2. 低い回転数で R² が落ちる／τ がばらつく → 振動していて一次では表せない領域（CREEP）。境界の回転数が `run_enter` として出る。
3. 左右で τ が違うか？ 正転と逆転で違うか？（`summary.png` の実線＝左、破線＝右）

## 3. 考えてみる（10 分、ワークシート）
- τ が 0.1 s のとき、指令を変えてから 63 % 追いつくまで何秒か。50 Hz 制御では何ステップか。
- むだ時間 d が 1 tick あるのはなぜか（RS-485 の 1 問 1 答通信を思い出す）。
- 低回転で一次遅れが当てはまらない理由を 2 つ挙げよ（ヒント：摩擦、量子化）。
- 「モデルが当てはまる領域だけにモデルベース制御（LQR）を使う」という設計判断をどう思うか。

## 4. 提出（2 分）
`~/ident_data/ident_*` フォルダ（bag/ と meta.yaml）をそのまま共有フォルダ／USB へ。数 MB。
運営は `batch_fit.py` で全員分をまとめ、`sufficiency.md` で「どの条件のデータが足りているか」を判定して、順次 `launcher/config/drive_component.yaml` の `velocity_run_*` / `drive_fsm_run_*` を更新する。

---
背景資料：`design/model_based_drive_control.md`（計画）、`~/workspace/mpc_study/README.md` 5.4 節（LQR+FF）
