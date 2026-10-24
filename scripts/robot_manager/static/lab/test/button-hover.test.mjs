import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = (file) => readFileSync(new URL(`../css/${file}.css`, import.meta.url), 'utf8');
const tokens = Object.fromEntries(
  [...css('tokens').matchAll(/(--[\w-]+):\s*(#[\da-f]+)/g)].map((m) => [m[1], m[2]]),
);
function rule(file, selector) {
  const match = [
    ...css(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ].find((m) =>
    selector instanceof RegExp
      ? selector.test(m[1].trim())
      : m[1].split(',').some((part) => part.trim() === selector),
  );
  assert.ok(match, `${file}: ${selector}`);
  return Object.fromEntries(
    [...match[2].matchAll(/([\w-]+):\s*([^;]+);/g)].map((m) => [
      m[1],
      m[2].trim().replace(/var\((--[\w-]+)\)/g, (_, name) => tokens[name]),
    ]),
  );
}
function rgb(color) {
  if (color === 'white') return [255, 255, 255];
  assert.match(color, /^#[\da-f]{6}$/i);
  return [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
}
function luminance(color) {
  return rgb(color).reduce((sum, channel, i) => {
    const c = channel / 255;
    return (
      sum + (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]
    );
  }, 0);
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('neutral hover keeps inherited grey text and secondary captions readable', () => {
  const neutral = rule('base', /^button:hover/);
  const caption = rule('school-supplement', '.supplement-trigger-action');
  for (const foreground of [neutral.color, neutral['--muted'], caption.color]) {
    assert.ok(contrast(foreground, neutral.background) >= 4.5);
  }
});

test('inverting actions never fade the background separately from the text', () => {
  for (const selector of [
    'button.primary',
    'button.drive-start',
    'button.shoot-fire',
    'button.drive-bench-move',
  ]) {
    assert.equal(rule('base', selector).transition, 'transform 0.15s');
  }
});

test('the neutral hover rule excludes filled actions and selected controls', () => {
  const generic = css('base').slice(
    css('base').indexOf('button:hover'),
    css('base').indexOf('button.primary:hover'),
  );
  for (const selector of [
    '.primary',
    '.drive-start',
    '.drive-stop',
    '.lab-stop',
    '.shoot-fire',
    '.sys-stop-link',
    '.drive-bench-move.held',
    '.emergency',
    '.pressed',
    "[aria-pressed='true']",
    "[aria-selected='true']",
    '[aria-current]',
  ]) {
    assert.ok(generic.includes(selector), `neutral hover must exclude ${selector}`);
  }
  assert.match(generic, /:not\(\s*:where\(/);
  assert.match(generic, /:not\(:disabled\)/);
});

for (const [file, normalSelector, hoverSelector] of [
  ['base', 'button.primary', 'button.primary:hover:not(:disabled)'],
  ['live', '.drive-start:not(:disabled)', '.drive-start:hover:not(:disabled)'],
  ['live', '.drive-bench-move.held', '.drive-bench-move.held:hover:not(:disabled)'],
  ['shoot', '.shoot-fire:not(:disabled)', '.shoot-fire:hover:not(:disabled)'],
]) {
  test(`${hoverSelector} inverts both colours and keeps readable text`, () => {
    const normal = rule(file, normalSelector);
    const hover = rule(file, hoverSelector);
    assert.equal(hover.color, normal.background);
    assert.equal(hover['border-color'], hover.color);
    assert.ok(luminance(hover.background) > luminance(normal.background));
    assert.ok(contrast(hover.color, hover.background) >= 4.5);
  });
}

for (const [file, normalSelector, hoverSelector] of [
  ['live', '.drive-stop', '.drive-stop:hover:not(:disabled)'],
  ['live', '.drive-stop', '.lab-stop:hover:not(:disabled)'],
  ['rl-lab', '.emergency.latched', '.emergency.latched:hover:not(:disabled)'],
  ['rl-lab', '.emergency', '.emergency:hover:not(:disabled)'],
  ['mastery-systems', '.sys-stop-link', '.sys-stop-link:hover:not(:disabled)'],
]) {
  test(`${hoverSelector} stays red with white text and darkens`, () => {
    const normal = rule(file, normalSelector);
    const hover = rule(file, hoverSelector);
    assert.equal(hover.color, 'white');
    assert.equal(hover['border-color'], hover.background);
    const [red, green, blue] = rgb(hover.background);
    assert.ok(red > green * 1.5 && red > blue * 1.5);
    assert.ok(luminance(hover.background) < luminance(normal.background));
    assert.ok(contrast(hover.color, hover.background) >= 4.5);
  });
}
