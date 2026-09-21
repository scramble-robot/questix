import { LESSONS } from '../shell/lesson-ui.js';
import { lessonIcon } from '../shell/lesson-icons.js';
import { QUIZZES } from './data.js';
import {
  QUIZ_STORAGE_KEY,
  newQuizProgress,
  quizAnswer,
  checkQuizAnswer,
  retryQuizAnswer,
  quizSummary,
  restoreQuizProgress,
  serializeQuizProgress,
} from './core.js';

const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
function initQuizzes({ openQuiz, openExperiment, backToCourse, openMastery, masteryStatus }) {
  const $ = (id) => document.getElementById(id),
    page = $('quizPage'),
    entry = $('quizEntry'),
    review = $('quizReview');
  let progress = newQuizProgress(),
    course = null,
    reviewing = null,
    storageAvailable = true;
  try {
    progress = restoreQuizProgress(localStorage.getItem(QUIZ_STORAGE_KEY));
  } catch {
    storageAvailable = false;
  }
  const save = () => {
    try {
      localStorage.setItem(QUIZ_STORAGE_KEY, serializeQuizProgress(progress));
    } catch {
      storageAvailable = false;
    }
  };
  const status = (a) =>
    !a?.checked
      ? '未回答'
      : a.correct
        ? a.firstCorrect
          ? '正解'
          : '解き直して正解'
        : 'もう一度確かめる';
  function focus(id) {
    $(id)?.focus({ preventScroll: true });
  }
  function navigate(index) {
    progress[course].index = index;
    save();
    render();
    page.scrollIntoView({ block: 'start' });
    focus('quizTitle');
  }
  function revisit(index) {
    const c = course,
      q = QUIZZES[c][index];
    reviewing = { course: c, index };
    const opened = openExperiment(c, q.review.topic); // Does not reset parameters, run an experiment or grant a correct answer.
    if (opened === false) {
      reviewing = null;
      openQuiz(c);
      $('quizContent').insertAdjacentHTML(
        'afterbegin',
        '<p role="alert">学習の処理が終わってから、もう一度「実験へ」を押してください。</p>',
      );
      return;
    }
    showReview(c);
    review.scrollIntoView({ block: 'start' });
    focus('quizReviewTitle');
  }
  function showReview(active) {
    review.hidden = !reviewing || reviewing.course !== active;
    if (review.hidden) return;
    const { course: c, index } = reviewing,
      q = QUIZZES[c][index];
    review.innerHTML = `<div class="quiz-review-copy"><p class="eyebrow">小テスト ${index + 1} / ${QUIZZES[c].length} · 実験で確かめる</p><h2 id="quizReviewTitle" tabindex="-1">${escape(q.concept)}</h2><p>${escape(q.review.action)}</p></div><div class="quiz-review-actions"><button class="primary" id="quizReturn">問題に戻って解き直す</button><button class="quiet" id="quizReviewEnd">復習の案内を閉じる</button></div>`;
    $('quizReturn').onclick = () => {
      retryQuizAnswer(progress, c, index);
      progress[c].index = index;
      save();
      reviewing = null;
      openQuiz(c);
    };
    $('quizReviewEnd').onclick = () => {
      reviewing = null;
      review.hidden = true;
    };
  }
  function footer(active) {
    entry.hidden = !QUIZZES[active];
    showReview(active);
    if (entry.hidden) return;
    const s = quizSummary(progress, active),
      title = LESSONS.find((l) => l.id === active).title;
    entry.innerHTML = `<div><p class="eyebrow">この教材のまとめ</p><h2>${lessonIcon('reflect')}実験で分かったことを、確かめる</h2><p>「${escape(title)}」の理解を確かめます。迷った内容は、対応する実験に戻って試せます。</p></div><div class="assessment-options"><section><h3>小テスト <span>6問 · 基本を確認</span></h3><p>一問ずつ答えと解説を確かめ、基本の考え方を復習します。</p>${s.checked ? `<span class="quiz-entry-progress">${s.checked} / ${s.total} 問を回答済み</span>` : ''}<button id="quizStart">${s.checked === s.total ? '結果と復習を見る' : s.checked ? '小テストを続ける' : '小テストを始める'} →</button></section><section><h3>実力テスト <span>3問 · 別の条件で考える</span></h3><p>新しい場面のデータを読み、答えと根拠を示します。最後は改善案も説明し、提出後に振り返ります。</p><button id="masteryStart" class="primary">${masteryStatus(active)} →</button></section></div>`;
    $('quizStart').onclick = () => {
      if (s.checked === s.total) progress[active].index = s.total;
      openQuiz(active);
    };
    $('masteryStart').onclick = () => openMastery(active);
  }
  function render() {
    const lesson = LESSONS.find((l) => l.id === course),
      questions = QUIZZES[course],
      index = progress[course].index;
    page.innerHTML = `<div class="quiz-heading"><button id="quizBack" class="text-button">← 教材に戻る</button><p class="eyebrow">${escape(lesson.title)} · 理解を確かめる</p><h1 id="quizTitle" tabindex="-1">${index === questions.length ? '小テストの振り返り' : '実験の結果から考えてみよう'}</h1><p>${index === questions.length ? 'もう一度確かめたい内容を選ぶと、その実験へ戻れます。結果を見てから解き直し、理由も説明できるか確かめてください。' : '場面を読んで、最も適切な答えを一つ選んでください。迷ったら「まだ分からない」から解説と実験を確認できます。制限時間はありません。'}</p></div><nav class="quiz-progress" aria-label="小テストの問題">${questions.map((q, i) => `<button data-quiz-index="${i}" aria-current="${i === index ? 'step' : 'false'}" aria-label="問${i + 1} ${escape(q.concept)}：${status(quizAnswer(progress, course, i))}" class="${quizAnswer(progress, course, i)?.checked ? (quizAnswer(progress, course, i).correct ? 'is-correct' : 'needs-review') : ''}"><span>${i + 1}</span><span>${escape(q.concept)}</span>${quizAnswer(progress, course, i)?.checked ? `<b aria-hidden="true">${quizAnswer(progress, course, i).correct ? '✓' : '↺'}</b>` : ''}</button>`).join('')}<button data-quiz-index="${questions.length}" aria-current="${index === questions.length ? 'step' : 'false'}">振り返り</button></nav><div id="quizContent"></div><p class="quiz-storage">${storageAvailable ? '回答はこのブラウザに保存します。別の端末やファイルへの引き継ぎ、教員への送信は行いません。' : 'この環境では回答を保存できません。ページを開いている間は、実験と問題を行き来できます。'}</p>`;
    $('quizBack').onclick = () => backToCourse(course);
    page
      .querySelectorAll('[data-quiz-index]')
      .forEach((b) => (b.onclick = () => navigate(Number(b.dataset.quizIndex))));
    if (index === questions.length) renderSummary();
    else renderQuestion(index);
  }
  function renderQuestion(index) {
    const q = QUIZZES[course][index],
      a = quizAnswer(progress, course, index),
      checked = !!a?.checked;
    $('quizContent').innerHTML =
      `<section class="card quiz-question"><div class="quiz-scenario"><p class="eyebrow">問 ${index + 1} / ${QUIZZES[course].length} · ${escape(q.concept)}</p><h2>こんな結果が出たら</h2><p>${escape(q.scene)}</p>${q.evidence ? `<table class="quiz-evidence"><caption>この問題で使う測定例</caption><thead><tr>${q.evidence.headers.map((x) => `<th scope="col">${escape(x)}</th>`).join('')}</tr></thead><tbody>${q.evidence.rows.map((row) => `<tr>${row.map((x) => `<td>${escape(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : ''}<small>教材の仕組みを考えるための例です。あなたの実験結果とは別です。</small></div><form id="quizForm" class="quiz-answer"><fieldset ${checked ? 'disabled' : ''}><legend>${escape(q.prompt)}</legend><div class="quiz-choices">${q.choices.map((text, i) => `<label class="quiz-choice ${checked && a.choice === i ? 'is-selected' : ''}"><input type="radio" name="quizChoice" value="${i}" ${checked && a.choice === i ? 'checked' : ''}><span><b aria-hidden="true">${'ABC'[i]}</b>${escape(text)}</span></label>`).join('')}</div></fieldset>${checked ? '' : `<p id="quizValidation" class="quiz-validation" role="alert"></p><div class="quiz-actions"><button class="primary" type="submit">答えを確かめる</button><button type="button" id="quizUnsure" class="quiet">まだ分からない</button></div>`}</form><div id="quizFeedback" class="quiz-feedback" ${checked ? '' : 'hidden'} aria-live="polite" tabindex="-1"></div></section><div class="quiz-bottom"><button id="quizPrevious" ${index === 0 ? 'disabled' : ''}>← 前の問題</button><span>解説を読んでから、自分のペースで進めます</span></div>`;
    $('quizPrevious').onclick = () => navigate(index - 1);
    $('quizForm').onsubmit = (event) => {
      event.preventDefault();
      if (checked) return;
      const selected = page.querySelector('input[name="quizChoice"]:checked');
      if (!selected) {
        $('quizValidation').textContent = '答えを一つ選ぶか、「まだ分からない」を押してください。';
        return;
      }
      answer(index, Number(selected.value));
    };
    if (!checked) $('quizUnsure').onclick = () => answer(index, null);
    else renderFeedback(index);
  }
  function answer(index, choice) {
    checkQuizAnswer(progress, course, index, choice);
    save();
    render();
    $('quizFeedback').scrollIntoView({ block: 'nearest' });
    focus('quizFeedback');
  }
  function renderFeedback(index) {
    const q = QUIZZES[course][index],
      a = quizAnswer(progress, course, index),
      box = $('quizFeedback');
    box.classList.toggle('quiz-feedback-correct', a.correct);
    box.innerHTML = `<h3>${a.correct ? (a.firstCorrect ? '✓ 正解です' : '✓ 解き直して確かめられました') : a.choice === null ? '実験に戻って、手がかりを探そう' : 'もう一度、結果と理由をつなげてみよう'}</h3><p>${escape(a.choice === null ? 'まず次のポイントを観察してください。問題はそのまま残るので、実験後に戻って選び直せます。' : q.feedback[a.choice])}</p>${a.correct ? '' : `<div class="quiz-observe"><strong>${lessonIcon('observe')}実験で見るポイント</strong><p>${escape(q.review.action)}</p></div>`}<div class="quiz-actions"><button id="quizRevisit" class="${a.correct ? '' : 'primary'}">実験へ：${escape(q.review.title)} ↗</button>${a.correct ? '' : '<button id="quizRetry">この問題を解き直す</button>'}<button id="quizNext" class="${a.correct ? 'primary' : 'quiet'}">${index === QUIZZES[course].length - 1 ? '回答を振り返る' : '次の問題へ →'}</button></div>`;
    $('quizRevisit').onclick = () => revisit(index);
    if (!a.correct)
      $('quizRetry').onclick = () => {
        retryQuizAnswer(progress, course, index);
        save();
        render();
        focus('quizTitle');
      };
    $('quizNext').onclick = () => navigate(index + 1);
  }
  function renderSummary() {
    const s = quizSummary(progress, course),
      questions = QUIZZES[course];
    $('quizContent').innerHTML =
      `<section class="card quiz-summary"><h2>${s.remaining.length ? '次に確かめることが見つかりました' : '6問すべてで、考え方を確かめました'}</h2><div class="quiz-score"><div><strong>${s.first}<small> / ${s.total}</small></strong><span>最初の回答で正解</span></div><div><strong>${s.recovered}</strong><span>解き直して正解</span></div><div><strong>${s.remaining.length}</strong><span>これから確かめる</span></div></div><p>${s.remaining.length ? '点数だけで終わらせず、気になった項目を一つ選びましょう。「実験で確かめる」で操作する画面と観察の案内が開きます。' : '正解の選択肢を覚えるだけでなく、実験のどの結果が理由になるかを、自分の言葉でも説明してみましょう。気になる実験は下から再確認できます。'}</p><div class="quiz-result-list">${questions.map((q, i) => `<article><div><p class="quiz-result-status">${i + 1} · ${status(quizAnswer(progress, course, i))}</p><h3>${escape(q.concept)}</h3></div><div class="quiz-actions"><button data-quiz-review="${i}">実験で確かめる</button><button data-quiz-question="${i}" class="quiet">${quizAnswer(progress, course, i)?.correct ? '回答を見る' : '問題を解く'}</button></div></article>`).join('')}</div><div class="quiz-actions">${s.remaining.length ? '<button id="quizRemaining" class="primary">まだ確かめていない問題を解く →</button>' : ''}<button id="quizFinish">教材に戻る</button></div></section>`;
    page
      .querySelectorAll('[data-quiz-review]')
      .forEach((b) => (b.onclick = () => revisit(Number(b.dataset.quizReview))));
    page.querySelectorAll('[data-quiz-question]').forEach(
      (b) =>
        (b.onclick = () => {
          const i = Number(b.dataset.quizQuestion);
          if (!quizAnswer(progress, course, i)?.correct) retryQuizAnswer(progress, course, i);
          navigate(i);
        }),
    );
    if (s.remaining.length)
      $('quizRemaining').onclick = () => {
        const i = s.remaining[0];
        retryQuizAnswer(progress, course, i);
        navigate(i);
      };
    $('quizFinish').onclick = () => backToCourse(course);
    $('quizFinish').insertAdjacentHTML(
      'afterend',
      '<button id="quizNewAttempt" class="quiet">全問を新しく解く</button><div id="quizResetPanel" class="quiz-reset-panel" hidden><p>この教材の小テストの回答を消して、1問目から始めます。実験の設定や記録は残ります。</p><button id="quizResetConfirm">回答を消して始める</button> <button id="quizResetCancel" class="quiet">キャンセル</button></div>',
    );
    $('quizNewAttempt').onclick = () => {
      $('quizResetPanel').hidden = false;
      focus('quizResetCancel');
    };
    $('quizResetCancel').onclick = () => {
      $('quizResetPanel').hidden = true;
      focus('quizNewAttempt');
    };
    $('quizResetConfirm').onclick = () => {
      progress[course] = { index: 0, answers: {} };
      if (reviewing?.course === course) reviewing = null;
      save();
      navigate(0);
    };
  }
  return {
    show(id) {
      course = id;
      entry.hidden = true;
      review.hidden = true;
      render();
      focus('quizTitle');
    },
    showCourse: footer,
    hide() {
      entry.hidden = true;
      review.hidden = true;
      reviewing = null;
    },
  };
}

export { initQuizzes };
