import { html, unsafeHTML } from '../vendor/lit-html.js';
import { lessonBrief } from '../shell/lesson-brief.js';
import { LESSON_GUIDES } from '../shell/lesson-guide.js';
import { formatNumber } from '../core/dom.js';

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]);

export function usbView(model, copy, actions) {
  const snapshot = model.snapshot;
  const labels = copy.labels;
  return html`${unsafeHTML(
      lessonBrief('slam-usb', LESSON_GUIDES['slam-usb'], {
        start: { label: labels.start, target: '#usbConnect', press: false },
      }),
    )}
    <div class="usb-controls">
      <p>${copy.intro}</p>
      <button
        id="usbConnect"
        class="primary"
        ?disabled=${!model.supported || model.connection !== 'idle'}
        @click=${actions.connect}
      >
        ${labels.connect}
      </button>
      <button
        id="usbDisconnect"
        ?disabled=${model.connection === 'idle' || model.connection === 'closing'}
        @click=${actions.disconnect}
      >
        ${labels.disconnect}
      </button>
      <button
        id="usbMapStart"
        ?disabled=${model.connection !== 'ready' || !model.points.length}
        @click=${actions.start}
      >
        ${labels.mapStart}
      </button>
      <button id="usbMapStop" ?disabled=${!model.mapping} @click=${actions.pause}>
        ${labels.mapStop}
      </button>
      <p role="status">${copy[model.status]}</p>
      ${!model.supported ? html`<p>${model.secure ? copy.unsupported : copy.secure}</p>` : ''}
      <p>
        ${fill(labels.stats, {
          points: model.points.length,
          accepted: snapshot?.accepted ?? 0,
          rejected: snapshot?.rejected ?? 0,
        })}
      </p>
    </div>
    <div class="usb-figures">
      <figure>
        <h2>${labels.mapTitle}</h2>
        <label
          >${labels.span}
          <select .value=${String(model.spanMetres)} @change=${actions.setSpan}>
            <option value="8">8 m</option>
            <option value="16">16 m</option>
            <option value="32">32 m</option>
          </select></label
        >
        <canvas id="usbMapCanvas" width="640" height="640" aria-label=${labels.mapAria}></canvas>
        <figcaption>${copy.legend}<br />${copy.mapLegend}</figcaption>
      </figure>
      <figure>
        <h2>${labels.scanTitle}</h2>
        <canvas id="usbScanCanvas" width="640" height="640" aria-label=${labels.scanAria}></canvas>
        <figcaption>${copy.scanLegend}</figcaption>
      </figure>
    </div>
    <p>
      ${fill(labels.pose, {
        x: formatNumber(snapshot?.pose.x ?? 0, 2),
        y: formatNumber(snapshot?.pose.y ?? 0, 2),
      })}
    </p>
    <button ?disabled=${!snapshot?.accepted} @click=${actions.savePng}>${labels.savePng}</button>
    <button ?disabled=${!snapshot?.accepted} @click=${actions.saveJson}>${labels.saveJson}</button>
    <p>${copy.limits}</p>`;
}
