/**
 * The numbers behind a sensor chart: the per-channel statistics shown under the
 * legend, and the Y-axis domain the chart draws with.
 *
 * This lives outside the component for two reasons. It is the only part of the
 * chart that is worth unit-testing, and both features it serves - the readout
 * and the axis - are answers to the SAME question ("what is in the window on
 * screen?"), so they must come from ONE scan. The chart re-derives this on every
 * 100 ms data tick, and a second pass over the buffer for each of five charts is
 * not free.
 */

/** What one trace does over the scanned window. NaN where undefined - see below. */
export interface ChannelStats {
  key: string
  /** Usable (finite, numeric) samples found. Zero means nothing to report. */
  count: number
  /** NaN when count is 0. */
  mean: number
  /** SAMPLE variance (n-1). NaN when count is below 2. */
  variance: number
  /** sqrt(variance). NaN when count is below 2. */
  stdDev: number
  /** NaN when count is 0. */
  min: number
  /** NaN when count is 0. */
  max: number
}

/**
 * A chart's Y-axis setting as the UI holds it. Bounds stay STRINGS because they
 * are what the user is typing: a half-entered "-" or "1e" has to survive in the
 * input without the axis lurching, and only resolveManualDomain decides whether
 * the pair currently means anything.
 */
export interface AxisRange {
  /** false = derive the axis from the data (the default). */
  manual: boolean
  min: string
  max: string
}

/**
 * The default every chart starts on. Module-level so all five charts share one
 * identity and the memoized cards see a stable prop.
 */
export const AUTO_AXIS: AxisRange = { manual: false, min: "", max: "" }

const UNCOUNTED = (key: string): ChannelStats => ({
  key,
  count: 0,
  mean: Number.NaN,
  variance: Number.NaN,
  stdDev: Number.NaN,
  min: Number.NaN,
  max: Number.NaN,
})

/**
 * Per-key mean / variance / extent over the inclusive index window
 * [startIndex, endIndex], clamped to the data. Rows missing the key, and
 * non-numeric or non-finite values, are skipped rather than counted - chart rows
 * are merged from several packet types, so a key is legitimately absent on some.
 *
 * Variance is accumulated with Welford's algorithm rather than
 * E[x^2] - E[x]^2. That matters here and is not a stylistic preference: the
 * force channels sit near 1e6 counts while the noise being measured is of order
 * 1, and the naive form subtracts two nearly equal large numbers, which destroys
 * the answer (and can even hand back a negative variance).
 *
 * Returns one entry per requested key, in the requested order, so a caller can
 * zip it against its line list without a lookup.
 */
export function computeWindowStats(
  data: ReadonlyArray<Record<string, number | string>>,
  keys: readonly string[],
  startIndex: number,
  endIndex: number,
): ChannelStats[] {
  if (data.length === 0 || keys.length === 0) return keys.map(UNCOUNTED)

  const start = Math.max(0, startIndex)
  const end = Math.min(data.length - 1, endIndex)
  if (end < start) return keys.map(UNCOUNTED)

  // Parallel accumulators, indexed alongside `keys`. Flat arrays rather than a
  // map: this loop runs over the whole visible buffer on every chart tick.
  const count = new Array<number>(keys.length).fill(0)
  const mean = new Array<number>(keys.length).fill(0)
  const m2 = new Array<number>(keys.length).fill(0)
  const min = new Array<number>(keys.length).fill(Number.POSITIVE_INFINITY)
  const max = new Array<number>(keys.length).fill(Number.NEGATIVE_INFINITY)

  for (let i = start; i <= end; i++) {
    const point = data[i]
    if (!point) continue
    for (let k = 0; k < keys.length; k++) {
      const value = point[keys[k]]
      if (typeof value !== "number" || !Number.isFinite(value)) continue

      // Welford update: shift the mean by the residual, then fold the residual
      // measured against the OLD and the NEW mean into the sum of squares.
      const n = ++count[k]
      const deltaBefore = value - mean[k]
      mean[k] += deltaBefore / n
      m2[k] += deltaBefore * (value - mean[k])

      if (value < min[k]) min[k] = value
      if (value > max[k]) max[k] = value
    }
  }

  return keys.map((key, k) => {
    if (count[k] === 0) return UNCOUNTED(key)
    // n-1: these samples are a sample of a noisy signal, not the population.
    const variance = count[k] > 1 ? m2[k] / (count[k] - 1) : Number.NaN
    return {
      key,
      count: count[k],
      mean: mean[k],
      variance,
      stdDev: Math.sqrt(variance),
      min: min[k],
      max: max[k],
    }
  })
}

/**
 * The autoscale domain: the combined extent of every counted channel, padded so
 * the traces do not touch the frame. Channels with no samples drop out, and
 * when none is left the caller gets ["auto", "auto"] so recharts decides.
 */
export function autoDomainFromStats(stats: readonly ChannelStats[]): [number | "auto", number | "auto"] {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  for (const entry of stats) {
    if (entry.count === 0) continue
    if (entry.min < min) min = entry.min
    if (entry.max > max) max = entry.max
  }

  if (min === Number.POSITIVE_INFINITY) return ["auto", "auto"]

  // Flat signal: 5% of a zero span is zero, which would pin the line to both
  // edges at once. Fall back to 10% of the level, or one unit at exactly zero.
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1
    return [min - pad, max + pad]
  }

  const pad = (max - min) * 0.05
  return [min - pad, max + pad]
}

/** Number(), not parseFloat(): "12abc" is a typo, not the number 12. */
function parseBound(text: string): number {
  const trimmed = text.trim()
  // Number("") is 0, so a blank field would otherwise clamp an axis at zero.
  if (trimmed === "") return Number.NaN
  return Number(trimmed)
}

/**
 * The user's typed axis window, or null to fall back to autoscale. Null covers
 * every state in which the pair does not yet describe a drawable axis: the
 * switch is off, a field is blank or mistyped, or the bounds are inverted or
 * equal. A range that excludes the data entirely is accepted - clipping to a
 * window is the reason to turn autoscale off.
 */
export function resolveManualDomain(range: AxisRange): [number, number] | null {
  if (!range.manual) return null

  const min = parseBound(range.min)
  const max = parseBound(range.max)
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null
  if (min >= max) return null

  return [min, max]
}

/**
 * One formatter for figures spanning force counts near 1e6 down to gyro
 * variances near 1e-6, so a column of them stays readable. Anything not finite
 * - an uncounted channel, or a variance with fewer than two samples - reads as
 * a dash rather than as "NaN".
 */
export function formatStat(value: number): string {
  if (!Number.isFinite(value)) return "-"
  if (value === 0) return "0"

  const magnitude = Math.abs(value)
  // Outside this band fixed notation either runs to an unreadable digit count
  // or rounds a real reading down to 0.00000.
  if (magnitude >= 1e6 || magnitude < 1e-3) return value.toExponential(2)
  if (magnitude >= 1000) return value.toFixed(1)
  if (magnitude >= 1) return value.toFixed(3)
  return value.toFixed(5)
}
