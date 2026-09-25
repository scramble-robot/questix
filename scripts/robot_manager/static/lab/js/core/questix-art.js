import { svg } from '../vendor/lit-html.js';
import {
  QUESTIX_VIEWS as VIEWS,
  FRONT_CUE_OUTER,
  FRONT_CUE_INNER,
  questixImageUrl,
  questixSideLayout,
} from './questix-views.js';

// SVG versions of the QUESTiX views (lit templates). Canvas drawing, placement and the image URLs
// live in questix-views.js, which string and canvas code import directly: this module loads
// lit-html, which needs a document.

/** SVG top view (lit template) centred on (x, y), turned by `heading` degrees, `size` across. */
function questixTopSvg(x, y, heading = 0, size = 60, opacity = 1) {
  const [left, top, right, bottom] = VIEWS.top.bounds;
  const [width, height] = VIEWS.top.size;
  const box = [left * width, top * height, (right - left) * width, (bottom - top) * height].join(
    ' ',
  );
  const cue = `M${size * 0.48} ${-size * 0.12}V${size * 0.12}`;
  return svg`<g data-questix-view="top" transform=${`translate(${x} ${y}) rotate(${heading})`} opacity=${opacity}>
    <svg x=${-size / 2} y=${-size / 2} width=${size} height=${size} viewBox=${box} preserveAspectRatio="none">
      <image href=${questixImageUrl('top')} width=${width} height=${height} />
    </svg>
    <path d=${cue} stroke=${FRONT_CUE_OUTER} stroke-width=${Math.max(3, size * 0.08)} stroke-linecap="round" />
    <path d=${cue} stroke=${FRONT_CUE_INNER} stroke-width=${Math.max(2, size * 0.05)} stroke-linecap="round" />
  </g>`;
}

/** SVG side view (lit template); see questixSideLayout for the placement. */
function questixSideSvg(x, bottom, width, view = 'side', opacity = 1) {
  const place = questixSideLayout(x, bottom, width, view);
  return svg`<image data-questix-view=${view} href=${questixImageUrl(view)} x=${place.x} y=${place.y}
    width=${place.width} height=${place.height} opacity=${opacity} />`;
}

export * from './questix-views.js';
export { questixTopSvg, questixSideSvg };
