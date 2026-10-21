/* Permission requests are distinct from confirmed Manager state and from ROS safety decisions. */
const PermissionView = (() => {
  const LABELS = {
    none: '許可しない', controller: 'コントローラーのみ', controller_and_lab: 'コントローラーと教材',
  };
  const CONFLICT = 'ほかの画面で許可が変わりました。いまの状態を確かめて、もう一度選んでください';
  const TIMEOUT_MS = 5000;
  function unavailable(state) {
    if (!state) return '確認不能：許可の状態を取得できません';
    if (['practice', 'competition'].includes(state.mode)) {
      return '練習モードと大会モードでは、この許可は使いません（教材モードだけで使います）';
    }
    if (state.mode !== 'lesson') return '保存モードを確認できません';
    if (state.running_mode === null) return 'ロボット制御が停止中のため選べません';
    if (!['lesson', 'practice', 'competition'].includes(state.running_mode)) return '実行中のモードを確認できません';
    if (state.running_mode !== state.mode) return '保存モードと実行中のモードが一致しません';
    return state.available === true ? '' : '利用できるか確認できません';
  }

  function createController({ read, write, render, timeoutMs = TIMEOUT_MS }) {
    let state = null, known = false, pending = null, error = '', blocked = 0;
    let barrier = 0, reads = 0, appliedRead = 0;
    const retired = new Set();
    const view = () => ({ state, known, pending, error, blocked: blocked > 0 });
    const draw = () => render(view());
    function accept(answer) {
      if (!answer || typeof answer.instance !== 'string' || !Number.isSafeInteger(answer.revision) ||
          !['drive', 'launcher'].every(k => Object.hasOwn(LABELS, answer.choices?.[k])) ||
          retired.has(answer.instance)) return false;
      if (state?.instance === answer.instance && answer.revision < state.revision) return false;
      if (state && state.instance !== answer.instance) retired.add(state.instance);
      state = answer;
      known = true;
      return true;
    }
    async function bounded(fn) {
      const abort = new AbortController();
      let timer;
      try {
        return await Promise.race([
          fn(abort.signal),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              abort.abort();
              reject(new Error('確認不能：要求が時間切れになりました。状態を取り直します'));
            }, timeoutMs);
          }),
        ]);
      } finally { clearTimeout(timer); }
    }
    async function refresh() {
      if (blocked) return;
      const ticket = ++reads, generation = barrier;
      try {
        const answer = await bounded(signal => read(signal));
        if (generation !== barrier || ticket < appliedRead || blocked) return;
        appliedRead = ticket;
        accept(answer);
      } catch {
        if (generation !== barrier || ticket < appliedRead || blocked) return;
        appliedRead = ticket;
        known = false;
      }
      draw();
    }
    async function choose(kind, choice) {
      if (pending || blocked || !known || unavailable(state) || !Object.hasOwn(LABELS, choice)) {
        draw(); return;
      }
      const generation = ++barrier;
      pending = { kind, choice };
      error = '';
      draw(); // Synchronous, before write: no second input may start another request.
      try {
        const answer = await bounded(signal => write(kind, {
          choice, instance: state.instance, revision: state.revision,
        }, signal));
        if (generation !== barrier) return;
        if (!accept(answer)) throw new Error('確認不能：確定した状態を確認できません');
      } catch (failure) {
        if (generation !== barrier) return;
        known = false;
        error = failure.reason === 'stale_revision' ? CONFLICT : failure.message;
        if (failure.state) accept(failure.state);
      } finally {
        if (generation === barrier) {
          pending = null;
          draw();
          if (error) await refresh(); // Read only: never retry a grant after failure/reconnect.
        }
      }
    }
    function block() {
      blocked++;
      barrier++;
      pending = null;
      known = false;
      draw();
    }
    async function settle(answer) {
      blocked = Math.max(0, blocked - 1);
      if (answer) accept(answer);
      draw(); // A stop response is reflected now, before the next poll.
      if (!blocked) await refresh();
    }
    return { view, refresh, choose, block, settle };
  }
  return { LABELS, CONFLICT, TIMEOUT_MS, unavailable, createController };
})();
if (typeof module !== 'undefined') module.exports = PermissionView;
