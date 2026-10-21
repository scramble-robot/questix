const test = require('node:test');
const assert = require('node:assert/strict');
const chart = require('../static/tuning-chart.js');
const model = require('../static/tuning-model.js');
const geometry = { wheel_radius: 0.05, wheel_separation: 0.5 };
const state = (speed, accel, kind = 'angular') => model.motion({
  joy_controller: { angular_input_ratio: speed, longitudinal_input_ratio: speed },
  drive_component: { max_motor_rpm: 475, max_angular_accel: accel, max_linear_accel: accel },
}, geometry, kind);

test('up, one-second hold and down agree with time and stopping-area formula', () => {
  for (const motion of [state(3, 1.5), state(4.5, 2.25), state(10, 1.5, 'linear')]) {
    const curve = chart.curve(motion);
    const [[start, zero], [peak, speed], [release, held], [stop, stopped]] = curve.points;
    assert.equal(start, 0); assert.equal(zero, 0);
    assert.equal(peak, motion.time);
    assert.equal(speed, motion.speed);
    assert.equal(held, speed);
    assert.ok(Math.abs(release - peak - 1) < 1e-12);
    assert.ok(Math.abs(stop - release - motion.time) < 1e-12);
    assert.equal(stopped, 0);
    assert.ok(Math.abs((stop - release) * speed / 2 - motion.stop) < 1e-12);
    assert.equal(curve.shade[0][0], curve.release);
  }
});

test('shared axes include both curves and never rely on the saved third curve', () => {
  const spec = chart.plotSpec(state(4.5, 2.25), state(3, 1.5));
  assert.equal(spec.editing.points[1][1], 4.5);
  assert.equal(spec.standard.points[1][1], 3);
  for (const curve of [spec.editing, spec.standard]) {
    for (const [time, speed] of curve.points) {
      assert.ok(time <= spec.maxTime && speed <= spec.maxSpeed);
    }
  }
  assert.equal(Object.keys(spec).length, 4);
  assert.equal(chart.curve(state(3, 0)), null);
  assert.equal(chart.curve(null), null);
  assert.equal(chart.curve({ time: Infinity, speed: 1, stop: Infinity }), null);
  assert.equal(chart.curve({ time: 1e308, speed: 1, stop: 1e308 }), null);
  assert.deepEqual(chart.curve(state(0, 1)).points, [[0, 0], [1, 0]]);
});

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.style = {}; }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  replaceChildren(...children) { this.children = children; }
  all() { return this.children.flatMap((child) => [child, ...child.all()]); }
}

test('SVG has only geometry, with units, named line styles and equivalent text outside it', () => {
  const host = new Element('div');
  host.ownerDocument = { createElement: (tag) => new Element(tag),
    createElementNS: (ns, tag) => new Element(tag) };
  chart.render(host, state(4.5, 2.25), state(3, 1.5), 'angular');
  const figure = host.children[0];
  assert.match(figure.attributes['aria-label'], /約 258°/);
  const svg = figure.all().find((el) => el.tag === 'svg');
  assert.ok(svg.all().every((el) => !el.textContent && el.tag !== 'text'));
  const lines = svg.all().filter((el) => el.tag === 'polyline');
  assert.deepEqual(lines.map((el) => el.attributes['stroke-dasharray']), ['', '8 5']);
  assert.equal(svg.all().filter((el) => el.tag === 'polygon').length, 1);
  const text = figure.all().map((el) => el.textContent || '').join(' ');
  assert.match(text, /実線：編集中/);
  assert.match(text, /破線：配布元100%/);
  assert.match(text, /rad\/s.*時間（s）/);
  const oldPoints = lines[0].attributes.points;
  chart.render(host, state(1.5, 0.75), state(3, 1.5), 'angular');
  assert.equal(host.children.length, 1);
  assert.notEqual(host.all().find((el) => el.attributes['data-series'] === 'editing').attributes.points, oldPoints);
});
