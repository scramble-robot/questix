import { fillSentence } from '../core/content.js';
import { formatNumber } from '../core/dom.js';

// Presentation only. benchSummary keeps the measured maximum, rounded to 0.1 rpm.
// Around the reported 1 rpm quantisation difference, allow a further 0.5 rpm for smoothing and
// rounding. Larger gaps are still shown explicitly; this never changes the table or its maths.
const SMALL_WHEEL_GAP_RPM = 1.5;

function benchSentence(bench, text) {
  if (!bench.summary) return text.summaryStill;
  const { fastest, meanGap, wheelGap } = bench.summary;
  const wheelGapSentence =
    wheelGap <= SMALL_WHEEL_GAP_RPM
      ? text.wheelGapSmall
      : fillSentence(text.wheelGapLarge, { wheelGap: formatNumber(wheelGap, 1) });
  return fillSentence(text.summary, {
    command: formatNumber(fastest.command, 1),
    left: formatNumber(fastest.left, 1),
    right: formatNumber(fastest.right, 1),
    gap: formatNumber(meanGap, 1),
    wheelGapSentence,
  });
}

export { SMALL_WHEEL_GAP_RPM, benchSentence };
