/**
 * The Trainer tab's live chart trace buffer.
 *
 * `handleBikeData` in components/trainer-panel.tsx pushes one point per bike-
 * data notification and trims the front once the buffer grows past
 * CHART_MAX_POINTS, so the chart shows a rolling ~10 minutes at 1 Hz rather
 * than growing without bound across a long session. Pulled out so the trim
 * boundary (the 601st point drops the 1st, not the other way round) is
 * covered by a test instead of only by eyeballing a `splice` call.
 */

/** ~10 min of trace at 1 Hz; older points fall off the front. */
export const CHART_MAX_POINTS = 600

export interface TrainerChartPoint {
  t: number // seconds since chart start
  power: number | null
  target: number | null
  cadence: number | null
}

/** Pushes `point` onto `buffer` in place, then trims the front to `maxPoints`. */
export function appendChartPoint(
  buffer: TrainerChartPoint[],
  point: TrainerChartPoint,
  maxPoints: number = CHART_MAX_POINTS,
): void {
  buffer.push(point)
  if (buffer.length > maxPoints) buffer.splice(0, buffer.length - maxPoints)
}
