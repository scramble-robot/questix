/* QUESTiX Robot Manager: what the status strip, the header and the 教材 cards say.
   Pure functions of /api/status, /api/lab/status and /api/wifi-ap (no DOM), exported for the
   node tests like operator-guide.js. */
const StatusView = (() => {
  const MODE = { practice: '練習', competition: '大会' };
  const SERVICE = {
    active: '実行中', activating: '起動処理中', deactivating: '停止処理中', inactive: '停止中',
    failed: '起動失敗', unknown: '状態未確認',
  };
  // A bridge that (re)starts takes a few seconds to discover the ROS graph: meanwhile it reports
  // the robot's lab inputs as missing. Such blockers are shown only once they last this long.
  const SETTLE_MS = 6000;
  const TRANSIENT = new Set(['no_drive_node', 'no_launcher']);
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
    const seen = new Set();
    const shown = [];
    let pending = false;
    for (const blocker of blockers || []) {
      if (!blocker || blocker.code === 'not_allowed') continue;
      const key = `${kind}:${blocker.code}`;
      seen.add(key);
      if (!memory.has(key)) memory.set(key, now);
      if (settle && TRANSIENT.has(blocker.code) && now - memory.get(key) < SETTLE_MS) pending = true;
      else shown.push(blocker);
    }
    for (const key of [...memory.keys()]) {
      if (key.startsWith(`${kind}:`) && !seen.has(key)) memory.delete(key);
    }
    return { shown, pending };
  }

  function domainOf(bridge) {
    const robot = bridge && bridge.robot;
    return robot && robot.domain != null ? robot.domain : '未設定(0)';
  }

  // { text: plain words for the teacher, detail: the technical cause (twist_arbiter, topics...) }
  function blockerText(kind, blocker, bridge, service) {
    const stopped = service !== 'active';
    const nodes = (blocker.nodes || []).join(', ') || '不明なノード';
    switch (blocker.code) {
      case 'no_drive_node':
        return {
          text: stopped
            ? 'ロボット制御が止まっています（「操作」の「起動」で練習用の構成で起動します）'
            : 'ロボット制御が練習用の構成で動いていないか、別のロボットの設定です',
          detail: `切り替えノード twist_arbiter が見つかりません（ROS_DOMAIN_ID ${domainOf(bridge)}）。` +
            '大会用の起動（enable_autoreferee:=true）には入りません。',
        };
      case 'no_launcher': {
        const parts = (blocker.parts || [])
          .map((p) => (p === 'roller' ? 'ローラー' : p === 'shot' ? '発射台' : null))
          .filter(Boolean).join('・') || '発射装置';
        const technical = (blocker.parts || [])
          .map((p) => (p === 'roller' ? 'esc_motor_control' : p === 'shot' ? 'shot_component' : null))
          .filter(Boolean).join('・') || 'esc_motor_control・shot_component';
        return {
          text: stopped
            ? 'ロボット制御が止まっています（「操作」の「起動」で練習用の構成で起動します）'
            : `${parts}が教材の指令を受け付けていません（練習用の構成で動いていないか、別のロボットの設定です）`,
          detail: `${technical} が教材の入力（accept_lab_input）を受け付けていません（ROS_DOMAIN_ID ${domainOf(bridge)}）。` +
            '大会用の起動では受け付けません。',
        };
      }
      case 'other_publisher':
        return {
          text: kind === 'drive'
            ? 'ほかのプログラムが教材用の走行指令を出しています'
            : 'ほかのプログラムが教材用の発射指令を出しています',
          detail: `${nodes} が ${kind === 'drive' ? '/target_twist/lab' : '/roller/lab・/shot/lab/*'} に出しています。`,
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
    const { shown, pending } = stableBlockers(kind, bridgeAllows ? state.blockers : [], memory, now,
      service === 'active');
    if (!lab) {
      view.headline = '状態を確認しています';
      view.toggleDisabled = true;
      return view;
    }
    if (lab.competition) {
      view.headline = '大会モードのため使えません';
      view.toggleDisabled = true;
      view.toggleNote = '大会モードでは教材からは動かせません。練習モードに戻すと、先生が選んでいた設定に戻ります。';
      return view;
    }
    if (lab.external && bridge) {
      view.toggleNote = '手動で起動したブリッジです。ここでの切り替えは反映されません（端末で Ctrl+C して「配信開始」を押してください）。';
    }
    if (!serving) {
      view.headline = setting ? `許可済み・教材の配信が止まっています` : '禁止しています';
      return view;
    }
    if (!bridge) {
      view.headline = 'ブリッジの状態が分かりません（起動中か、状態を返さない古いブリッジです）';
      return view;
    }
    if (!setting && bridgeAllows && !lab.external) {
      view.tone = 'driving';
      view.headline = `禁止に切り替えましたが、配信中のブリッジはまだ${words.name}を受け付けます（「配信停止」→「配信開始」を押してください）`;
      return view;
    }
    if (!bridgeAllows) {
      view.headline = setting
        ? `許可済み・いまのブリッジは${words.name}を受け付けていません（配信を開始し直すと有効になります）`
        : `禁止しています（教材からは${words.verb}られません）`;
      view.tone = setting ? 'warn' : 'idle';
      return view;
    }
    view.reasons = shown.map((b) => blockerText(kind, b, bridge, service));
    if (view.reasons.length) {
      view.tone = 'warn';
      view.headline = `許可済み・いまは${words.name}できません（${view.reasons[0].text}）`;
    } else if (pending) {
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

  function estop(lab, service) {
    const bridge = lab && lab.bridge;
    if (service !== 'active') return { text: 'ロボット制御が停止中のため分かりません', tone: 'idle' };
    const sources = [];
    if (bridge && bridge.read_only === false) sources.push(bridge.drive_state);
    if (bridge && bridge.shoot_state && bridge.shoot_state.allowed === true) sources.push(bridge.shoot_state);
    if (!sources.length) {
      return { text: '分かりません（教材の走行か発射を許可して配信しているときに確認できます）', tone: 'idle' };
    }
    const pressed = sources.some((s) => (s && s.blockers || []).some((b) => b.code === 'emergency_stop'));
    return pressed ? { text: '押されています', tone: 'danger' } : { text: '解除されています', tone: 'ok' };
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
          text: `次回の起動は${next}` + (status.mode === 'practice'
            ? '（「起動」を押したときだけ起動します）' : '（電源を入れると自動で起動します）'),
          tone: 'idle',
        };
      }
    }
    rows.service = { text: SERVICE[service] || SERVICE.unknown,
      tone: service === 'active' ? 'ok' : service === 'failed' ? 'danger' : 'idle' };
    rows.estop = estop(lab, service);
    if (!lab) rows.lab = { text: '確認中', tone: 'idle' };
    else if (lab.competition) rows.lab = { text: '大会モードのため配信しません', tone: 'idle' };
    else if (serving) {
      const clients = bridge && bridge.clients != null ? `・接続中の端末 ${bridge.clients} 台` : '';
      rows.lab = { text: `配信中${clients}`, tone: 'ok' };
    } else rows.lab = { text: '停止中', tone: 'idle' };
    if (!lab) rows.permissions = { text: '確認中', tone: 'idle' };
    else if (lab.competition) rows.permissions = { text: '大会モードのため禁止', tone: 'idle' };
    else {
      const word = (on) => (on ? '許可' : '禁止');
      rows.permissions = {
        text: `走行: ${word(lab.drive_allowed)}・発射: ${word(lab.shoot_allowed)}`,
        tone: lab.drive_allowed || lab.shoot_allowed ? 'warn' : 'idle',
      };
    }
    const drive = (bridge && bridge.drive_state) || {};
    const shoot = (bridge && bridge.shoot_state) || {};
    const doing = [];
    if (drive.active) doing.push(`教材（生徒の端末 #${drive.owner}）が走行中`);
    if (shoot.active) doing.push(`教材（生徒の端末 #${shoot.owner}）が発射台を操作中`);
    if (service !== 'active') rows.driver = { text: 'だれも動かせません（ロボット制御が停止中）', tone: 'idle' };
    else if (doing.length) rows.driver = { text: doing.join('・'), tone: 'warn' };
    else {
      const controllerBusy = (shoot.blockers || []).some((b) => b.code === 'controller');
      rows.driver = {
        text: `コントローラー（${controllerName || '未確認'}）` +
          (controllerBusy ? '・発射台を操作中' : '・教材は動かしていません'),
        tone: 'plain',
      };
    }
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

  // Toast text after a mode switch back to practice: what QUESTiX LAB is set to now.
  function labRestoredText(lab) {
    if (!lab) return '';
    if (lab.error) return `教材の設定を戻せませんでした（${lab.error}）`;
    const word = (on) => (on ? 'オン' : 'オフ');
    const head = lab.restored ? '教材は大会モードの前の設定に戻しました' : '教材の設定をオンにしました';
    return `${head}（配信の自動開始: ${word(lab.autostart)}・教材からの走行: ${lab.drive ? '許可' : '禁止'}・発射: ${lab.shoot ? '許可' : '禁止'}）`;
  }

  return {
    MODE, SERVICE, SETTLE_MS, createBlockerMemory, stableBlockers, blockerText, capability,
    modeSummary, estop, overview, controllerUrl, labRestoredText,
  };
})();
if (typeof module !== 'undefined') module.exports = StatusView;
