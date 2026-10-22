/* QUESTiX Robot Manager: what the status strip, the header and the 教材 cards say.
   Pure functions of /api/status, /api/lab/status and /api/wifi-ap (no DOM), exported for the
   node tests like operator-guide.js. */
const StatusView = (() => {
  // modes.py: lesson (教材), practice (練習), competition (大会).
  const MODE = { lesson: '教材', practice: '練習', competition: '大会' };

  // QUESTiX LAB exists in lesson mode only: why it is unavailable in the saved mode, or null.
  function labUnavailable(lab) {
    if (!lab || lab.available !== false) return null;
    return `${MODE[lab.mode] || '今の'}モード`;
  }
  const SERVICE = {
    active: '実行中', activating: '起動処理中', deactivating: '停止処理中', inactive: '停止中',
    failed: '起動失敗', unknown: '状態未確認',
  };
  // A bridge that (re)starts takes a few seconds to discover the ROS graph: meanwhile it reports
  // the robot's lab inputs as missing. A permission switched on takes up to a second to reach the
  // robot (/lab_permission). Such blockers are shown only once they last this long.
  const SETTLE_MS = 6000;
  const TRANSIENT = new Set(['no_drive_node', 'no_launcher', 'not_allowed']);
  const BLOCKER_ORDER = ['not_allowed', 'estop_unknown', 'emergency_stop', 'no_drive_node',
    'no_launcher', 'other_publisher', 'no_motion_permission', 'controller'];
  const WEB_JOY_PORT = '8899';

  const WORDS = {
    drive: { name: '走行', verb: '走らせ', doing: '走行中', title: '教材からの走行' },
    shoot: { name: '発射', verb: '発射させ', doing: '発射台を操作中', title: '教材からの発射' },
  };

  function createBlockerMemory() {
    return new Map();
  }

  // Blockers worth showing now: the transient ones only after SETTLE_MS without a break.
  function stableBlockers(kind, blockers, memory, now, settle = true) {
    const estop = (blockers || []).some((b) => b && b.code === 'emergency_stop');
    // Older bridges also report the shot node's E-stop teardown as a missing launcher. Keep
    // genuinely missing arbiter/roller parts, and never mutate the bridge's status object.
    blockers = (blockers || []).flatMap((blocker) => {
      if (estop && blocker && blocker.code === 'no_launcher' && Array.isArray(blocker.parts)) {
        const parts = blocker.parts.filter((part) => part !== 'shot');
        return parts.length ? [{ ...blocker, parts }] : [];
      }
      return [blocker];
    });
    const seen = new Set();
    const shown = [];
    let pending = false;
    for (const blocker of blockers || []) {
      if (!blocker) continue;
      const key = `${kind}:${blocker.code}`;
      seen.add(key);
      if (!memory.has(key)) memory.set(key, now);
      if (settle && TRANSIENT.has(blocker.code) && now - memory.get(key) < SETTLE_MS) pending = true;
      else shown.push(blocker);
    }
    for (const key of [...memory.keys()]) {
      if (key.startsWith(`${kind}:`) && !seen.has(key)) memory.delete(key);
    }
    const rank = (b) => {
      const index = BLOCKER_ORDER.indexOf(b.code);
      return index < 0 ? BLOCKER_ORDER.length : index;
    };
    shown.sort((a, b) => rank(a) - rank(b));
    return { shown, pending };
  }

  function domainOf(bridge) {
    const robot = bridge && bridge.robot;
    return robot && robot.domain != null ? robot.domain : '未設定（0）';
  }

  // { text: plain words for the teacher, detail: the technical cause (command_arbiter, topics...) }
  function blockerText(kind, blocker, bridge, service) {
    const stopped = service !== 'active';
    const nodes = (blocker.nodes || []).join(', ') || '不明なノード';
    switch (blocker.code) {
      case 'no_drive_node':
        return {
          text: stopped
            ? 'ロボット制御が止まっています（「操作」の「起動」で教材用の構成で起動します）'
            : 'ロボット制御が教材用の構成で動いていないか、別のロボットの設定です',
          detail: `切り替えノード command_arbiter が見つかりません（ROS_DOMAIN_ID ${domainOf(bridge)}）。` +
            '練習用・大会用の起動には入りません。',
        };
      case 'not_allowed':
        return {
          text: '教材の許可がロボットに届いていません（ロボット制御が教材用の構成で動いているか確かめてください）',
          detail: `/lab_permission（Robot Manager）を${kind === 'drive' ? ' command_arbiter が' : ''}受け取れていません` +
            `（ROS_DOMAIN_ID ${domainOf(bridge)}）。`,
        };
      case 'no_motion_permission':
        return {
          text: 'ロボットの動作許可が出ていません（「操作」タブの先生の操作許可を確かめてください）',
          detail: '/motion_permission（operation_manager）が走行を許可していません。',
        };
      case 'no_launcher': {
        const names = { arbiter: '切り替え', roller: 'ローラー', shot: '発射台' };
        const nodes = { arbiter: 'command_arbiter', roller: 'esc_motor_control', shot: 'shot_component' };
        const parts = (blocker.parts || []).map((p) => names[p]).filter(Boolean).join('・') || '発射装置';
        const technical = (blocker.parts || []).map((p) => nodes[p]).filter(Boolean).join('・')
          || 'command_arbiter・esc_motor_control・shot_component';
        return {
          text: stopped
            ? 'ロボット制御が止まっています（「操作」の「起動」で教材用の構成で起動します）'
            : `${parts}が教材の指令を受け付けていません（教材用の構成で動いていないか、別のロボットの設定です）`,
          detail: `${technical} が見つからないか、状態が届いていません（ROS_DOMAIN_ID ${domainOf(bridge)}）。` +
            '練習用・大会用の起動には command_arbiter が入りません。',
        };
      }
      case 'other_publisher':
        return {
          text: kind === 'drive'
            ? 'ほかのプログラムが教材用の走行指令を出しています'
            : 'ほかのプログラムが教材用の発射指令を出しています',
          detail: `${nodes} が ${kind === 'drive' ? '/target_twist/lab' : '/launcher_command/lab'} に出しています。`,
        };
      case 'estop_unknown':
        return {
          text: '非常停止の状態をまだ確認できません',
          detail: '/emergency_stop（operation_manager）がまだ届いていません。' +
            '届くまで教材からは動かせません（ロボット制御が起動しているかと ROS_DOMAIN_ID を確かめてください）。',
        };
      case 'emergency_stop':
        return { text: '非常停止ボタンが押されています', detail: null };
      case 'controller':
        return { text: 'コントローラーで発射台を操作中です（ボタンを離すと教材から使えます）', detail: null };
      default:
        return { text: `教材から使えない理由があります（${blocker.code}）`, detail: null };
    }
  }

  // One 教材 card (kind "drive" or "shoot"): headline, tone, the toggle, and the reasons.
  function capability(kind, lab, service, memory, now) {
    const words = WORDS[kind];
    const bridge = lab && lab.bridge;
    const serving = Boolean(lab && (lab.running || lab.external));
    const state = (bridge && (kind === 'drive' ? bridge.drive_state : bridge.shoot_state)) || {};
    const bridgeAllows = kind === 'drive'
      ? Boolean(bridge && bridge.read_only === false) : state.allowed === true;
    const setting = Boolean(lab && (kind === 'drive' ? lab.drive_allowed : lab.shoot_allowed));
    const view = {
      tone: 'idle', headline: '', allowed: setting, toggleDisabled: false, toggleNote: '',
      reasons: [], active: Boolean(state.active), owner: state.active ? state.owner : null,
    };
    // With the robot service stopped the missing nodes are no surprise: no need to wait.
    const { shown, pending } = stableBlockers(kind, setting ? state.blockers : [], memory, now,
      service === 'active');
    if (!lab) {
      view.headline = '状態を確認しています';
      view.toggleDisabled = true;
      return view;
    }
    const unavailable = labUnavailable(lab);
    if (unavailable) {
      view.headline = `${unavailable}のため使えません`;
      view.toggleDisabled = true;
      view.toggleNote = `${unavailable}では教材からは動かせません（教材モードで使えます）。教材モードに戻しても OFF のままです（先生が ON にしてください）。`;
      return view;
    }
    // The running launch decides what the robot does: a lesson permission can be switched on only
    // while it is a lesson launch (the manager refuses it otherwise).
    if (!setting && lab.switches_available === false) {
      view.toggleDisabled = true;
      view.toggleNote = lab.running_mode
        ? `いまは${MODE[lab.running_mode] || '別の'}用の構成で動いています。教材モードで「再起動」すると ON にできます。`
        : 'ロボット制御が止まっています。教材モードで「起動」すると ON にできます。';
    }
    // The teacher's runtime authority for the robot (操作 tab) comes first: without it a lesson
    // permission cannot be switched on (the manager refuses it too).
    const authority = kind === 'drive' ? lab.drive_authority : lab.shoot_authority;
    if (!setting && authority === false && lab.switches_available !== false) {
      view.toggleDisabled = true;
      view.toggleNote = kind === 'drive'
        ? '先に「操作」タブの「先生の操作許可」で「ロボットの走行制御」を ON にしてください。'
        : '先に「操作」タブの「先生の操作許可」で「発射機構の操作」を ON にしてください。';
    }
    if (!serving) {
      view.headline = setting ? `許可済み・教材の配信が止まっています` : '禁止しています';
      return view;
    }
    if (!bridge) {
      view.headline = 'ブリッジの状態が分かりません（起動中か、状態を返さない古いブリッジです）';
      return view;
    }
    // The robot follows /lab_permission within a second; a yes that lasts longer comes from
    // somewhere else (another manager on the same ROS_DOMAIN_ID).
    if (!setting && bridgeAllows) {
      view.tone = 'driving';
      view.headline = `禁止に切り替えましたが、ロボットはまだ教材からの${words.name}を受け付けています（数秒たっても変わらないときは「すべて止める」を押してください）`;
      return view;
    }
    if (!setting) {
      view.headline = `禁止しています（教材からは${words.verb}られません）`;
      return view;
    }
    view.reasons = shown.map((b) => blockerText(kind, b, bridge, service));
    if (view.reasons.length) {
      view.tone = 'warn';
      view.headline = `許可済み・いまは${words.name}できません（${view.reasons[0].text}）`;
    } else if (pending || !bridgeAllows) {
      view.tone = 'warn';
      view.headline = '許可済み・ロボットの状態を確認しています…';
    } else if (state.active) {
      view.tone = 'driving';
      view.headline = `許可済み・生徒の端末 #${state.owner} が${words.doing}`;
    } else {
      view.tone = 'driving';
      view.headline = `許可済み・生徒が教材から${words.verb}られます`;
    }
    return view;
  }

  // Short mode text for the header: the running mode when running, else the next one.
  function modeSummary(status) {
    if (!status) return 'モード未取得';
    const next = MODE[status.mode] || '未確認';
    if (status.service !== 'active') return `次回起動: ${next}`;
    const running = MODE[status.running_mode];
    if (!running) return `動作中: 不明 / 次回: ${next}`;
    return running === next ? `動作中: ${running}` : `動作中: ${running} / 次回: ${next}`;
  }

  // operation_manager's reason (gpio_safety_evaluator.cpp: "pin 5 is true, expected false; ",
  // "pin 5 not received; ", "pin 5 timeout; ") in the teacher's words. GPIO5 is the physical
  // E-stop (true when pressed; an input with nothing wired may read true as well), GPIO27 the
  // AutoReferee input (competition).
  function estopReasonText(reason) {
    const parts = String(reason || '').split(';').map((part) => part.trim()).filter(Boolean);
    return parts.map((part) => {
      const match = part.match(/^pin (\d+) (.+)$/);
      if (!match) return part;
      const [, pin, what] = match;
      const name = pin === '5' ? '非常停止ボタン（GPIO5）' : pin === '27' ? 'AutoReferee（GPIO27）' : `GPIO${pin}`;
      if (what === 'not received') return `${name}の信号が届いていません`;
      if (what === 'timeout') return `${name}の信号が途絶えています`;
      if (/^is (true|false), expected (true|false)$/.test(what)) {
        if (pin === '5') return '非常停止ボタンが押されているか、つながっていません';
        if (pin === '27') return 'AutoReferee が停止を指示しています';
      }
      return `${name}: ${what}`;
    }).join('・');
  }

  // Why the manager's own E-stop listener (estop_monitor.py) has no state, or null.
  const MONITOR_UNKNOWN = {
    starting: '確認しています',
    not_heard: '分かりません（/emergency_stop が届いていません。operation_manager が動いているかと ROS_DOMAIN_ID を確かめてください）',
    silent: '分かりません（/emergency_stop が途絶えています。届かない間ロボットは動きません）',
  };
  function monitorUnknownText(monitor) {
    if (!monitor) return null;
    if (monitor.note === 'unavailable') return `分かりません（${monitor.detail || '確認用のプロセスを起動できません'}）`;
    return MONITOR_UNKNOWN[monitor.note] || null;
  }

  // ``monitor`` is /api/status emergency_stop (estop_monitor.py: every mode, with or without
  // QUESTiX LAB); the bridge's report and blockers are the fallback for an older manager.
  function estop(lab, service, monitor) {
    const bridge = lab && lab.bridge;
    if (!service || service === 'unknown') return { text: '確認不能', tone: 'warn' };
    if (service !== 'active') return { text: '不明（ロボット制御が停止中）', tone: 'idle' };
    if (monitor && monitor.state === 'pressed') {
      const why = estopReasonText(monitor.reason);
      return { text: '押されています', tone: 'danger', detail: why || '' };
    }
    if (monitor && monitor.state === 'released') {
      // Only a manual diagnostic launch (enable_gpio_ref:=false) releases without reading GPIO5.
      if (/no GPIO safety path/.test(monitor.reason || '')) {
        return { text: '解除されています（非常停止ボタンを読まない診断用の起動です）', tone: 'warn' };
      }
      return { text: '解除', tone: 'ok' };
    }
    if (monitor) return { text: '不明', tone: 'warn' };
    // Bridges since 2026-09-26 report it directly (always observed); older ones only as blockers.
    if (bridge && typeof bridge.emergency_stop === 'boolean') {
      return bridge.emergency_stop
        ? { text: '押されています', tone: 'danger' } : { text: '解除', tone: 'ok' };
    }
    // A bridge that reports it but has not heard /emergency_stop yet: unknown, never "released".
    if (bridge && 'emergency_stop' in bridge) {
      return { text: '分かりません（非常停止の状態をまだ確認できません）', tone: 'warn' };
    }
    const sources = [];
    if (bridge && bridge.read_only === false) sources.push(bridge.drive_state);
    if (bridge && bridge.shoot_state && bridge.shoot_state.allowed === true) sources.push(bridge.shoot_state);
    if (!sources.length) {
      const why = monitorUnknownText(monitor);
      if (why) return { text: why, tone: monitor.note === 'starting' ? 'idle' : 'warn' };
      return { text: '分かりません（教材の配信を始めると確認できます）', tone: 'idle' };
    }
    const pressed = sources.some((s) => (s && s.blockers || []).some((b) => b.code === 'emergency_stop'));
    return pressed ? { text: '押されています', tone: 'danger' } : { text: '解除', tone: 'ok' };
  }

  // The header's E-stop block: always shown, one of three words. Only reads the row estop() made
  // (its tone), so the 操作 tab and the header can never disagree.
  const HEADER_ESTOP = {
    pressed: '押されています',
    released: '解除',
    unknown: '不明',
  };
  function headerEstop(row) {
    const tone = row && row.tone;
    const state = tone === 'danger' ? 'pressed' : tone === 'ok' ? 'released' : 'unknown';
    return { state, label: row?.text === '確認不能' ? '確認不能' : HEADER_ESTOP[state] };
  }

  const PERMISSION_BLOCKERS = {
    'teacher:off': '先生の許可OFF',
    'teacher:unknown': '先生の許可を未受信',
    'teacher:stale': '先生の許可信号が途絶',
    'referee:off': '審判の許可なし',
    'referee:unknown': '審判の信号を未受信',
    'referee:stale': '審判の信号が途絶',
  };
  function permissionDeadline(report, startedAt) {
    if (report?.state !== 'known' || !Number.isFinite(report.age_sec) || report.age_sec < 0 ||
        report.stale_after_sec !== 1.5) return 0;
    // Count the whole HTTP round trip against freshness, conservatively. A delayed response
    // cannot restart a full lease when it reaches the browser.
    return startedAt + Math.max(0, report.stale_after_sec - report.age_sec) * 1000;
  }
  function motionPermission(report, kind) {
    if (report?.state !== 'known' || typeof report[`${kind}_allowed`] !== 'boolean') {
      const note = report?.note;
      return { text: note === 'robot_stopped' ? '不明（ロボット制御停止中）'
        : note === 'silent' ? '不明（信号が途絶）'
          : note === 'unavailable' ? '不明（確認できません）' : '不明（受信していません）', tone: 'warn' };
    }
    if (report[`${kind}_allowed`]) return { text: '許可', tone: 'ok' };
    const blockers = report[`${kind}_blockers`];
    const reasons = Array.isArray(blockers) ? blockers.map(b => PERMISSION_BLOCKERS[b] || `理由：${b}`) : [];
    return { text: reasons.length ? `許可なし（${reasons.join('／')}）` : '許可なし', tone: 'warn' };
  }

  // Rows of the 操作 tab's status strip.
  function overview(status, lab, controllerName) {
    const service = status ? status.service : 'unknown';
    const bridge = lab && lab.bridge;
    const serving = Boolean(lab && (lab.running || lab.external));
    const rows = {};
    rows.robot = {
      text: (bridge && bridge.robot && bridge.robot.name) || (status && status.robot_name) || '—',
      tone: 'plain',
    };
    if (!status) {
      rows.mode = { text: '確認中', tone: 'idle' };
    } else {
      const next = MODE[status.mode] || '未確認';
      if (service === 'active') {
        const running = MODE[status.running_mode];
        rows.mode = running
          ? { text: running === next ? `${running}の構成で動作中（次回も${next}）` : `${running}の構成で動作中・次回の起動は${next}`,
            tone: running === next ? 'ok' : 'warn' }
          : { text: `動作中（モード不明）・次回の起動は${next}`, tone: 'warn' };
      } else {
        rows.mode = {
          text: `次回の起動は${next}` + (status.mode === 'competition'
            ? '（電源を入れると自動で起動します）' : '（「起動」を押したときだけ起動します）'),
          tone: 'idle',
        };
      }
    }
    rows.service = { text: SERVICE[service] || SERVICE.unknown,
      tone: service === 'active' ? 'ok' : service === 'failed' ? 'danger' : 'idle' };
    rows.estop = estop(lab, service, status && status.emergency_stop);
    if (!lab) rows.lab = { text: '確認中', tone: 'idle' };
    else if (labUnavailable(lab)) rows.lab = { text: `${labUnavailable(lab)}のため配信しません`, tone: 'idle' };
    else if (serving) {
      const clients = bridge && bridge.clients != null ? `・接続中の端末 ${bridge.clients} 台` : '';
      rows.lab = { text: `配信中${clients}`, tone: 'ok' };
    } else rows.lab = { text: '停止中', tone: 'idle' };
    if (!lab) rows.permissions = { text: '確認中', tone: 'idle' };
    else if (labUnavailable(lab)) rows.permissions = { text: `${labUnavailable(lab)}のため禁止`, tone: 'idle' };
    else {
      const word = (on) => (on ? 'ON' : 'OFF');
      rows.permissions = {
        text: `教材からの走行: ${word(lab.drive_allowed)}・教材からの発射: ${word(lab.shoot_allowed)}`,
        tone: lab.drive_allowed || lab.shoot_allowed ? 'warn' : 'idle',
      };
    }
    const drive = (bridge && bridge.drive_state) || {};
    const shoot = (bridge && bridge.shoot_state) || {};
    const doing = [];
    if (drive.active) doing.push(`生徒の端末 #${drive.owner}（教材から走行中）`);
    if (shoot.active) doing.push(`生徒の端末 #${shoot.owner}（教材から発射台を操作中）`);
    if (service === 'unknown') rows.driver = { text: '確認不能', tone: 'warn' };
    else if (service !== 'active') rows.driver = { text: 'だれも動かせません（ロボット制御が停止中）', tone: 'idle' };
    else if (doing.length) rows.driver = { text: doing.join('・'), tone: 'warn' };
    else {
      const controllerBusy = (shoot.blockers || []).some((b) => b.code === 'controller');
      rows.driver = {
        text: `コントローラー（${controllerName || '未確認'}）` +
          (controllerBusy ? '・発射台を操作中' : '・教材からは動かしていません'),
        tone: 'plain',
      };
    }
    rows['drive-permission'] = motionPermission(status?.motion_permission, 'drive');
    rows['launcher-permission'] = motionPermission(status?.motion_permission, 'launcher');
    return rows;
  }

  // Address of the browser controller (web_joy_driver) for phones: the robot's own access point
  // first, then the first LAN address the lab tab knows, then what the page itself suggests.
  function controllerUrl(ap, labUrls, fallback) {
    if (ap && ap.configured && ap.active && ap.controller_url) return ap.controller_url;
    for (const raw of labUrls || []) {
      try {
        const url = new URL(raw);
        url.port = WEB_JOY_PORT;
        url.pathname = '/';
        url.search = '';
        url.hash = '';
        return url.href;
      } catch (_) { /* skip an unusable address */ }
    }
    return fallback || '';
  }

  // Toast text after a mode switch back to lesson mode: what QUESTiX LAB is set to now.
  function labRestoredText(lab) {
    if (!lab) return '';
    if (lab.error) return `教材の設定を戻せませんでした（${lab.error}）`;
    const word = (on) => (on ? 'オン' : 'オフ');
    const head = lab.restored ? '教材の配信は大会モードの前の設定に戻しました' : '教材の配信の自動開始をオンにしました';
    return `${head}（配信の自動開始: ${word(lab.autostart)}・教材からの走行: ${lab.drive ? 'ON' : 'OFF'}・発射: ${lab.shoot ? 'ON' : 'OFF'}。走行・発射の許可は先生が操作タブで選んでください）`;
  }

  return {
    MODE, labUnavailable, SERVICE, SETTLE_MS, createBlockerMemory, stableBlockers, blockerText, capability,
    modeSummary, estop, estopReasonText, headerEstop, overview, controllerUrl, labRestoredText,
    motionPermission, permissionDeadline,
  };
})();
if (typeof module !== 'undefined') module.exports = StatusView;
