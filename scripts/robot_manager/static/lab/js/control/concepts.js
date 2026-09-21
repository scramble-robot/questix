import { pidStep } from './core.js';

// A learner supplies measurements by hand. This demonstrates one calculation,
// not the response of a second physical robot or a new controller setting.
function controlConceptStep(kind, measured, accumulated = 0) {
  const distance = kind === 'd',
    error = distance ? 0 : (60 - measured) / 100;
  const memory = { integral: accumulated / 100, previous: distance ? -1 : measured / 100 };
  const parts = pidStep(memory, {
    error,
    measurement: distance ? -measured : measured / 100,
    kp: kind === 'p' ? 1.2 : 0,
    ki: kind === 'i' ? 1 : 0,
    kd: kind === 'd' ? 1 : 0,
    dt: 1,
    filter: 0,
    antiWindup: false,
  });
  return {
    error: distance ? measured - 1 : 60 - measured,
    correction: parts[kind] * 100,
    command: parts.command * 100,
  };
}

function controlConceptLesson(kind) {
  if (!['p', 'i', 'd'].includes(kind)) return '';
  const distance = kind === 'd';
  const intro = {
    p: '車輪を60 rpmで回したいのに、測った速さが50 rpmなら、10 rpm足りません。Pはこの差に一定の倍率を掛け、出力を決めます。測定値を変え、足りない場合と速すぎる場合を比べてください。',
    i: '車輪を60 rpmまで速くしたいのに、50 rpmのままなら出力を少しずつ追加します。Iは、10 rpmのずれが1秒続いた分を、1秒ごとに積み重ねます。2回進めたら測定値を60 rpmにし、もう1秒進めてください。ずれがなくなっても、それまでのIの補正は残るでしょうか。',
    d: '壁の50 cm手前で行き過ぎずに止めるため、近づく勢いに応じて前進の指示を弱めます。壁までの距離が1秒前には1.00 mだったとします。今の距離を変えて、壁へ近づいた場合、離れた場合、変わらない場合を比べてください。Dは距離そのものではなく、1秒間に変わった量を使います。',
  }[kind];
  return `<details data-help-dialog class="control-concept"><summary>${kind.toUpperCase()}の計算を、数値を変えて確かめる</summary><div class="control-concept-body"><p>${intro}</p><p class="helper">${distance ? '前進を正とする指示の補正を求めます。Dの倍率は1、変化をなめらかにするフィルターは使いません。' : 'rpmは1分間の回転数です。この例では、ずれ1 rpmに対して' + (kind === 'p' ? 'Pの出力は1.2%。Pの倍率は1.2です。' : '1秒ごとにIの補正を1%ずつ加えます。Iの倍率は1です。')}</p><label class="control-concept-input" for="conceptMeasured">${distance ? '壁までの距離を仮に決める' : '車輪の回転数を仮に決める'}<span><input id="conceptMeasured" type="number" min="${distance ? '.5' : '0'}" max="${distance ? '1.5' : '100'}" step="${distance ? '.1' : '10'}" value="${distance ? '.8' : '50'}"> ${distance ? 'm' : 'rpm'}</span></label>${kind === 'i' ? '<div class="control-concept-actions"><button id="conceptAdvance" class="primary">この測定値のまま1秒進める</button><button id="conceptReset">積み重ねを0に戻す</button></div>' : ''}<div id="conceptResult" class="control-concept-result" role="status" aria-live="polite"></div><p class="helper">計算の仕組みを確かめる例です。入力した測定値は自動では変わりません。もとのロボット実験の設定や記録には影響しません。</p></div></details>`;
}

function bindControlConcept(kind) {
  if (!['p', 'i', 'd'].includes(kind)) return;
  const $ = (id) => document.getElementById(id),
    input = $('conceptMeasured');
  if (!input) return;
  let total = 0,
    seconds = 0,
    last = null;
  const num = (n, d = 1) => Number(n).toFixed(d),
    signed = (n, d = 1) => (n < 0 ? '−' : n > 0 ? '＋' : '') + num(Math.abs(n), d);
  const row = (label, value) => `<div><span>${label}</span><strong>${value}</strong></div>`;
  function reading() {
    const n = Number(input.value),
      valid =
        input.value !== '' &&
        Number.isFinite(n) &&
        n >= Number(input.min) &&
        n <= Number(input.max);
    if ($('conceptAdvance')) $('conceptAdvance').disabled = !valid;
    return valid ? n : null;
  }
  function draw() {
    const measured = reading();
    if (measured === null) {
      $('conceptResult').textContent = `${input.min}〜${input.max}の範囲で数値を入力してください。`;
      return;
    }
    const r = controlConceptStep(kind, measured, total);
    if (kind === 'p')
      $('conceptResult').innerHTML =
        row('目標と測定値の差', `60 − ${num(measured)} = ${signed(r.error)} rpm`) +
        row('差にPの倍率を掛けた出力', `${signed(r.error)} × 1.2 = ${signed(r.correction)}%`) +
        `<p>${r.error > 0 ? '目標より遅いので、正方向へ回す出力を出します。' : r.error < 0 ? '目標より速いので、逆方向の出力で回転を弱めます。' : 'ずれが0なので、Pだけで求めた出力も0です。'}前の出力に毎回足す計算ではありません。</p>`;
    else if (kind === 'i')
      $('conceptResult').innerHTML =
        row('今のずれ', `60 − ${num(measured)} = ${signed(r.error)} rpm`) +
        row(`${seconds}秒間で積み重ねたIの補正`, `${signed(total)}%`) +
        (last
          ? `<p>前回の補正は${signed(last.before)}%です。${signed(last.error)} rpmのずれが1秒続いた分として${signed(last.error)}%を加え、${signed(total)}%になりました。</p>`
          : '<p>まだ時間を進めていないので、積み重ねは0です。</p>') +
        `<p>この測定値で次の1秒を進めると、${signed(r.error)}%を加えます。${r.error === 0 ? '新たに加える量が0でも、それまでの補正は消えません。' : r.error < 0 ? '目標より速い間は、積み重ねが減ります。' : '目標より遅い間は、積み重ねが増えます。'}</p>` +
        (Math.abs(total) > 100
          ? '<p>補正が100%を超えました。実際の出力には上限があります。後の「出力には上限がある」で調べます。</p>'
          : '');
    else
      $('conceptResult').innerHTML =
        row('1秒間の距離の変化', `${num(measured, 2)} − 1.00 = ${signed(r.error, 2)} m`) +
        row('距離が変わる速さ', `${signed(r.error, 2)} ÷ 1秒 = ${signed(r.error, 2)} m/秒`) +
        row('Dによる指示の補正', `${signed(r.correction)}%`) +
        `<p>${r.error < 0 ? '距離が減っているので、Dは前進の指示を弱めます。' : r.error > 0 ? '距離が増えているので、Dは後退の指示を弱める方向に働きます。' : '距離が変わらなければDの補正は0です。目標まで距離が残っていても、Dだけでは近づけません。'}この例では0.1 m/秒の変化に対し、10%分の補正になります。Pなどの補正と足して、最終的な指示を決めます。</p>`;
  }
  input.oninput = draw;
  if (kind === 'i') {
    $('conceptAdvance').onclick = () => {
      const measured = reading();
      if (measured === null) return;
      const r = controlConceptStep(kind, measured, total);
      last = { before: total, error: r.error };
      total = r.correction;
      seconds++;
      draw();
    };
    $('conceptReset').onclick = () => {
      total = 0;
      seconds = 0;
      last = null;
      draw();
    };
  }
  draw();
}

export { controlConceptStep, controlConceptLesson, bindControlConcept };
