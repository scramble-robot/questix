import { html, svg, nothing } from '../vendor/lit-html.js';
import { roleStyle } from '../core/palette.js';
import { formatNumber } from '../core/dom.js';
import { PLOT_UNITS } from './curve-core.js';

// A learning curve as markup: the lines are SVG stretched to the plot, every word and number is
// HTML laid over it, so labels stay at least 12 px on a phone (CONTRIBUTING.md, "Figures and
// charts"). Pure: takes the layout from curve-core.js and short captions.

const END_LABEL_FLIP = 40; // percent: from here on the line label sits left of the line's end

function gridLines(layout) {
  return layout.yTicks.map(
    (tick) =>
      svg`<line
        x1="0"
        x2=${PLOT_UNITS}
        y1=${tick.position}
        y2=${tick.position}
        class=${tick.zero ? 'rl-curve-zero' : 'rl-curve-grid'}
        vector-effect="non-scaling-stroke"
      />`,
  );
}

function linePaths(layout) {
  return layout.lines.map((line) => {
    const style = roleStyle(line.role, 'chart');
    return svg`<path
      d=${line.path}
      fill="none"
      stroke=${style.color}
      stroke-width=${style.width}
      stroke-dasharray=${style.dash || 'none'}
      stroke-linejoin="round"
      vector-effect="non-scaling-stroke"
    />`;
  });
}

// Direct label at the end of each line: its name and latest value, never colour alone.
function endLabel(line, unit) {
  if (!line.end) return nothing;
  const flipped = line.end.x > END_LABEL_FLIP;
  const style = roleStyle(line.role, 'chart');
  return html`<span
    class=${flipped ? 'rl-curve-end is-flipped' : 'rl-curve-end'}
    data-role=${line.role}
    style="left:${line.end.x}%;top:${line.end.y}%;--line-color:${style.color}"
    ><i aria-hidden="true"></i>${line.label} ${formatNumber(line.end.value, 1)}${unit}</span
  >`;
}

/**
 * `captions`: {title, yTitle, xTitle, unit, empty, ariaLabel}. `layout` from curveLayout().
 */
function curveChart(layout, captions) {
  return html`<figure class="rl-curve" role="img" aria-label=${captions.ariaLabel}>
    ${captions.title ? html`<figcaption>${captions.title}</figcaption>` : nothing}
    <span class="rl-curve-ytitle">${captions.yTitle}</span>
    <div class="rl-curve-frame">
      <div class="rl-curve-yticks" aria-hidden="true">
        ${layout.yTicks.map(
          (tick) => html`<span style="top:${tick.position}%">${tick.label}</span>`,
        )}
      </div>
      <div class="rl-curve-plot">
        <svg
          viewBox="0 0 ${PLOT_UNITS} ${PLOT_UNITS}"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          ${gridLines(layout)}${linePaths(layout)}
        </svg>
        ${layout.lines.map((line) => endLabel(line, captions.unit))}
        ${layout.empty ? html`<p class="rl-curve-empty">${captions.empty}</p>` : nothing}
      </div>
      <div class="rl-curve-xticks" aria-hidden="true">
        ${layout.xTicks.map(
          (tick) => html`<span style="left:${tick.position}%">${tick.label}</span>`,
        )}
      </div>
    </div>
    <span class="rl-curve-xtitle">${captions.xTitle}</span>
  </figure>`;
}

export { curveChart };
