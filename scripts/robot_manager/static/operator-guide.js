/* QUESTiX operator-facing messages and conservative runtime comparisons. */
const OperatorGuide = (() => {
  function failure(path, status, detail = '') {
    const service = path.startsWith('/api/service/');
    const title = service ? 'ロボットの操作を完了できませんでした'
      : path.includes('/control-runtime') ? '実行中の設定を確認できませんでした'
      : path.includes('/rosbag/start') ? '記録を開始できませんでした'
      : path.includes('/logs/') ? '診断ログを保存できませんでした' : '操作を完了できませんでした';
    let next = '少し待ってからもう一度試してください。続く場合は診断ログを保存して担当者に相談してください。';
    let panel = 'log';
    if (!status) {
      next = 'ロボットと同じネットワークにつながっているか確認してください。保存や起動が完了したかは再接続後に確認してください。';
      panel = 'control';
    } else if (status === 403) {
      next = '書き込み・操作の権限が不足しています。キッティング担当者に設定や保存先の権限を確認してもらってください。';
      panel = 'admin';
    } else if (status === 409) {
      next = path.includes('/control-config/')
        ? '別の画面で設定が更新されました。変更内容を控え、「保存した設定を読み直す」を押してから編集し直してください。'
        : '別の処理が進行中か、現在の状態では実行できません。状態を確認してから再試行してください。';
      panel = path.includes('/control-config/') ? 'tuning' : 'control';
    } else if (status === 422 || status === 400) {
      next = '入力値や選択内容を確認してください。詳しい内容は下の「詳細」に表示しています。';
      panel = path.includes('/control-config/') ? 'tuning' : path.includes('/logs/') ? 'log' : 'admin';
    } else if (status === 507) {
      next = '記録用ディスクの空き容量が不足しています。必要な記録を退避してから、不要な記録データを削除してください。';
      panel = 'rec';
    } else if (status === 504) {
      next = service
        ? '処理が時間内に終わりませんでした。操作が続いている可能性があるため、現在の状態を確認してください。'
        : '応答がありません。ロボットの起動状態と接続を確認してから再試行してください。';
      panel = 'control';
    } else if (status === 404) {
      const missingFeature = /^\/api\/(readiness|control-runtime|control-config\/[^/]+)$/.test(path);
      next = missingFeature
        ? 'この機能はまだ使えません。担当者に管理画面のプログラムの更新・再起動を確認してもらってください。'
        : '対象が見つかりません。画面を再読み込みして、対象のデータや保存先が存在するか確認してください。';
      panel = missingFeature ? 'admin' : path.includes('/rosbag/') ? 'rec' : 'log';
    } else if (/ROS|ROBOT_WS|共通設定/.test(detail)) {
      next = '機体の準備が完了していない可能性があります。担当者にワークスペースとROS環境を確認してもらってください。';
      panel = 'admin';
    }
    return { title, next, panel, detail: `要求先: ${path}\n応答: ${status ? `HTTP ${status}` : '通信エラー'}\n${detail || '応答を受け取れませんでした。'}` };
  }

  function application(profile, draft, snapshot, launchController, now = Date.now()) {
    if (!profile) return { kind: 'unknown', title: '設定を読み込んでください', note: '保存状態はまだ確認できていません。' };
    let changed = 0;
    for (const [node, fields] of Object.entries(profile.values)) {
      for (const [key, value] of Object.entries(fields)) {
        if (draft?.[node]?.[key] !== value) changed++;
      }
    }
    if (changed) return { kind: 'pending', title: `未保存の変更: ${changed} 項目`, note: 'まだロボットには反映されません。「操作設定を保存」で確定します。' };
    if (launchController && launchController !== profile.controller) {
      return { kind: 'unknown', title: '別のコントローラー用の設定です', note: '次回起動用に選択されているコントローラーと異なります。管理設定で確認してください。' };
    }
    const age = now - Date.parse(snapshot?.captured_at);
    if (!snapshot || !Number.isFinite(age) || age < 0 || age > 30000) {
      return { kind: 'unknown', title: '保存済み・実行中は未確認', note: '保存した設定は次のロボット制御の起動・再起動で読み込まれます。「ロボットの設定と比較」で実行中の値と比較できます。' };
    }
    let compared = 0, different = 0, missing = 0;
    for (const [node, fields] of Object.entries(profile.values)) {
      const report = snapshot.nodes?.[node];
      for (const [key, value] of Object.entries(fields)) {
        if (report?.status !== 'ok' || !Object.hasOwn(report.values, key)) { missing++; continue; }
        compared++;
        if (report.values[key] !== value) different++;
      }
    }
    if (different) return { kind: 'pending', title: `保存済み・実行中と ${different} 項目が異なります`, note: 'ロボットを安全な状態にして、「操作」からロボット制御を起動・再起動し、もう一度確認してください。' };
    if (!compared) return { kind: 'unknown', title: '実行中の設定を確認できません', note: 'ロボットが起動しているか確認してください。保存済みの設定を実行中の値として扱うことはできません。' };
    return { kind: missing ? 'partial' : 'matched', title: `取得した ${compared} 項目は保存済みと一致`,
      note: `取得時点の比較です。${missing ? `残り ${missing} 項目は確認できていません（停止中・未使用の機能を含みます）。` : 'すべての項目を確認しました。'}` };
  }
  return { failure, application };
})();
if (typeof module !== 'undefined') module.exports = OperatorGuide;
