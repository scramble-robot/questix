import { SYSTEM_COURSES, SYSTEM_TOPICS, SYSTEM_REAL, systemDefaults } from './data.js';
import {
  simulateSystem,
  systemCSV,
  calibrationPairs,
  fitCameraTransform,
  canRestart,
} from './core.js';
import {
  systemScene,
  systemChart,
  systemDriveState,
  systemDiagnosticState,
  systemTrackingState,
  systemTrackingEvidence,
  systemTimingState,
  systemTimingEvidence,
  SYSTEM_CHARTS,
  systemEscape,
} from './render.js';
import { schoolTips } from '../shell/school-tips.js';
import { lessonBrief } from '../shell/lesson-brief.js';

const states = new Map(),
  esc = systemEscape;
let active = null,
  raf = 0,
  lastTime = 0;
const $ = (id) => document.getElementById(id);
const fmt = (m) =>
  typeof m.value === 'number' ? m.value.toFixed(m.digits) + ' ' + m.unit : m.value;
function topicState(course, id) {
  const key = course + '/' + id;
  if (!states.has(key))
    states.set(key, {
      course,
      id,
      config: systemDefaults(course, id),
      run: null,
      previous: null,
      index: 0,
      elapsed: 0,
      playing: false,
      completed: false,
      speed: 1,
      chart:
        course === 'tracking'
          ? id === 'prediction'
            ? 1
            : id === 'crossing'
              ? 2
              : 0
          : course === 'diagnostics'
            ? id === 'impact'
              ? 2
              : id === 'missing'
                ? 1
                : 0
            : course === 'timing' && id === 'alignment'
              ? 2
              : 0,
      history: [],
      pairs: null,
      released: false,
    });
  return states.get(key);
}
const selected = new Map(SYSTEM_COURSES.map((c) => [c.id, SYSTEM_TOPICS[c.id][0].id]));
function field(c, s) {
  const id = 'sys-' + s.course + '-' + c.key,
    value = s.config[c.key];
  if (c.type === 'check')
    return (
      '<label class="sys-check"><input id="' +
      id +
      '" data-setting="' +
      c.key +
      '" type="checkbox" ' +
      (value ? 'checked' : '') +
      '><span>' +
      c.label +
      (c.note ? '<small>' + c.note + '</small>' : '') +
      '</span></label>'
    );
  return (
    '<label class="sys-field" for="' +
    id +
    '"><span>' +
    c.label +
    (c.unit ? '（' + c.unit + '）' : '') +
    '</span>' +
    (c.type === 'select'
      ? '<select id="' +
        id +
        '" data-setting="' +
        c.key +
        '">' +
        c.options
          .map(
            ([v, l]) =>
              '<option value="' +
              v +
              '" ' +
              (value === v ? 'selected' : '') +
              '>' +
              l +
              '</option>',
          )
          .join('') +
        '</select>'
      : '<input id="' +
        id +
        '" data-setting="' +
        c.key +
        '" type="number" min="' +
        c.min +
        '" max="' +
        c.max +
        '" step="' +
        c.step +
        '" value="' +
        value +
        '">') +
    (c.note ? '<small>' + c.note + '</small>' : '') +
    '</label>'
  );
}
function stopPlayback() {
  if (active) active.playing = false;
  cancelAnimationFrame(raf);
  lastTime = 0;
}
function pause() {
  stopPlayback();
  if (active) update(active);
}
function render(course) {
  const id = selected.get(course),
    s = topicState(course, id),
    meta = SYSTEM_COURSES.find((c) => c.id === course),
    topics = SYSTEM_TOPICS[course],
    topic = topics.find((t) => t.id === id),
    real = SYSTEM_REAL[course];
  $(course + 'Page').innerHTML =
    `<div class="lesson-heading"><p class="eyebrow">${meta.title} <span class="course-terms">${meta.summary}</span></p><h1>${topic.title}</h1></div><nav class="sys-chapters" aria-label="この教材の実験">${topics.map((t, i) => '<button data-chapter="' + t.id + '" aria-current="' + (t.id === id ? 'step' : 'false') + '"><span>' + (i + 1) + '</span>' + t.label + '</button>').join('')}</nav>
 ${lessonBrief(course + '-' + id, topic)}${schoolTips(course + '-' + id)}
 <div class="sys-workspace"><section class="card sys-observation" aria-label="動きとデータ"><div class="sys-live-head"><strong data-sys-status>実験前</strong><span data-sys-clock>0.0 秒</span></div><div class="sys-drive" data-sys-drive hidden><div class="sys-drive-reading"><span data-sys-drive-label></span><strong data-sys-drive-value></strong></div><p data-sys-drive-text></p></div><div data-sys-scene></div><div class="sys-playbar"><button data-sys-pause disabled>一時停止</button><label>再生速度 <select data-sys-speed><option value="1">1倍</option><option value="2">2倍</option><option value="4">4倍</option></select></label><button data-sys-transition hidden></button><label class="sys-seek">再生位置 <input data-sys-seek aria-describedby="${course}-seekhint" aria-label="表示する時刻" type="range" min="0" max="0" value="0" step="1" disabled><span class="sys-seek-time" data-sys-seektime>0.0 / — 秒</span></label><p class="sys-seek-hint" id="${course}-seekhint" data-sys-seekhint></p></div><p class="sys-reading">${topic.observe}</p><div class="sys-data"><label>確認するグラフ <select data-sys-chart>${SYSTEM_CHARTS[course].map((c, i) => ((course === 'diagnostics' && !(id === 'distance' ? [0] : id === 'missing' ? [0, 1] : [2]).includes(i)) || (course === 'tracking' && !(id === 'velocity' ? [0, 3] : id === 'prediction' ? [1, 0, 3] : [2]).includes(i)) || (course === 'timing' && !(id === 'alignment' ? [2] : id === 'queue' ? [0, 1, 3] : [0, 1]).includes(i)) ? '' : '<option value="' + i + '" ' + (s.chart === i ? 'selected' : '') + '>' + c.title + '</option>')).join('')}</select></label><div data-sys-chartview></div><div data-sys-evidence></div><p class="muted">横軸は開始からの時間です。表示した時刻までを描き、前回の記録は、同じ項目の色を保った破線で重ねます。</p></div><div class="sys-events"><h3 data-lesson-cue="observe">起きたこと</h3><ol data-sys-events><li>実験を始めると、条件が変わった時刻や理由がここに残ります。</li></ol></div></section>
 <aside class="card sys-settings"><h2 data-lesson-cue="action">条件を決めて試す</h2><form data-sys-form><fieldset>${topic.controls.map((c) => field(c, s)).join('')}</fieldset><button class="primary full" type="submit" data-sys-run>${s.run ? 'この条件で、もう一度実験する' : 'この条件で実験を始める'}</button><p class="muted" data-sys-settingnote>動きは開始から再生します。途中で止めて、図とグラフを確認できます。</p></form><button type="button" class="full sys-stop-link" data-sys-stoplink hidden>停止の原因を確認して解除する ↓</button>${id === 'calibrate' && course === 'coordination' ? '<div class="sys-calibration"><h3>目印を使って設定を直す</h3><p>3個の目印は、アームの根元からの位置を測ってあります。カメラで測った同じ目印と比べ、取り付け位置と向きを求めます。</p><button data-sys-measure>3か所の対応を測る</button><div data-sys-pairs></div><button data-sys-fit disabled>対応から設定を求める</button><p data-sys-fitmessage role="status"></p></div>' : ''}<details class="sys-hint"><summary>結果を見てから、考えるヒント</summary><p>${topic.hint}</p></details><details data-help-dialog><summary>この実験のしくみ</summary><h2>${topic.label}のしくみ</h2><p>${topic.explanation}</p><p>${real.limit}</p></details></aside></div>
 <section class="card sys-result" data-sys-result hidden aria-live="polite"></section>
 <section class="card sys-restart" data-sys-restart hidden><h2>停止を保持しています</h2><p>センサーの値が戻っただけでは再開しません。この模擬実験では「原因を確認した」操作と、「停止を解除する」操作を分けて確かめます。解除しても走り出さず、次の実験開始を待ちます。</p><label class="sys-check"><input type="checkbox" data-sys-cleared>停止した原因と周囲を確認し、再開できる状態にした</label><button data-sys-release disabled>停止を解除する</button><p data-sys-releasemessage role="status"></p></section>
 <div class="sys-bottom"><details class="card" data-sys-history><summary>同じ実験の記録を比べる（${s.history.length}回）</summary><div data-sys-records></div><button data-sys-csv ${s.completed ? '' : 'disabled'}>今回の時系列データをCSVで保存</button></details><details class="card" data-help-dialog><summary>ROS 2の実機で確かめる</summary><h2>ブラウザから実機の計測へ</h2><p>${real.text}</p><h3>記録の例</h3><p>下のトピック名は例です。実機で配信される名前と、時刻・単位・座標の基準を確認してください。</p><code>ros2 bag record ${real.topics}</code><p>教材のCSVにはシミュレーションの時系列を保存できます。実機のrosbagは直接読み込みません。ROS 2側で必要な列をCSVへ変換し、表計算で時刻と変化を比較します。</p><p>${real.limit}</p>${real.url ? '<p><a href="' + real.url + '" target="_blank" rel="noreferrer">' + real.source + '（公式資料）</a></p>' : ''}</details></div>
 <div class="sys-next"><p>${topics.indexOf(topic) < 2 ? '同じ場面で一つの条件を変えて比べたら、次の実験へ進みます。' : '三つの実験を振り返り、小テストで判断の理由を確かめます。'}</p><button class="primary" data-sys-next>${topics.indexOf(topic) < 2 ? '次へ：' + topics[topics.indexOf(topic) + 1].label : '小テストで確かめる'}</button></div>`;
  const root = $(course + 'Page'),
    find = (q) => root.querySelector(q);
  root
    .querySelectorAll('[data-chapter]')
    .forEach((b) => (b.onclick = () => reviewSystem(course, b.dataset.chapter)));
  find('[data-sys-form]').onsubmit = (e) => {
    e.preventDefault();
    if (s.playing || (s.run?.samples.at(-1).latched && s.completed && !s.released)) return;
    let valid = true;
    for (const c of topic.controls) {
      const el = find('[data-setting="' + c.key + '"]');
      if (
        c.type === 'number' &&
        (!Number.isFinite(Number(el.value)) ||
          Number(el.value) < c.min ||
          Number(el.value) > c.max ||
          el.value === '')
      ) {
        el.reportValidity();
        valid = false;
        break;
      }
      s.config[c.key] =
        c.type === 'check' ? el.checked : c.type === 'number' ? Number(el.value) : el.value;
    }
    if (valid) start(s);
  };
  root.querySelectorAll('[data-setting]').forEach(
    (el) =>
      (el.onchange = () => {
        find('[data-sys-settingnote]').textContent =
          '条件を変更しました。「実験する」で、同じ場面を最初から試します。';
      }),
  );
  find('[data-sys-pause]').onclick = () => {
    if (s.playing) pause();
    else if (s.run) {
      if (s.index === s.run.samples.length - 1) {
        s.elapsed = 0;
        s.index = 0;
      }
      s.playing = true;
      active = s;
      lastTime = 0;
      tick();
    }
  };
  find('[data-sys-transition]').onclick = () => replayTransition(s);
  find('[data-sys-speed]').value = String(s.speed);
  find('[data-sys-speed]').onchange = (e) => (s.speed = Number(e.target.value));
  find('[data-sys-chart]').onchange = (e) => {
    s.chart = Number(e.target.value);
    update(s);
  };
  const seek = find('[data-sys-seek]');
  seek.onpointerdown = () => {
    if (s.run) stopPlayback();
  };
  seek.onkeydown = (e) => {
    if (
      s.run &&
      [
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Home',
        'End',
        'PageUp',
        'PageDown',
      ].includes(e.key)
    )
      stopPlayback();
  };
  seek.oninput = (e) => {
    if (!s.run) return;
    const requested = Number(e.target.value);
    stopPlayback();
    s.index = Math.max(0, Math.min(s.run.samples.length - 1, Math.round(requested)));
    s.elapsed = s.run.samples[s.index].t;
    if (s.index === s.run.samples.length - 1) complete(s);
    update(s);
  };
  seek.onpointerup = () => update(s);
  seek.onpointercancel = () => update(s);
  find('[data-sys-next]').onclick = () => {
    const n = topics.indexOf(topic);
    if (n < 2) reviewSystem(course, topics[n + 1].id);
    else document.dispatchEvent(new CustomEvent('quiz-open', { detail: course }));
  };
  find('[data-sys-csv]').onclick = () => {
    if (!s.run || !s.completed) return;
    const a = document.createElement('a'),
      url = URL.createObjectURL(
        new Blob(['\uFEFF' + systemCSV(s.run)], { type: 'text/csv;charset=utf-8' }),
      );
    a.href = url;
    a.download = 'QUESTiX-' + course + '-' + id + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  find('[data-sys-stoplink]').onclick = () => {
    find('[data-sys-restart]').scrollIntoView({ behavior: 'smooth', block: 'center' });
    find('[data-sys-cleared]').focus({ preventScroll: true });
  };
  find('[data-sys-cleared]').onchange = (e) =>
    (find('[data-sys-release]').disabled = !e.target.checked);
  find('[data-sys-release]').onclick = () => {
    if (canRestart(s.run?.samples.at(-1).latched, find('[data-sys-cleared]').checked, true)) {
      s.released = true;
      find('[data-sys-releasemessage]').textContent =
        '停止を解除しました。次の実験は、実験開始ボタンを押すまで始まりません。';
      find('[data-sys-release]').disabled = true;
      update(s);
    }
  };
  if (id === 'calibrate' && course === 'coordination') {
    find('[data-sys-measure]').onclick = () => {
      s.pairs = calibrationPairs();
      showPairs(s);
    };
    find('[data-sys-fit]').onclick = () => {
      if (!s.pairs) return;
      const fit = fitCameraTransform(s.pairs);
      for (const k of ['cameraX', 'cameraZ', 'cameraAngle']) {
        s.config[k] = Math.round(fit[k] * 100) / 100;
        find('[data-setting="' + k + '"]').value = s.config[k];
      }
      find('[data-sys-fitmessage]').textContent =
        '対応表から求めました。横 ' +
        s.config.cameraX +
        ' mm・高さ ' +
        s.config.cameraZ +
        ' mm・向き ' +
        s.config.cameraAngle +
        '°。同じ目標でもう一度実験してください。';
    };
    if (s.pairs) showPairs(s);
  }
  update(s);
  showResults(s);
  return s;
}
function showPairs(s) {
  const root = $(s.course + 'Page');
  root.querySelector('[data-sys-pairs]').innerHTML =
    '<table><caption>同じ目印を、二つの基準から測った位置（mm）</caption><thead><tr><th>目印</th><th>カメラの向きが基準<br>前, 上</th><th>根元から<br>横, 高さ</th></tr></thead><tbody>' +
    s.pairs
      .map(
        (p, i) =>
          '<tr><th>' +
          (i + 1) +
          '</th><td>' +
          p.camera.x.toFixed(1) +
          ', ' +
          p.camera.z.toFixed(1) +
          '</td><td>' +
          p.body.x +
          ', ' +
          p.body.z +
          '</td></tr>',
      )
      .join('') +
    '</tbody></table>';
  root.querySelector('[data-sys-fit]').disabled = false;
}
function start(s) {
  pause();
  $(s.course + 'Page').querySelector('[data-sys-settingnote]').textContent =
    '表示している条件で実験しています。途中で止めて、図とグラフを確認できます。';
  if (s.completed) s.previous = s.run;
  s.run = simulateSystem(s.course, s.id, s.config);
  s.completed = false;
  s.released = false;
  s.index = 0;
  s.elapsed = 0;
  s.playing = true;
  active = s;
  lastTime = 0;
  showResults(s);
  update(s);
  $(s.course + 'Page')
    .querySelector('.sys-live-head')
    .scrollIntoView({ block: 'start' });
  tick();
}
function replayTransition(s) {
  if (!s.run) return;
  const event = systemDriveState(s.run, s.index)?.event;
  if (!event) return;
  pause();
  s.elapsed = Math.max(0, event.t - 0.8);
  s.index = s.run.samples.findLastIndex((p) => p.t <= s.elapsed);
  s.speed = 1;
  $(s.course + 'Page').querySelector('[data-sys-speed]').value = '1';
  s.playing = true;
  active = s;
  lastTime = 0;
  update(s);
  $(s.course + 'Page')
    .querySelector('.sys-live-head')
    .scrollIntoView({ block: 'start' });
  tick();
}
function complete(s) {
  if (s.completed) return;
  s.completed = true;
  s.history.push(s.run);
  if (s.history.length > 12) s.history.shift();
  showResults(s);
}
function tick(stamp) {
  if (!active?.playing) return;
  const s = active;
  if (stamp !== undefined && lastTime)
    s.elapsed += Math.min((stamp - lastTime) / 1000, 0.1) * s.speed;
  lastTime = stamp ?? 0;
  while (s.index + 1 < s.run.samples.length && s.run.samples[s.index + 1].t <= s.elapsed) s.index++;
  if (s.index === s.run.samples.length - 1) {
    s.playing = false;
    complete(s);
  }
  update(s);
  if (s.playing) raf = requestAnimationFrame(tick);
}
function update(s) {
  const root = $(s.course + 'Page');
  if (!root?.querySelector('[data-sys-scene]')) return;
  root.querySelector('[data-sys-restart] h2').textContent = s.released
    ? '停止を解除しました'
    : '停止を保持しています';
  const run = s.run || simulateSystem(s.course, s.id, s.config),
    sample = run.samples[s.index],
    find = (q) => root.querySelector(q);
  const drive =
    systemDriveState(run, s.index, Boolean(s.run)) ||
    systemDiagnosticState(run, s.index, Boolean(s.run)) ||
    systemTrackingState(run, s.index, Boolean(s.run)) ||
    systemTimingState(run, s.index, Boolean(s.run));
  find('[data-sys-drive]').hidden = !drive;
  const transitionButton = find('[data-sys-transition]');
  transitionButton.hidden = !drive?.event;
  transitionButton.disabled = !s.run;
  if (drive) {
    find('[data-sys-drive]').dataset.mode = drive.mode;
    find('[data-sys-drive-label]').textContent = drive.label;
    find('[data-sys-drive-value]').textContent = drive.value;
    find('[data-sys-drive-text]').textContent = drive.text;
    transitionButton.textContent = drive.replay;
  }
  find('[data-sys-scene]').innerHTML = systemScene(run, s.index);
  find('[data-sys-chartview]').innerHTML = systemChart(run, s.index, s.chart, s.previous);
  find('[data-sys-evidence]').innerHTML =
    systemTrackingEvidence(run, s.index, Boolean(s.run)) ||
    systemTimingEvidence(run, s.index, Boolean(s.run));
  find('[data-sys-status]').textContent = !s.run
    ? '実験前'
    : (s.playing
        ? ''
        : s.completed && s.index === run.samples.length - 1
          ? '実験終了 · '
          : '一時停止 · ') + sample.status;
  find('[data-sys-clock]').textContent = sample.t.toFixed(1) + ' 秒';
  const pauseButton = find('[data-sys-pause]');
  pauseButton.disabled = !s.run;
  pauseButton.textContent = s.playing
    ? '一時停止'
    : s.index === run.samples.length - 1
      ? '動きを最初から見る'
      : '再生する';
  const seek = find('[data-sys-seek]');
  seek.disabled = !s.run;
  seek.max = String(run.samples.length - 1);
  seek.value = String(s.index);
  seek.setAttribute(
    'aria-valuetext',
    sample.t.toFixed(2) + '秒 / 全体 ' + run.duration.toFixed(2) + '秒',
  );
  find('[data-sys-seektime]').textContent = s.run
    ? sample.t.toFixed(1) + ' / ' + run.duration.toFixed(1) + ' 秒'
    : '0.0 / — 秒';
  find('[data-sys-seekhint]').textContent = s.run
    ? 'つまみを動かすと一時停止し、その時刻の動きとグラフを確認できます。'
    : '実験を始めると、再生位置を動かして途中の様子を確認できます。';
  find('[data-sys-form] fieldset').disabled = s.playing;
  find('[data-sys-run]').disabled =
    s.playing || Boolean(s.completed && run.samples.at(-1).latched && !s.released);
  find('[data-sys-run]').textContent = s.playing
    ? '実験中'
    : s.completed && run.samples.at(-1).latched && !s.released
      ? '下の停止確認で解除する'
      : s.run
        ? 'この条件で、もう一度実験する'
        : 'この条件で実験を始める';
  find('[data-sys-stoplink]').hidden = !(s.completed && run.samples.at(-1).latched && !s.released);
  const events = s.run ? run.events.filter((e) => e.t <= sample.t + 1e-8).slice(-6) : [];
  find('[data-sys-events]').innerHTML = events.length
    ? events
        .map((e) => '<li><time>' + e.t.toFixed(1) + '秒</time>' + esc(e.text) + '</li>')
        .join('')
    : '<li>' +
      (s.run
        ? '条件の切り替わりは、まだありません。'
        : '実験を始めると、条件が変わった時刻や理由がここに残ります。') +
      '</li>';
  root
    .querySelectorAll('[data-sys-measure],[data-sys-fit]')
    .forEach((el) => (el.disabled = s.playing || (el.hasAttribute('data-sys-fit') && !s.pairs)));
}
function showResults(s) {
  const root = $(s.course + 'Page'),
    result = root.querySelector('[data-sys-result]');
  if (!result) return;
  result.hidden = !s.completed;
  if (s.completed) {
    const changed = s.previous
      ? Object.keys(s.config)
          .filter((k) => s.run.config[k] !== s.previous.config[k])
          .map(
            (k) =>
              SYSTEM_TOPICS[s.course].find((t) => t.id === s.id).controls.find((c) => c.key === k)
                .label,
          )
      : [];
    result.innerHTML =
      '<h2 data-lesson-cue="result">今回の結果</h2><p>' +
      s.run.outcome +
      '</p><div class="sys-metrics">' +
      s.run.metrics
        .map(
          (m, i) =>
            '<div><span>' +
            m.label +
            '</span><strong>' +
            fmt(m) +
            '</strong>' +
            (s.previous ? '<small>前回 ' + fmt(s.previous.metrics[i]) + '</small>' : '') +
            '</div>',
        )
        .join('') +
      '</div><p>' +
      (s.previous
        ? changed.length
          ? '前回から変えた条件：' + changed.join('、')
          : '前回と同じ条件です。'
        : '次は条件を一つ変えてみましょう。結果とグラフに前回の記録が残ります。') +
      '</p>' +
      (changed.length > 1
        ? '<p class="muted">' +
          (s.course === 'coordination' && s.id === 'calibrate'
            ? 'この実験では、目印の測定から取り付け位置と向きの組み合わせを求めます。三つの設定を合わせて直し、同じ物へ手を伸ばした結果で確かめます。'
            : '複数の条件を変えています。一つずつ変えると、どの条件が影響したかを確かめやすくなります。') +
          '</p>'
        : '');
  }
  root.querySelector('[data-sys-restart]').hidden = !(
    s.completed &&
    s.run.samples.at(-1).latched &&
    !s.released
  );
  root.querySelector('[data-sys-cleared]').checked = false;
  root.querySelector('[data-sys-release]').disabled = true;
  root.querySelector('[data-sys-history] summary').textContent =
    '同じ実験の記録を比べる（' + s.history.length + '回）';
  root.querySelector('[data-sys-records]').innerHTML = s.history.length
    ? '<div class="table-scroll"><table><thead><tr><th>実験</th><th>使った条件</th>' +
      s.history[0].metrics.map((m) => '<th>' + m.label + '</th>').join('') +
      '</tr></thead><tbody>' +
      s.history
        .map(
          (r, i) =>
            '<tr><th>' +
            (i + 1) +
            '</th><td>' +
            SYSTEM_TOPICS[s.course]
              .find((t) => t.id === s.id)
              .controls.map(
                (c) =>
                  c.label +
                  '：' +
                  (c.type === 'select'
                    ? c.options.find((o) => o[0] === r.config[c.key])[1]
                    : c.type === 'check'
                      ? r.config[c.key]
                        ? '使う'
                        : '使わない'
                      : r.config[c.key] + c.unit),
              )
              .map(esc)
              .join('<br>') +
            '</td>' +
            r.metrics.map((m) => '<td>' + fmt(m) + '</td>').join('') +
            '</tr>',
        )
        .join('') +
      '</tbody></table></div>'
    : '<p>実験の終了時点まで確認した結果が残ります（このページを開いている間、直近12回）。</p>';
  root.querySelector('[data-sys-csv]').disabled = !s.completed;
}
function initSystems() {
  for (const c of SYSTEM_COURSES) render(c.id);
  for (const name of ['series-leave', 'supplement-open']) document.addEventListener(name, pause);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });
}
function activateSystem(course) {
  if (!SYSTEM_TOPICS[course]) return;
  active = topicState(course, selected.get(course));
  update(active);
}
function reviewSystem(course, id) {
  if (!SYSTEM_TOPICS[course]?.some((t) => t.id === id)) return false;
  pause();
  selected.set(course, id);
  active = render(course);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  return true;
}

export { initSystems, activateSystem, reviewSystem };
