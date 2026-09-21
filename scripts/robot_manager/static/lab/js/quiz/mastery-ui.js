import { LESSONS } from '../shell/lesson-ui.js';
import { MASTERY_TESTS } from './mastery-data.js';
import {
  MASTERY_STORAGE_KEY,
  newMasteryProgress,
  blankMasteryAnswer,
  beginMastery,
  masteryAnswer,
  masteryMissing,
  gradeMastery,
  submitMastery,
  serializeMastery,
  restoreMastery,
} from './mastery-core.js';

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const valueLabel = (part, value) =>
  value === '?'
    ? 'まだ分からない'
    : part.type === 'number'
      ? value + ' ' + part.unit
      : (part.choices[Number(value)] ?? '未回答');
const correctLabel = (part) =>
  part.type === 'number' ? part.value + ' ' + part.unit : part.choices[part.value];
const evidenceMarkup = (q) =>
  q.evidence
    ? `<div class="mastery-table-wrap"><table class="quiz-evidence"><caption>この問題の条件・測定例</caption><thead><tr>${q.evidence.headers.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${q.evidence.rows.map((row) => '<tr>' + row.map((x) => `<td>${esc(x)}</td>`).join('') + '</tr>').join('')}</tbody></table></div>`
    : '';
function initMastery({ openTest, openExperiment, backToCourse }) {
  const $ = (id) => document.getElementById(id),
    page = $('masteryPage'),
    review = $('masteryReview');
  let progress = newMasteryProgress(),
    course = null,
    resultIndex = null,
    reviewing = null,
    storageAvailable = true;
  try {
    progress = restoreMastery(localStorage.getItem(MASTERY_STORAGE_KEY));
  } catch {
    storageAvailable = false;
  }
  const save = () => {
    try {
      localStorage.setItem(MASTERY_STORAGE_KEY, serializeMastery(progress));
    } catch {
      storageAvailable = false;
    }
    $('masteryStorage')?.replaceChildren(document.createTextNode(storageText()));
  };
  const storageText = () =>
    storageAvailable
      ? '回答はこのブラウザに保存します。教員や外部サービスへ自動送信しません。'
      : 'この環境では回答を保存できません。ページを閉じる前に、結果画面から記録を保存してください。';
  const focus = () => {
    $('masteryTitle')?.focus({ preventScroll: true });
    page.scrollIntoView({ block: 'start' });
  };
  function status(id) {
    const c = progress[id];
    return c?.draft ? '回答の続きから' : c?.last ? '結果と解説を見る' : '実力テストを始める';
  }
  function showReview(active) {
    review.hidden = !reviewing || reviewing.course !== active;
    if (review.hidden) return;
    const { course: c, index } = reviewing,
      q = MASTERY_TESTS[c][index];
    review.innerHTML = `<div class="quiz-review-copy"><p class="eyebrow">実力テスト · 問${index + 1}の復習</p><h2 id="masteryReviewTitle" tabindex="-1">${esc(q.title)}</h2><p>${esc(q.review.action)}</p></div><div class="quiz-review-actions"><button class="primary" id="masteryReturn">テストの解説へ戻る</button><button class="quiet" id="masteryReviewEnd">復習の案内を閉じる</button></div>`;
    $('masteryReturn').onclick = () => {
      course = c;
      resultIndex = index;
      reviewing = null;
      openTest(c);
    };
    $('masteryReviewEnd').onclick = () => {
      reviewing = null;
      review.hidden = true;
    };
  }
  function revisit(index) {
    const c = course,
      q = MASTERY_TESTS[c][index];
    reviewing = { course: c, index };
    if (openExperiment(c, q.review.topic) === false) {
      reviewing = null;
      openTest(c);
      $('masteryContent').insertAdjacentHTML(
        'afterbegin',
        '<p role="alert">学習の処理が終わってから、もう一度「実験で確かめる」を押してください。</p>',
      );
      return;
    }
    showReview(c);
    review.scrollIntoView({ block: 'start' });
    $('masteryReviewTitle').focus({ preventScroll: true });
  }
  function render() {
    const lesson = LESSONS.find((l) => l.id === course),
      c = progress[course],
      qs = MASTERY_TESTS[course];
    page.innerHTML = `<div class="quiz-heading"><button id="masteryBack" class="text-button">← 教材に戻る</button><p class="eyebrow">${esc(lesson.title)} · 実力テスト</p><h1 id="masteryTitle" tabindex="-1">${c.draft ? '別の場面でも、学んだ考え方を使えるか' : resultIndex === null ? '理解できたことと、確かめ直すこと' : '回答の根拠を確かめる'}</h1><p>${c.draft ? '全3問です。問題の条件を読み、答えと根拠をそれぞれ選ぶか入力してください。問3では改善案も書きます。分からない項目はそのまま示せます。時間制限はなく、解説は3問を提出した後に表示します。' : '判断と根拠を分けて採点します。文章の説明は、解答例と確認項目を使って自分で振り返ります。気になった問題から、対応する実験へ戻れます。'}</p></div><div id="masteryContent"></div><p class="quiz-storage" id="masteryStorage">${storageText()}</p>`;
    $('masteryBack').onclick = () => backToCourse(course);
    if (c.draft) renderQuestion();
    else if (resultIndex !== null) renderFeedback();
    else renderSummary();
  }
  function navigate(index) {
    progress[course].draft.index = index;
    save();
    render();
    focus();
  }
  function renderQuestion() {
    const c = progress[course],
      qs = MASTERY_TESTS[course],
      index = c.draft.index,
      q = qs[index],
      a = masteryAnswer(progress, course, index);
    const options = (part, key) =>
      [...part.choices, 'まだ分からない']
        .map((v, i) => {
          const val = i === part.choices.length ? '?' : String(i);
          return `<label class="quiz-choice"><input type="radio" name="${key}" value="${val}" ${a[key === 'masteryValue' ? 'value' : 'reason'] === val ? 'checked' : ''}><span>${esc(v)}</span></label>`;
        })
        .join('');
    $('masteryContent').innerHTML =
      `<nav class="quiz-progress" aria-label="実力テストの問題">${qs.map((p, i) => `<button data-mastery-index="${i}" aria-current="${i === index ? 'step' : 'false'}"><span>問${i + 1}</span><span>${esc(p.title)}</span><b>${masteryMissing(p, c.draft.answers[p.id]).length ? '' : '✓'}</b></button>`).join('')}</nav><section class="card mastery-question"><div class="quiz-scenario"><p class="eyebrow">問${index + 1} / ${qs.length}</p><h2>${esc(q.title)}</h2><p>${esc(q.scene)}</p>${evidenceMarkup(q)}<small>教材の考え方を使うための設問です。あなたの実験記録とは別の条件です。</small></div><form id="masteryForm" class="quiz-answer"><fieldset><legend><span class="mastery-part">1 · 答え</span>${esc(q.answer.prompt)}</legend>${q.answer.type === 'choice' ? `<div class="quiz-choices">${options(q.answer, 'masteryValue')}</div>` : `<label class="mastery-number">数値<input type="text" inputmode="decimal" name="masteryValue" maxlength="30" value="${a.value === '?' ? '' : esc(a.value)}" ${a.value === '?' ? 'disabled' : ''} autocomplete="off"><span>${esc(q.answer.unit)}</span></label><label class="mastery-check"><input type="checkbox" id="masteryUnknown" ${a.value === '?' ? 'checked' : ''}>まだ求められない</label>`}</fieldset><fieldset><legend><span class="mastery-part">2 · 根拠</span>${esc(q.reason.prompt)}</legend><div class="quiz-choices">${options(q.reason, 'masteryReason')}</div></fieldset>${q.writing ? `<fieldset><legend><span class="mastery-part">3 · 自分の説明</span>${esc(q.writing.prompt)}</legend><label for="masteryNote" class="helper">「何を変えるか → 何を比べるか → 結果をどう読むか」をつなげて書いてください。</label><textarea id="masteryNote" rows="5" maxlength="1500" ${a.noteUnknown ? 'disabled' : ''}>${esc(a.note)}</textarea><label class="mastery-check"><input id="masteryNoteUnknown" type="checkbox" ${a.noteUnknown ? 'checked' : ''}>まだ説明できないので、提出後に実験で確かめる</label><p class="helper">文章は自動採点しません。提出後に解答例と比べます。</p></fieldset>` : ''}<p id="masteryValidation" class="quiz-validation" role="alert"></p><div class="quiz-actions"><button class="quiet" type="button" id="masteryPrevious" ${index === 0 ? 'disabled' : ''}>← 前の問題</button><button type="submit" class="primary">${index === qs.length - 1 ? '3問を提出して結果を見る' : '回答を保存して次へ →'}</button></div></form></section>`;
    const capture = () => {
      const value =
        q.answer.type === 'number'
          ? $('masteryUnknown').checked
            ? '?'
            : page.querySelector('[name="masteryValue"]').value
          : page.querySelector('[name="masteryValue"]:checked')?.value || '';
      c.draft.answers[q.id] = {
        value,
        reason: page.querySelector('[name="masteryReason"]:checked')?.value || '',
        note: $('masteryNote')?.value || '',
        noteUnknown: $('masteryNoteUnknown')?.checked || false,
      };
      save();
    };
    $('masteryForm').oninput = capture;
    $('masteryForm').onchange = () => {
      if ($('masteryUnknown'))
        page.querySelector('[name="masteryValue"]').disabled = $('masteryUnknown').checked;
      if ($('masteryNoteUnknown')) $('masteryNote').disabled = $('masteryNoteUnknown').checked;
      capture();
    };
    page.querySelectorAll('[data-mastery-index]').forEach(
      (b) =>
        (b.onclick = () => {
          capture();
          navigate(Number(b.dataset.masteryIndex));
        }),
    );
    $('masteryPrevious').onclick = () => {
      capture();
      navigate(index - 1);
    };
    $('masteryForm').onsubmit = (e) => {
      e.preventDefault();
      capture();
      const missing = masteryMissing(q, c.draft.answers[q.id]);
      if (missing.length) {
        $('masteryValidation').textContent =
          missing.join('・') + 'を記入するか、分からない項目にチェックしてください。';
        return;
      }
      if (index < qs.length - 1) {
        navigate(index + 1);
        return;
      }
      const pending = qs.findIndex((p) => masteryMissing(p, c.draft.answers[p.id]).length);
      if (pending >= 0) {
        navigate(pending);
        $('masteryValidation').textContent = '提出前に、この問題の未回答の項目を確認してください。';
        return;
      }
      submitMastery(progress, course);
      resultIndex = null;
      save();
      render();
      focus();
    };
  }
  function renderSummary() {
    const c = progress[course],
      s = gradeMastery(course, c.last.answers),
      first = gradeMastery(course, c.first.answers),
      qs = MASTERY_TESTS[course];
    const note = c.last.answers[qs[2].id],
      checks = c.last.checks.filter(Boolean).length;
    $('masteryContent').innerHTML =
      `<section class="card quiz-summary"><p class="eyebrow">${c.attempts === 1 ? '初回の提出' : '同じ問題の解き直し · ' + c.attempts + '回目'}</p><h2>答えと根拠が両方合った問題：${s.complete} / ${s.total}</h2><div class="quiz-score"><div><strong>${s.judgment}<small> / ${s.total}</small></strong><span>判断・計算が合っていた</span></div><div><strong>${s.reasoning}<small> / ${s.total}</small></strong><span>根拠が合っていた</span></div><div><strong>${first.complete}<small> / ${first.total}</small></strong><span>初回：両方合っていた</span></div></div><p>答えだけが合っていた問題は、根拠も確かめましょう。解説の「実験で確かめる」から操作する画面へ戻れます。初回の記録は、解き直しても残ります。</p><div class="quiz-result-list">${qs
        .map((q, i) => {
          const r = s.results[i];
          return `<article><div><p class="quiz-result-status">問${i + 1} · ${r.complete ? '答え・根拠ともに正解' : r.judgment ? '答えは正解 · 根拠を確かめる' : r.reasoning ? '根拠は正解 · 判断・計算を確かめる' : '答えと根拠を確かめる'}</p><h3>${esc(q.title)}</h3></div><div class="quiz-actions"><button data-mastery-result="${i}">回答と解説を見る</button><button data-mastery-review="${i}" class="quiet">実験で確かめる ↗</button></div></article>`;
        })
        .join(
          '',
        )}</div><div class="mastery-writing-status"><h3>自分の説明 · 自動採点とは別の振り返り</h3><p>${note.noteUnknown ? 'まだ説明できないと回答しました。' : note.note.trim() ? '説明を記入しました。' : '説明は未記入です。'} 確認項目は${checks} / 3項目を自己確認済みです。文章の内容を自動判定した結果ではありません。</p><button data-mastery-result="2">説明と解答例を比べる</button></div><div class="quiz-actions"><button class="primary" id="masteryRetry">同じ3問を解き直す</button><button id="masteryExport">結果を保存（テキスト）</button><button class="quiet" id="masteryFinish">教材に戻る</button></div></section>`;
    page.querySelectorAll('[data-mastery-result]').forEach(
      (b) =>
        (b.onclick = () => {
          resultIndex = Number(b.dataset.masteryResult);
          render();
          focus();
        }),
    );
    page
      .querySelectorAll('[data-mastery-review]')
      .forEach((b) => (b.onclick = () => revisit(Number(b.dataset.masteryReview))));
    $('masteryRetry').onclick = () => {
      beginMastery(progress, course);
      resultIndex = null;
      save();
      render();
      focus();
    };
    $('masteryFinish').onclick = () => backToCourse(course);
    $('masteryExport').onclick = exportResult;
  }
  function renderFeedback() {
    const c = progress[course],
      q = MASTERY_TESTS[course][resultIndex],
      a = c.last.answers[q.id],
      r = gradeMastery(course, c.last.answers).results[resultIndex];
    $('masteryContent').innerHTML =
      `<section class="card mastery-feedback"><p class="eyebrow">問${resultIndex + 1} · ${esc(q.title)}</p><h2>${r.complete ? '答えと根拠がつながっています' : '判断と根拠をつなげて確認する'}</h2><p>${esc(q.scene)}</p>${evidenceMarkup(q)}<dl class="mastery-answer-review"><div><dt>あなたの答え · ${r.judgment ? '正解' : '要確認'}</dt><dd>${esc(valueLabel(q.answer, a.value))}</dd></div><div><dt>正しい答え</dt><dd>${esc(correctLabel(q.answer))}</dd></div><div><dt>あなたの根拠 · ${r.reasoning ? '正解' : '要確認'}</dt><dd>${esc(valueLabel(q.reason, a.reason))}</dd></div><div><dt>正しい根拠</dt><dd>${esc(correctLabel(q.reason))}</dd></div></dl><div class="mastery-explanation"><h3>なぜ、そう考えるのか</h3><p>${esc(q.explanation)}</p></div>${q.writing ? `<section class="mastery-written"><h3>自分の説明を振り返る</h3><p>${esc(q.writing.prompt)}</p><h4>提出した説明</h4><p class="mastery-own-note">${esc(a.noteUnknown ? 'まだ説明できないと回答しました。' : a.note)}</p><h4>説明の一例</h4><p>${esc(q.writing.model)}</p><p class="helper">同じ文章である必要はありません。自分の説明に次の内容が含まれていたか、確認してください。チェックは自己確認で、自動採点には加えません。</p>${q.writing.criteria.map((v, i) => `<label class="mastery-check"><input type="checkbox" data-mastery-check="${i}" ${c.last.checks[i] ? 'checked' : ''} ${a.noteUnknown || !a.note.trim() ? 'disabled' : ''}>${esc(v)}</label>`).join('')}</section>` : ''}<div class="quiz-observe"><strong>実験で確かめること</strong><p>${esc(q.review.action)}</p></div><div class="quiz-actions"><button class="primary" id="masteryRevisit">実験へ：${esc(q.review.title)} ↗</button><button id="masteryResults">結果の一覧へ</button></div></section>`;
    page.querySelectorAll('[data-mastery-check]').forEach(
      (b) =>
        (b.onchange = () => {
          c.last.checks[Number(b.dataset.masteryCheck)] = b.checked;
          save();
        }),
    );
    $('masteryRevisit').onclick = () => revisit(resultIndex);
    $('masteryResults').onclick = () => {
      resultIndex = null;
      render();
      focus();
    };
  }
  function exportResult() {
    const c = progress[course],
      title = LESSONS.find((l) => l.id === course).title,
      qs = MASTERY_TESTS[course];
    const block = (name, result) => {
      const s = gradeMastery(course, result.answers);
      return (
        name +
        '\n提出：' +
        result.at +
        '\n答えと根拠の両方：' +
        s.complete +
        '/' +
        s.total +
        '\n' +
        qs
          .map((q, i) => {
            const a = result.answers[q.id];
            return (
              '\n問' +
              (i + 1) +
              ' ' +
              q.title +
              '\n答え：' +
              valueLabel(q.answer, a.value) +
              '\n根拠：' +
              valueLabel(q.reason, a.reason) +
              (q.writing ? '\n自分の説明：' + (a.noteUnknown ? 'まだ説明できない' : a.note) : '')
            );
          })
          .join('\n')
      );
    };
    const text =
      'QUESTiX LAB 実力テスト\n' +
      title +
      '\n\n' +
      block('初回', c.first) +
      (c.attempts > 1 ? '\n\n' + block('最新の解き直し（' + c.attempts + '回目）', c.last) : '') +
      '\n\n文章は自動採点していません。最新の説明の自己確認：' +
      c.last.checks.filter(Boolean).length +
      '/3項目\n';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })),
      link = document.createElement('a');
    link.href = url;
    link.download = 'QUESTiX-' + course + '-実力テスト.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return {
    status,
    show(id) {
      if (course !== id) resultIndex = null;
      course = id;
      review.hidden = true;
      if (!progress[id].draft && !progress[id].last) beginMastery(progress, id);
      render();
      focus();
    },
    showCourse: showReview,
    hide() {
      review.hidden = true;
      reviewing = null;
    },
  };
}

export { initMastery };
