import { loadJson } from '../core/content.js';
import { SYSTEM_TOPICS } from '../systems/data.js';

// Connections to school subjects, not prerequisites or additional simulator inputs.
// All worked numbers below are illustrative examples, never live measurements.
// Tip format: [subjects, title, connection, formula, example, what to observe].
// High-school grades are one possible course sequence, not a nationally fixed allocation.
const { SCHOOL_TIPS, SCHOOL_GRADES } = await loadJson('content/school-tips.json');

for (const [course, topics] of Object.entries(SYSTEM_TOPICS))
  for (const topic of topics) SCHOOL_TIPS[course + '-' + topic.id] = topic.tip;
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
function schoolTips(key) {
  const tip = SCHOOL_TIPS[key];
  if (!tip) return '';
  const [subjects, title, connection, formula, example, observe] = tip;
  return `<details data-help-dialog class="school-tip" data-school-tip="${escape(key)}"><summary><span class="school-tip-label">Tips · 学校の数学・物理</span> <span class="school-tip-topic">${escape(title)}</span></summary><div class="school-tip-body"><p class="school-tip-subjects">${escape(subjects)}</p><div class="school-tip-grid"><div><h3>この実験とのつながり</h3><p>${escape(connection)}</p><div class="school-tip-example"><h4>式と計算例</h4><p class="school-tip-formula">${escape(formula)}</p><p>${escape(example)}</p></div></div><div class="school-tip-observe"><h3>この画面で確かめる</h3><p>${escape(observe)}</p><p class="school-tip-note">数値は考え方を説明する例です。いまの実験の測定値とは別です。未習の内容は、まず図やグラフで確かめてください。</p></div></div></div></details>`;
}
function schoolOverview(lessons) {
  const names = Object.fromEntries(lessons.map((l) => [l.id, l.title]));
  return `<details data-help-dialog class="school-tip school-tip-overview" data-school-tip="series"><summary><span class="school-tip-label">Tips · 学校の授業とロボット</span> <span class="school-tip-topic">授業で学ぶ考え方は、どこで使われる？</span></summary><div class="school-tip-body school-overview">
 <p>学年を選ぶと、授業で習う項目とロボットでの使い道を見比べられます。気になる項目の実験を開き、実際に動かして確かめてください。</p>
 <p class="school-grade-note">高校の学年は、履修の一例です。学ぶ時期や選ぶ科目は学校・コースによって異なるため、科目名も併記しています。</p>
 <div class="school-grade-tabs" role="tablist" aria-label="学校で学ぶ学年">${SCHOOL_GRADES.map((g, i) => `<button type="button" role="tab" id="school-tab-${g.id}" data-school-grade="${g.id}" aria-controls="school-panel-${g.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" aria-label="${escape(g.title)}">${g.label}${g.id.startsWith('h') ? '<small>目安</small>' : ''}</button>`).join('')}</div>
 ${SCHOOL_GRADES.map((g, i) => `<section class="school-grade-panel" id="school-panel-${g.id}" data-school-panel="${g.id}" role="tabpanel" tabindex="0" aria-labelledby="school-tab-${g.id}"${i === 0 ? '' : ' hidden'}><h2>${escape(g.title)}</h2><p>${escape(g.note)}</p><div class="school-column-head" aria-hidden="true"><span>授業で習う項目</span><span>ロボットでの使い道・確かめる実験</span></div><dl class="school-subjects">${g.items.map((item) => `<div><dt><span class="school-subject-name">${escape(item.subject)}</span>${escape(item.title)}</dt><dd><p>${escape(item.use)}</p><div class="school-experiment-links">${item.experiments.map((e) => `<a href="#${escape(e.course)}" data-school-course="${escape(e.course)}" data-school-experiment="${escape(e.topic)}" aria-label="実験を開く：${escape(e.label)}。教材：${escape(names[e.course] || e.course)}">${escape(e.label)}<span aria-hidden="true"> →</span></a>`).join('')}</div></dd></div>`).join('')}</dl></section>`).join('')}
 <p class="school-tip-note school-curriculum-source">項目・科目の整理は、文部科学省の学習指導要領解説（<a href="https://www.mext.go.jp/a_menu/shotou/new-cs/1387016.htm" target="_blank" rel="noopener noreferrer">中学校</a>・<a href="https://www.mext.go.jp/a_menu/shotou/new-cs/1407074.htm" target="_blank" rel="noopener noreferrer">高等学校</a>）を参照しています。高校の学年への配置と、ロボットでの応用例は本教材の整理です。各実験のTipsでは、式や計算例も確認できます。</p>
 </div></details>`;
}

function initSchoolOverview(root, openExperiment) {
  const tabs = [...root.querySelectorAll('[data-school-grade]')];
  const panels = [...root.querySelectorAll('[data-school-panel]')];
  const select = (tab) => {
    for (const t of tabs) {
      const active = t === tab;
      t.setAttribute('aria-selected', String(active));
      t.tabIndex = active ? 0 : -1;
    }
    for (const panel of panels)
      panel.hidden = panel.dataset.schoolPanel !== tab.dataset.schoolGrade;
  };
  // Direct listeners stay attached when the shared help dialog moves these nodes.
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      const next =
        event.key === 'ArrowRight'
          ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft'
            ? (index + tabs.length - 1) % tabs.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : null;
      if (next === null) return;
      event.preventDefault();
      select(tabs[next]);
      tabs[next].focus();
    });
  }
  for (const link of root.querySelectorAll('[data-school-experiment]'))
    link.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0)
        return;
      event.preventDefault();
      openExperiment(link.dataset.schoolCourse, link.dataset.schoolExperiment);
    });
}

export { SCHOOL_TIPS, schoolTips, SCHOOL_GRADES, schoolOverview, initSchoolOverview };
