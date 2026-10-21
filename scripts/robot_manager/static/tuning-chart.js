/* QUESTiX ideal ramp preview: independent of ROS and of the LAB's Lit-based renderer. */
const TuningChart = (() => {
  const model = typeof module !== "undefined" ? require("./tuning-model.js") : TuningModel;
  const HOLD_SECONDS = 1;
  const PLOT = 1000;

  function curve(state) {
    if (!state) return null;
    if (state.speed === 0) return { points: [[0, 0], [HOLD_SECONDS, 0]], shade: [], release: 0 };
    if (!(state.time > 0) || !Number.isFinite(2 * state.time + HOLD_SECONDS)
        || !Number.isFinite(state.stop)) return null;
    const release = state.time + HOLD_SECONDS;
    return { points: [[0, 0], [state.time, state.speed], [release, state.speed],
      [release + state.time, 0]], shade: [[release, 0], [release, state.speed], [release + state.time, 0]],
    release };
  }

  function extent(value) {
    if (!(value > 0)) return 1;
    const step = 10 ** Math.floor(Math.log10(value));
    return Math.ceil(value / step) * step;
  }

  function plotSpec(current, baseline) {
    const editing = curve(current);
    const standard = curve(baseline);
    const points = [...(editing?.points || []), ...(standard?.points || [])];
    return { editing, standard,
      maxTime: extent(Math.max(0, ...points.map(([t]) => t))),
      maxSpeed: extent(Math.max(0, ...points.map(([, v]) => v))) };
  }

  function render(host, current, baseline, kind) {
    const doc = host.ownerDocument || document;
    const spec = plotSpec(current, baseline);
    const element = (tag, className, text) => {
      const node = doc.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const svgElement = (tag, attributes) => {
      const node = doc.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
      return node;
    };
    const coordinates = (points) => points.map(([t, speed]) =>
      `${t / spec.maxTime * PLOT},${PLOT - speed / spec.maxSpeed * PLOT}`).join(" ");
    const figure = element("figure", "tuning-chart");
    figure.setAttribute("role", "img");
    figure.setAttribute("aria-label", `一定加速度で計算した速さの変化。${model.summary(current, kind)}`);
    const legend = element("div", "tuning-chart-legend");
    legend.append(element("span", "tuning-line-current", "実線：編集中（計算）"),
      element("span", "tuning-line-standard", "破線：配布元100%（計算）"));
    const yTitle = element("div", "tuning-chart-y-title", kind === "angular"
      ? "旋回の速さ（rad/s）" : "速さ（m/s）");
    const body = element("div", "tuning-chart-body");
    const yTicks = element("div", "tuning-chart-y-ticks");
    const plot = element("div", "tuning-chart-plot");
    const svg = svgElement("svg", { viewBox: `0 0 ${PLOT} ${PLOT}`,
      preserveAspectRatio: "none", "aria-hidden": "true" });
    for (let index = 0; index <= 4; index++) {
      const portion = index / 4;
      const yTick = element("span", "", String(model.number(spec.maxSpeed * (1 - portion))));
      yTick.style.top = `${portion * 100}%`;
      yTicks.appendChild(yTick);
      svg.append(svgElement("line", { x1: 0, x2: PLOT, y1: portion * PLOT, y2: portion * PLOT,
        stroke: "#dbe4e6", "vector-effect": "non-scaling-stroke" }));
    }
    if (spec.editing?.shade.length) svg.append(svgElement("polygon", {
      points: coordinates(spec.editing.shade), fill: "#167452", "fill-opacity": 0.16,
      "data-stopping-area": "editing" }));
    for (const [name, line, color, dash] of [["editing", spec.editing, "#167452", ""],
      ["standard", spec.standard, "#8a5b08", "8 5"]]) {
      if (!line) continue;
      svg.append(svgElement("polyline", { points: coordinates(line.points), fill: "none",
        stroke: color, "stroke-width": name === "editing" ? 3 : 2,
        "stroke-dasharray": dash, "vector-effect": "non-scaling-stroke", "data-series": name }));
    }
    plot.appendChild(svg);
    body.append(yTicks, plot);
    const xTicks = element("div", "tuning-chart-x-ticks");
    for (let index = 0; index <= 4; index++) {
      const tick = element("span", "", String(model.number(spec.maxTime * index / 4)));
      tick.style.left = `${index * 25}%`;
      tick.style.transform = `translateX(${index === 0 ? 0 : index === 4 ? -100 : -50}%)`;
      xTicks.appendChild(tick);
    }
    const xTitle = element("div", "tuning-chart-x-title", "時間（s）");
    const caption = element("figcaption", "tuning-chart-caption",
      "全倒し → 最高速度で1 s保つ → 戻す。塗りは戻した後の角度・距離を表します。同じ値では線が重なります。");
    const status = element("p", "tuning-chart-status",
      spec.editing ? (spec.standard ? "" : "配布元の時間を算出できないため、破線は表示していません。")
        : "編集中の時間を算出できないため、実線と塗りは表示していません。");
    figure.append(legend, yTitle, body, xTicks, xTitle, caption, status);
    host.replaceChildren(figure);
  }

  return { HOLD_SECONDS, curve, plotSpec, render };
})();

if (typeof module !== "undefined") module.exports = TuningChart;
