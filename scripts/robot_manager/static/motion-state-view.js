/* QUESTiX Robot Manager: why the robot does not move, from GET /api/motion-state (motion_state.py:
   /emergency_stop and /motion_permission read once). Pure functions (no DOM), exported for the node
   tests like status-view.js. */
const MotionStateView = (() => {
  const MODE = { lesson: '教材', practice: '練習', competition: '大会' };
  // What a /motion_permission blocker ("<vote>:<state>") means, for the teacher.
  const VOTES = { teacher: '先生の操作許可', referee: 'AutoReferee（審判）' };
  const BLOCKERS = {
    'teacher:off': '先生の操作許可が OFF です（「先生の操作許可」で ON にすると動きます）',
    'teacher:stale': '先生の操作許可の送信が途切れています（Robot Manager の再読み込み後に ON にし直してください）',
    'teacher:unknown': '先生の操作許可をまだ受け取っていません（OFF のままです）',
    'referee:off': 'AutoReferee が止めています（撃破、または試合の開始前）',
    'referee:stale': 'AutoReferee の信号が途切れています',
    'referee:unknown': 'AutoReferee の信号をまだ受け取っていません',
  };

  function blockerText(blocker) {
    if (BLOCKERS[blocker]) return BLOCKERS[blocker];
    const [vote, state] = String(blocker).split(':');
    const what = { off: '止めています', stale: '途切れています', unknown: 'まだ届いていません' }[state];
    return `${VOTES[vote] || vote}が${what || state}`;
  }

  // The emergency stop (L1): {tone, text}.
  function estop(state) {
    const value = state && state.emergency_stop;
    if (!value) {
      return { tone: 'warn', text: '分かりません（ロボット制御が動いていないか、別の ROS_DOMAIN_ID です）。分からない間は動きません。' };
    }
    if (value.active) {
      return { tone: 'error', text: `押されているか、状態が分かりません（${value.reason.trim() || '理由なし'}）。非常停止ボタンを確認してください。` };
    }
    if (value.reason === 'released (no GPIO safety path)') {
      return { tone: 'warn', text: '解除（GPIO を読まない診断用の起動です。非常停止ボタンの押下は ROS に伝わりません）' };
    }
    return { tone: 'ok', text: '解除されています' };
  }

  // One flag of the motion permission (L2), kind "drive" or "launcher": {tone, text}.
  function permission(state, kind) {
    const value = state && state.motion_permission;
    if (!value) {
      return { tone: 'warn', text: '走行許可を受け取れません（ロボット制御が動いていないか、古いバージョンです）。受け取れない間は動きません。' };
    }
    const allowed = kind === 'drive' ? value.drive_allowed : value.launcher_allowed;
    const blockers = (kind === 'drive' ? value.drive_blockers : value.launcher_blockers) || [];
    if (allowed) return { tone: 'ok', text: '許可されています' };
    return {
      tone: 'error',
      text: blockers.length ? blockers.map(blockerText).join('／') : '許可されていません',
    };
  }

  // The whole answer: the three rows and a summary line.
  function describe(state) {
    const rows = { estop: estop(state), drive: permission(state, 'drive'), launcher: permission(state, 'launcher') };
    const mode = state && state.motion_permission && MODE[state.motion_permission.mode];
    const blocked = Object.values(rows).some((row) => row.tone !== 'ok');
    let summary = blocked
      ? '止めている理由があります。非常停止が押されていると、ほかの理由より先に止まります。'
      : '非常停止も走行許可も動ける状態です。動かないときは、コントローラーや教材の指令が届いているかを確認してください（許可が戻っただけでは動き出しません）。';
    if (mode) summary = `${mode}用の構成で動いています。` + summary;
    return { ...rows, summary };
  }

  return { blockerText, estop, permission, describe };
})();
if (typeof module !== 'undefined') module.exports = MotionStateView;
