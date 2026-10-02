/* QUESTiX Robot Manager: the 記録 tab's 「証拠付き記録」 (POST /api/rosbag/start-trial).
   Pure functions of GET /api/rosbag/status and of the form's values, no DOM, exported for the
   node tests like status-view.js. The fields and limits repeat robot_manager/trial.py
   (validate_metadata, which checks them again; tests/trial_view.test.cjs keeps them identical).
   There is no field for a name, student number, e-mail or school: the API refuses unknown keys. */
const TrialView = (() => {
  const ID_PATTERN = '^[A-Za-z0-9_-]{1,64}$';
  const SHORT_ID_PATTERN = '^[A-Za-z0-9_-]{1,32}$';
  // Python's re: [\x00-\x08\x0b-\x1f\x7f] for labels, the memo also refuses a tab.
  const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
  const MEMO_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;
  const LABEL_MAX = 64;
  const FLOOR_MAX = 32;
  const MEMO_MAX = 500;
  const PAYLOAD_MAX_KG = 500;
  const BATTERY_MAX_V = 100;

  // The fields of trial.METADATA_FIELDS, in the form's order (pairs of half-width fields, `wide`
  // ones take a whole row). `kind` decides the check below and the input's attributes.
  const FIELDS = [
    { key: 'trial_id', label: '試行ID', kind: 'id', pattern: ID_PATTERN, placeholder: '空欄なら自動（日時）' },
    { key: 'team_id', label: '班ID（匿名）', kind: 'id', pattern: SHORT_ID_PATTERN, placeholder: 'teamA' },
    { key: 'robot_id', label: '号機ID', kind: 'id', pattern: SHORT_ID_PATTERN, placeholder: 'robot1' },
    { key: 'floor', label: '床面', kind: 'label', max: FLOOR_MAX, placeholder: '体育館' },
    { key: 'condition_label', label: '条件', kind: 'label', max: LABEL_MAX, wide: true, placeholder: 'baseline / max_speed 1.5' },
    { key: 'payload_kg', label: '積載（kg）', kind: 'number', max: PAYLOAD_MAX_KG },
    { key: 'battery_voltage', label: 'バッテリー（V）', kind: 'number', max: BATTERY_MAX_V },
    { key: 'memo', label: 'メモ', kind: 'memo', max: MEMO_MAX, wide: true, placeholder: '観察・気づき（個人情報は書かない）' },
  ];

  // Python's len() counts code points; String.length counts UTF-16 units.
  function length(text) {
    return [...text].length;
  }

  // The reason a value would be refused, or '' (the same rules as trial.validate_metadata).
  function fieldError(field, text) {
    if (field.kind === 'id') {
      if (!new RegExp(field.pattern).test(text)) {
        const max = field.pattern === ID_PATTERN ? 64 : 32;
        return `${field.label} は英数字・「_」・「-」の 1〜${max} 文字にしてください`;
      }
    } else if (field.kind === 'number') {
      const number = Number(text);
      if (!Number.isFinite(number)) return `${field.label} は数値で入力してください`;
      if (number < 0 || number > field.max) return `${field.label} は 0〜${field.max} の範囲で入力してください`;
    } else {
      if ((field.kind === 'memo' ? MEMO_CONTROL : CONTROL).test(text)) {
        return `${field.label} に使えない制御文字が含まれています`;
      }
      if (length(text) > field.max) return `${field.label} は ${field.max} 文字以内にしてください`;
    }
    return '';
  }

  // The request body for POST /api/rosbag/start-trial from {key: raw input text}: empty fields
  // are left out (the server then picks the defaults, e.g. a time-based trial ID), numbers are
  // sent as numbers. `errors` lists every refused field; send nothing while it is not empty.
  function metadata(values) {
    const body = {};
    const errors = [];
    for (const field of FIELDS) {
      const text = String((values && values[field.key]) ?? '').trim();
      if (!text) continue;
      const error = fieldError(field, text);
      if (error) {
        errors.push(error);
        continue;
      }
      body[field.key] = field.kind === 'number' ? Number(text) : text;
    }
    return { body, errors };
  }

  const INTEGRITY = {
    ok: { state: 'ok', text: 'OK（必須トピックあり・正常に終了）' },
    warning: { state: 'warning', text: '要確認（下の注意を見てください）' },
    failed: { state: 'failed', text: '失敗（bag を確認できません）' },
  };

  const STOP_REASON = {
    user_stopped: '停止ボタン',
    max_duration: '最大記録時間に達した',
    auto_stopped_low_disk: '空き容量不足で自動停止',
    process_exited: '記録が途中で終了',
    shutdown: 'Robot Manager の終了',
  };

  function idText(trial) {
    return [trial.trial_id, trial.team_id, trial.condition_label].filter(Boolean).join(' / ') || '—';
  }

  // What the 記録 card shows about the evidence: the running trial, or the last one's verdict.
  // `rows` is empty while nothing about a trial is known (generic recordings only).
  function status(data) {
    const recording = Boolean(data && data.recording);
    const classroom = recording && data.mode === 'classroom';
    const mode = !recording ? '—' : (classroom ? '証拠付き記録' : '通常の記録');
    const trial = classroom ? data.trial : null;
    const last = !recording && data ? data.last_trial : null;
    if (trial) {
      return {
        mode,
        heading: '証拠付き記録（記録中）',
        rows: [['試行ID / 班 / 条件', idText(trial)]],
        badge: { state: 'recording', text: '記録中（停止すると確定します）' },
        warnings: trial.warnings || [],
      };
    }
    if (!last) return { mode, heading: '', rows: [], badge: null, warnings: [] };
    let badge;
    if (last.finalizing || last.integrity_status === 'pending') {
      badge = { state: 'pending', text: '確定中…（bag の確認と証拠の保存）' };
    } else {
      badge = INTEGRITY[last.integrity_status] || { state: 'warning', text: '不明' };
    }
    const rows = [
      ['試行ID / 班 / 条件', idText(last)],
      ['記録名', last.bag_name || '—'],
      ['止まった理由', STOP_REASON[last.stop_reason] || last.stop_reason || '—'],
    ];
    if (!last.finalizing && last.evidence_dir) rows.push(['証拠の場所', last.evidence_dir]);
    return { mode, heading: '前回の証拠付き記録', rows, badge, warnings: last.warnings || [] };
  }

  // The start button's label and the toast after a successful start.
  function startLabel(evidence) {
    return evidence ? '証拠付きで記録開始' : '記録開始';
  }

  function startedText(result) {
    if (result && result.mode === 'classroom') {
      return `証拠付き記録を開始しました: ${result.trial_id}（${result.bag_name}）`;
    }
    return `記録を開始しました: ${result ? result.bag_name : ''}`;
  }

  return {
    ID_PATTERN, SHORT_ID_PATTERN, LABEL_MAX, FLOOR_MAX, MEMO_MAX, PAYLOAD_MAX_KG, BATTERY_MAX_V,
    FIELDS, STOP_REASON, fieldError, metadata, status, startLabel, startedText,
  };
})();
if (typeof module !== 'undefined') module.exports = TrialView;
