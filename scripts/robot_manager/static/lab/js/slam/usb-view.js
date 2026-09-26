import { html, unsafeHTML } from '../vendor/lit-html.js';
import { lessonBrief } from '../shell/lesson-brief.js';
import { formatNumber } from '../core/dom.js';

export function usbView(model, copy, actions) {
  const snapshot = model.snapshot;
  return html`${unsafeHTML(lessonBrief('slam-usb', copy.brief, { start: { label: 'USB接続へ', target: '#usbConnect', press: false } }))}
    <div class="usb-controls">
      <p>${copy.intro}</p>
      <button
        id="usbConnect"
        class="primary"
        ?disabled=${!model.supported || model.connection !== 'idle'}
        @click=${actions.connect}
      >
        USBに接続
      </button>
      <button
        id="usbDisconnect"
        ?disabled=${model.connection === 'idle' || model.connection === 'closing'}
        @click=${actions.disconnect}
      >
        停止して切断
      </button>
      <button
        id="usbMapStart"
        ?disabled=${model.connection !== 'ready' || !model.points.length}
        @click=${actions.start}
      >
        新しい地図を開始
      </button>
      <button id="usbMapStop" ?disabled=${!model.mapping} @click=${actions.pause}>
        地図作成を停止
      </button>
      <p role="status">${copy[model.status]}</p>
      ${!model.supported ? html`<p>${model.secure ? copy.unsupported : copy.secure}</p>` : ''}
      <p>
        測定点 ${model.points.length} ／ 地図採用 ${snapshot?.accepted ?? 0} ／ 照合不成立
        ${snapshot?.rejected ?? 0}
      </p>
    </div>
    <div class="usb-figures">
      <figure>
        <h2>作った地図</h2>
        <label
          >表示幅
          <select .value=${String(model.spanMetres)} @change=${actions.setSpan}>
            <option value="8">8 m</option>
            <option value="16">16 m</option>
            <option value="32">32 m</option>
          </select></label
        >
        <canvas
          id="usbMapCanvas"
          width="640"
          height="640"
          aria-label="周囲の地図と推定した軌跡"
        ></canvas>
        <figcaption>${copy.legend}<br />${copy.mapLegend}</figcaption>
      </figure>
      <figure>
        <h2>LiDARの距離</h2>
        <canvas
          id="usbScanCanvas"
          width="640"
          height="640"
          aria-label="LiDARが測った距離の点"
        ></canvas>
        <figcaption>${copy.scanLegend}</figcaption>
      </figure>
    </div>
    <p>
      推定位置 x ${formatNumber(snapshot?.pose.x ?? 0, 2)} m ／ y
      ${formatNumber(snapshot?.pose.y ?? 0, 2)} m
    </p>
    <button ?disabled=${!snapshot?.accepted} @click=${actions.savePng}>地図PNGを保存</button>
    <button ?disabled=${!snapshot?.accepted} @click=${actions.saveJson}>地図JSONを保存</button>
    <p>${copy.limits}</p>`;
}
