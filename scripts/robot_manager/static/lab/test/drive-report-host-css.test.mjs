import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const cssRoot = new URL('../css/', import.meta.url);
const rules = fs.readdirSync(cssRoot).flatMap((file) => {
  if (!file.endsWith('.css')) return [];
  const source = fs.readFileSync(new URL(file, cssRoot), 'utf8').replace(/\/\*[^]*?\*\//g, '');
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((match) =>
    match[1].split(',').map((selector) => ({ selector: selector.trim(), body: match[2], file })),
  );
});
const declaration = (selector, property) => {
  const found = rules.filter((rule) => rule.selector === selector);
  const values = found.flatMap((rule) =>
    [...rule.body.matchAll(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`, 'g'))].map((m) =>
      m[1].trim(),
    ),
  );
  return values.at(-1);
};
const specificity = (selector) => [
  (selector.match(/#[\w-]+/g) ?? []).length,
  (selector.match(/\.[\w-]+/g) ?? []).length,
  (selector.replace(/[.#][\w-]+/g, '').match(/\b[a-z][\w-]*\b/gi) ?? []).length,
];
const stronger = (a, b) => {
  const left = specificity(a);
  const right = specificity(b);
  const index = left.findIndex((n, i) => n !== right[i]);
  return index >= 0 && left[index] > right[index];
};
const hosts = [
  'measurement-lab',
  'supplement-body',
  'drive-block',
  'live-block',
  'control-live',
  'robot-dialog',
  'robot-drive',
  'robot-monitor',
  'records-report',
  'records-page-inner',
  'records-section',
];

// Only ancestor-only rules can reach a report: reference items, school tips and other
// independent cards nested inside a supplement are not report hosts.
const genericHostRule = (rule, tag) =>
  new RegExp(`(?:^|[\\s>+~])${tag}$`).test(rule.selector) &&
  hosts.some((host) => rule.selector.includes(`.${host}`)) &&
  [...rule.selector.matchAll(/\.([\w-]+)/g)].every((match) => hosts.includes(match[1]));

test('measurement-only SVG styling names the measurement plot', () => {
  const view = fs.readFileSync(
    new URL('../js/systems/measurement-view.js', import.meta.url),
    'utf8',
  );
  assert.match(view, /<svg\s+class="measurement-plot"/);
  assert(!rules.some((rule) => rule.selector === '.measurement-lab svg'));
  assert.equal(declaration('.measurement-lab .measurement-plot', 'width'), '100%');
  assert.equal(declaration('.measurement-lab .measurement-plot', 'height'), 'auto');
  assert.equal(declaration('.measurement-lab .measurement-plot', 'margin-top'), '16px');
});

test('the time lines own the plot area, including their zero margin', () => {
  const selector = '.drive-report .drive-plot-lines';
  for (const [property, value] of Object.entries({
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    margin: '0',
    padding: '0',
    overflow: 'visible',
  }))
    assert.equal(declaration(selector, property), value, property);
});

test('report SVG geometry outranks generic SVG rules from its possible hosts', () => {
  for (const rule of rules.filter((rule) => genericHostRule(rule, 'svg'))) {
    for (const own of ['.drive-report .drive-plot-lines', '.drive-report .drive-report-path svg']) {
      assert(stronger(own, rule.selector), `${rule.file}: ${rule.selector} can override ${own}`);
    }
  }
});

test('the path stays a natural square within its own size limit', () => {
  const selector = '.drive-report .drive-report-path svg';
  assert.equal(declaration(selector, 'width'), 'min(100%, 300px)');
  assert.equal(declaration(selector, 'height'), 'auto');
  assert.equal(declaration(selector, 'position'), 'static');
  assert.equal(declaration(selector, 'margin'), '0');
});

test('report paragraph typography is owned by the component, beyond generic host paragraphs', () => {
  const own = [
    'drive-report-status',
    'drive-report-meta',
    'drive-report-cut',
    'drive-report-ended',
    'drive-note',
    'drive-plot-axis',
    'drive-report-spin',
  ];
  for (const rule of rules.filter((rule) => genericHostRule(rule, 'p'))) {
    for (const name of own)
      assert(stronger(`.drive-report .${name}`, rule.selector), rule.selector);
  }
  assert.equal(declaration('.drive-report .drive-plot-axis', 'font-size'), '12px');
  assert.equal(declaration('.drive-report .drive-report-meta', 'font-size'), '13px');
  assert.equal(declaration('.drive-report .drive-report-status', 'line-height'), '1.3');
});

test('the ended sentence names its component typography', () => {
  const source = fs.readFileSync(
    new URL('../js/live/drive-report-view.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /run\.ended \? html`<p class="drive-report-ended">/);
  assert.equal(declaration('.drive-report .drive-report-ended', 'font-size'), '14px');
  assert.equal(declaration('.drive-report .drive-report-ended', 'line-height'), '1.85');
  assert.equal(declaration('.drive-report .drive-report-ended', 'margin'), '0');
});

test('the turn explanation keeps its inset and full/compact font sizes', () => {
  const selector = '.drive-report .drive-report-path > .drive-report-spin';
  assert.equal(declaration(selector, 'padding'), '12px');
  assert.equal(declaration(selector, 'font-size'), '12px');
  assert.equal(
    declaration('.drive-report .drive-report-more .drive-report-spin', 'font-size'),
    '13px',
  );
  assert(stronger(selector, '.drive-report .drive-report-path > p'));
});
