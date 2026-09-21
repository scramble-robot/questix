import { measurementStats, fitMeasurement, parseMeasurementCSV } from './measurement-core.js';
import { systemEscape } from './render.js';

const contexts = {
  control: {
    x: 'モーター出力（%）',
    y: '回転数（rpm）',
    base: 1.2,
    bias: 4,
    spread: 2,
    ref: 48,
    text: '車輪を狙った速さで回すため、出力を変えて測った回転数の記録を調べます。同じ出力でも値が揺れる場合があるので、まず繰り返した結果を比べます。別の測定器で確かめた値があれば、センサーの平均的なずれも調べられます。',
  },
  launch: {
    x: 'ローラーへの出力（%）',
    y: '飛距離（m）',
    base: 0.03,
    bias: 0.1,
    spread: 0.08,
    ref: 1.2,
    text: '的に届きやすい出力を選ぶため、同じ出力で複数回飛ばした距離を比べます。毎回近い所へ落ちることと、その中心が的に合うことは別です。基準との差には射出条件の違いも含まれるので、計測器の誤差と決めつけません。',
  },
  slam: {
    x: '床で測った移動距離（cm）',
    y: '車輪から求めた距離（cm）',
    base: 1.03,
    bias: 1,
    spread: 1,
    ref: 40,
    text: '車輪の回転から現在地を正しく求めるため、計算した移動距離が実際と合うか確かめます。床の印で測った移動距離と、車輪の回転から求めた距離を記録します。同じ走行を繰り返すと、散らばりと一定方向のずれを分けて考えられます。',
  },
};
const memory = new Map();
let current = null;
function examples(c) {
  return [20, 40, 60]
    .flatMap((x) =>
      [-1, 0.4, 0.6].map((n) => ({
        x,
        y: +(c.base * x + c.bias + n * c.spread).toFixed(3),
        test: false,
      })),
    )
    .concat([{ x: 50, y: +(c.base * 50 + c.bias + c.spread * 0.7).toFixed(3), test: true }]);
}
function state(id) {
  if (!memory.has(id))
    memory.set(id, {
      rows: examples(contexts[id]),
      reference: contexts[id].ref,
      selectedX: 40,
      mode: 'repeat',
      source: '模擬測定例',
      correct: false,
    });
  return memory.get(id);
}
const f = (x) => (Number.isFinite(x) ? x.toFixed(3) : '—');
function drawPlot(rows, fit, correction = 0) {
  const maxX = Math.max(1, ...rows.map((r) => r.x)),
    minX = Math.min(0, ...rows.map((r) => r.x)),
    ys = rows.map((r) => r.y + correction),
    lo = Math.min(0, ...ys),
    hi = Math.max(1, ...ys),
    X = (x) => 60 + ((x - minX) / (maxX - minX)) * 590,
    Y = (y) => 210 - ((y - lo) / (hi - lo)) * 170;
  return (
    '<svg viewBox="0 0 730 250" role="img" aria-label="横軸は入力、縦軸は測定値。緑は式づくり、黄色は確認用の点。"><rect width="730" height="250" fill="#f6f8f9"/><path d="M60,25V210H665" stroke="#8a9ca2" fill="none"/>' +
    rows
      .map(
        (r) =>
          '<circle cx="' +
          X(r.x) +
          '" cy="' +
          Y(r.y + correction) +
          '" r="5" fill="' +
          (r.test ? '#c18837' : '#418777') +
          '"/>',
      )
      .join('') +
    (fit
      ? '<path d="M' +
        X(fit.min) +
        ',' +
        Y(fit.slope * fit.min + fit.intercept + correction) +
        'L' +
        X(fit.max) +
        ',' +
        Y(fit.slope * fit.max + fit.intercept + correction) +
        '" stroke="#5d83bf" stroke-width="2"/>'
      : '') +
    '<text x="60" y="236" font-size="14">' +
    f(minX) +
    '</text><text x="610" y="236" font-size="14">' +
    f(maxX) +
    '</text><text x="5" y="40" font-size="14">' +
    f(hi) +
    '</text><text x="5" y="210" font-size="14">' +
    f(lo) +
    '</text></svg>'
  );
}
function refresh(panel, s, c) {
  const rows = s.rows,
    groups = [...new Set(rows.map((r) => r.x))].sort((a, b) => a - b),
    group = rows.filter((r) => r.x === s.selectedX).map((r) => r.y),
    stats = measurementStats(group),
    fit = fitMeasurement(rows),
    correction = s.correct && stats ? s.reference - stats.mean : 0;
  panel.querySelector('[data-measure-plot]').innerHTML = drawPlot(
    rows,
    s.mode === 'model' ? fit : null,
    s.mode === 'calibrate' ? correction : 0,
  );
  panel.querySelector('[data-measure-result]').innerHTML =
    s.mode === 'repeat'
      ? '<p>同じ入力の測定をまとめます。平均は中心、標準偏差は平均の周りへの散らばりの目安です。ここではデータ全体の分散を件数で割って計算します。</p><table><thead><tr><th>入力</th><th>回数</th><th>平均</th><th>最小〜最大</th><th>標準偏差</th></tr></thead><tbody>' +
        groups
          .map((x) => {
            const a = measurementStats(rows.filter((r) => r.x === x).map((r) => r.y));
            return (
              '<tr><th>' +
              x +
              '</th><td>' +
              a.n +
              '</td><td>' +
              f(a.mean) +
              '</td><td>' +
              f(a.min) +
              '〜' +
              f(a.max) +
              '</td><td>' +
              (a.n > 1 ? f(a.sd) : '1回のみ') +
              '</td></tr>'
            );
          })
          .join('') +
        '</tbody></table><p>まず同じ入力を数回記録してください。1回だけなら散らばりは評価できません。平均だけが同じでも、毎回の結果は違うことがあります。</p>'
      : s.mode === 'calibrate'
        ? stats
          ? '<p>入力 ' +
            s.selectedX +
            ' の平均 ' +
            f(stats.mean) +
            ' に対し、独立した基準の値は ' +
            f(s.reference) +
            ' です。</p><p>差（基準 − 平均）= <strong>' +
            f(s.reference - stats.mean) +
            '</strong>。' +
            (s.correct
              ? 'この差を全測定へ加えた図を表示しています。'
              : 'まだ補正は適用していません。') +
            '</p><p>一定の差を足しても散らばりは変わりません。これは一定の偏りを調べる例で、入力に比例した誤差や滑りには別の補正が必要です。別の入力でも確認してください。</p>'
          : '<p>選んだ入力のデータがありません。</p>'
        : fit
          ? '<p>式づくり用の点から <strong>y = ' +
            f(fit.slope) +
            ' × x ' +
            (fit.intercept < 0 ? '− ' : '+ ') +
            f(Math.abs(fit.intercept)) +
            '</strong> を求めました。</p><p>緑が式に使った点、黄色が式に使わず残した確認用の点です。直線は測った入力範囲だけに描きます。</p>' +
            (fit.predictions.length
              ? '<table><thead><tr><th>確認用入力</th><th>予測</th><th>実測</th><th>予測 − 実測</th></tr></thead><tbody>' +
                fit.predictions
                  .map(
                    (r) =>
                      '<tr><td>' +
                      r.x +
                      '</td><td>' +
                      f(r.predicted) +
                      '</td><td>' +
                      f(r.y) +
                      '</td><td>' +
                      f(r.error) +
                      (r.inside ? '' : '（測定範囲の外）') +
                      '</td></tr>',
                  )
                  .join('') +
                '</tbody></table>'
              : '<p>「確認用」の点を少なくとも1つ残してください。同じ点だけで式を作り、同じ点だけで評価すると、別の条件でも当たるか分かりません。</p>') +
            '<p>直線は近似です。式ができたことと、実物を正しく予測できることは別なので、新しい測定で確かめます。</p>'
          : '<p>式づくり用に、異なる入力を少なくとも2つ用意してください。</p>';
}
function render(id) {
  const host = document.getElementById('measurementEntry');
  if (!host) return;
  host.hidden = !contexts[id];
  if (!contexts[id]) return;
  current = id;
  const c = contexts[id],
    s = state(id);
  host.innerHTML =
    '<details data-help-dialog><summary>測定データを分析する · 平均・校正・予測</summary><div class="measurement-lab"><h2>繰り返し測り、実物に合う説明を探す</h2><p>' +
    c.text +
    '</p><p>まず「平均とばらつき」で、同じ入力の値がどれだけ散らばるか見てください。「測定から式を作る」では、まだ測っていない入力での結果を見積もり、残しておいた測定値で確かめます。</p><p>最初は<strong>模擬測定例</strong>です。教材内の直前の走行や実機のログを自動で読み込んだ値ではありません。表を自分の測定値に直すか、CSVを読み込んで使えます。</p><label>調べる内容 <select data-measure-mode><option value="repeat">1. 平均とばらつき</option><option value="calibrate">2. 基準と比べて補正する</option><option value="model">3. 測定から式を作り、予測を確かめる</option></select></label><p>横軸：' +
    c.x +
    ' ／ 縦軸：' +
    c.y +
    '</p><div data-measure-plot></div><div data-measure-calibration><label>比較する入力 <input data-measure-x type="number" value="' +
    s.selectedX +
    '"></label><label>別に測った基準の値（狙いたい目標値ではありません） <input data-measure-reference type="number" step="any" value="' +
    s.reference +
    '"></label><label class="sys-check"><input type="checkbox" data-measure-correct ' +
    (s.correct ? 'checked' : '') +
    '>基準との差を全体へ加えてみる（元の表は残す）</label></div><div data-measure-result></div><h3>測定の表</h3><p data-measure-source>使用中：' +
    systemEscape(s.source) +
    '</p><div class="table-scroll"><table><thead><tr><th>' +
    c.x +
    '</th><th>' +
    c.y +
    '</th><th>式に使わず確認用に残す</th><th></th></tr></thead><tbody data-measure-rows></tbody></table></div><button data-measure-add>測定を1行追加する</button><div class="measurement-import"><label>測定CSVを開く <input data-measure-file type="file" accept=".csv,text/csv"></label><button data-measure-export>この表をCSVで保存する</button><p>列は x,y,test。testは確認用なら1、式づくり用なら0です。単位は上の表にそろえ、1〜200行にしてください。</p><p data-measure-message role="status"></p></div></div></details>';
  const panel = host.querySelector('.measurement-lab'),
    find = (q) => panel.querySelector(q);
  function table() {
    find('[data-measure-rows]').innerHTML = s.rows
      .map(
        (r, i) =>
          '<tr><td><input aria-label="' +
          (i + 1) +
          '行目の入力" data-row="' +
          i +
          '" data-col="x" type="number" step="any" value="' +
          r.x +
          '"></td><td><input aria-label="' +
          (i + 1) +
          '行目の測定" data-row="' +
          i +
          '" data-col="y" type="number" step="any" value="' +
          r.y +
          '"></td><td><input aria-label="' +
          (i + 1) +
          '行目を確認用にする" data-row="' +
          i +
          '" data-col="test" type="checkbox" ' +
          (r.test ? 'checked' : '') +
          '></td><td><button data-remove="' +
          i +
          '" aria-label="' +
          (i + 1) +
          '行目を削除">削除</button></td></tr>',
      )
      .join('');
    panel.querySelectorAll('[data-row]').forEach(
      (el) =>
        (el.onchange = () => {
          const r = s.rows[Number(el.dataset.row)],
            k = el.dataset.col;
          if (k === 'test') r[k] = el.checked;
          else if (el.value !== '' && Number.isFinite(Number(el.value))) r[k] = Number(el.value);
          else {
            el.value = r[k];
            find('[data-measure-message]').textContent = '有限の数値を入力してください。';
            return;
          }
          s.source = '編集した測定表';
          find('[data-measure-source]').textContent = '使用中：' + s.source;
          refresh(panel, s, c);
        }),
    );
    panel.querySelectorAll('[data-remove]').forEach(
      (b) =>
        (b.onclick = () => {
          s.rows.splice(Number(b.dataset.remove), 1);
          table();
          refresh(panel, s, c);
        }),
    );
  }
  find('[data-measure-mode]').value = s.mode;
  const mode = () => {
    s.mode = find('[data-measure-mode]').value;
    find('[data-measure-calibration]').hidden = s.mode !== 'calibrate';
    refresh(panel, s, c);
  };
  find('[data-measure-mode]').onchange = mode;
  for (const [q, key] of [
    ['x', 'selectedX'],
    ['reference', 'reference'],
  ])
    find('[data-measure-' + q + ']').onchange = (e) => {
      if (e.target.value !== '' && Number.isFinite(Number(e.target.value)))
        s[key] = Number(e.target.value);
      refresh(panel, s, c);
    };
  find('[data-measure-correct]').onchange = (e) => {
    s.correct = e.target.checked;
    refresh(panel, s, c);
  };
  find('[data-measure-add]').onclick = () => {
    if (s.rows.length >= 200) return;
    s.rows.push({ x: s.selectedX, y: 0, test: false });
    table();
    refresh(panel, s, c);
  };
  find('[data-measure-file]').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      if (file.size > 100000) throw new Error('100 KB以下のCSVを使ってください。');
      s.rows = parseMeasurementCSV(await file.text());
      s.source = file.name;
      find('[data-measure-source]').textContent = '使用中：' + s.source;
      find('[data-measure-message]').textContent = s.rows.length + '行を読み込みました。';
      table();
      refresh(panel, s, c);
    } catch (err) {
      find('[data-measure-message]').textContent = err.message;
    }
  };
  find('[data-measure-export]').onclick = () => {
    const url = URL.createObjectURL(
        new Blob(
          ['\uFEFFx,y,test\n' + s.rows.map((r) => [r.x, r.y, r.test ? 1 : 0].join(',')).join('\n')],
          { type: 'text/csv;charset=utf-8' },
        ),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = 'QUESTiX-measurements-' + id + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  table();
  mode();
}
function showMeasurementLab(course) {
  render(course);
}

export { showMeasurementLab };
