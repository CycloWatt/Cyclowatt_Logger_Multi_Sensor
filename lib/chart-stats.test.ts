import { describe, expect, it } from "vitest"
import {
  AUTO_AXIS,
  autoDomainFromStats,
  computeWindowStats,
  formatStat,
  resolveManualDomain,
  type ChannelStats,
} from "./chart-stats"

/** Build a chart-data array from one value list per key. */
const rows = (columns: Record<string, Array<number | string | undefined>>) => {
  const length = Math.max(0, ...Object.values(columns).map((values) => values.length))
  return Array.from({ length }, (_unused, i) => {
    const row: Record<string, number | string> = { time: `t${i}` }
    for (const [key, values] of Object.entries(columns)) {
      const value = values[i]
      if (value !== undefined) row[key] = value
    }
    return row
  })
}

/** The single stats entry for `key`, asserted to exist. */
const statsFor = (all: ChannelStats[], key: string): ChannelStats => {
  const found = all.find((entry) => entry.key === key)
  if (!found) throw new Error(`no stats entry for ${key}`)
  return found
}

describe("computeWindowStats", () => {
  it("reports mean, sample variance and standard deviation of a channel", () => {
    // Hand-computed: mean 4, deviations -2,-1,0,1,2 -> sum of squares 10,
    // sample variance 10/(5-1) = 2.5, sd = sqrt(2.5).
    const data = rows({ force0: [2, 3, 4, 5, 6] })
    const stats = statsFor(computeWindowStats(data, ["force0"], 0, 4), "force0")

    expect(stats.count).toBe(5)
    expect(stats.mean).toBeCloseTo(4, 12)
    expect(stats.variance).toBeCloseTo(2.5, 12)
    expect(stats.stdDev).toBeCloseTo(Math.sqrt(2.5), 12)
    expect(stats.min).toBe(2)
    expect(stats.max).toBe(6)
  })

  it("uses the SAMPLE denominator (n-1), not the population one", () => {
    // Population variance of [1,3] is 1; sample variance is 2. A static-load
    // reading is a sample of a noisy signal, so n-1 is the honest figure.
    const stats = statsFor(computeWindowStats(rows({ f: [1, 3] }), ["f"], 0, 1), "f")
    expect(stats.variance).toBeCloseTo(2, 12)
  })

  it("keeps precision on large offsets, where sum-of-squares collapses", () => {
    // Force channels sit near 1e6 counts with noise of order 1. The naive
    // E[x^2]-E[x]^2 form cancels most of the significant digits here and can
    // even return a negative variance; Welford does not.
    const base = 1_000_000
    const data = rows({ force0: [base - 2, base - 1, base, base + 1, base + 2] })
    const stats = statsFor(computeWindowStats(data, ["force0"], 0, 4), "force0")

    expect(stats.mean).toBeCloseTo(base, 6)
    expect(stats.variance).toBeCloseTo(2.5, 9)
  })

  it("restricts the scan to the requested index window", () => {
    // The window is the brush selection, so samples outside it must not move
    // the mean - that is the whole point of dragging over a load plateau.
    const data = rows({ f: [1000, 5, 5, 5, 1000] })
    const stats = statsFor(computeWindowStats(data, ["f"], 1, 3), "f")

    expect(stats.count).toBe(3)
    expect(stats.mean).toBe(5)
    expect(stats.variance).toBe(0)
  })

  it("clamps a window that runs past either end of the data", () => {
    const data = rows({ f: [1, 2, 3] })
    const stats = statsFor(computeWindowStats(data, ["f"], -5, 99), "f")
    expect(stats.count).toBe(3)
  })

  it("skips gaps and non-numeric values instead of counting them", () => {
    // Rows are merged from several packet types, so a key can be absent on a
    // row, and `time` is a string on every row.
    const data = rows({ f: [1, undefined, 3, Number.NaN, 5] })
    const stats = statsFor(computeWindowStats(data, ["f"], 0, 4), "f")

    expect(stats.count).toBe(3)
    expect(stats.mean).toBe(3)
  })

  it("returns an entry per requested key, in the order asked for", () => {
    const data = rows({ a: [1, 2], b: [10, 20] })
    expect(computeWindowStats(data, ["b", "a"], 0, 1).map((entry) => entry.key)).toEqual(["b", "a"])
  })

  it("accurately computes statistics for combined channels", () => {
    const force0 = [10, 20, 30]
    const force2 = [5, 10, 15]
    const force0_2 = force0.map((v, i) => v + force2[i])
    const data = rows({ force0, force2, force0_2 })
    const stats = statsFor(computeWindowStats(data, ["force0", "force2", "force0_2"], 0, 2), "force0_2")

    expect(stats.count).toBe(3)
    expect(stats.mean).toBe(30)
    expect(stats.min).toBe(15)
    expect(stats.max).toBe(45)
  })

  it("marks an empty window as uncountable rather than zero", () => {
    // count 0 with NaN figures, so the readout can show "-". Reporting mean 0
    // would read as a measured zero.
    const stats = statsFor(computeWindowStats([], ["f"], 0, 0), "f")
    expect(stats.count).toBe(0)
    expect(stats.mean).toBeNaN()
    expect(stats.variance).toBeNaN()
  })

  it("leaves variance undefined for a single sample but still reports its mean", () => {
    const stats = statsFor(computeWindowStats(rows({ f: [7] }), ["f"], 0, 0), "f")
    expect(stats.count).toBe(1)
    expect(stats.mean).toBe(7)
    expect(stats.variance).toBeNaN()
    expect(stats.stdDev).toBeNaN()
  })
})

describe("autoDomainFromStats", () => {
  it("pads the combined span of every counted channel by 5 percent", () => {
    const stats = computeWindowStats(rows({ a: [0, 10], b: [-10, 5] }), ["a", "b"], 0, 1)
    // Span -10..10 -> pad 1.
    expect(autoDomainFromStats(stats)).toEqual([-11, 11])
  })

  it("gives a flat signal headroom so it is not pinned to an axis edge", () => {
    const stats = computeWindowStats(rows({ a: [100, 100] }), ["a"], 0, 1)
    expect(autoDomainFromStats(stats)).toEqual([90, 110])
  })

  it("gives a flat ZERO signal a unit of headroom, since 10 percent of 0 is 0", () => {
    const stats = computeWindowStats(rows({ a: [0, 0] }), ["a"], 0, 1)
    expect(autoDomainFromStats(stats)).toEqual([-1, 1])
  })

  it("defers to recharts when no channel has a usable sample", () => {
    expect(autoDomainFromStats(computeWindowStats([], ["a"], 0, 0))).toEqual(["auto", "auto"])
    expect(autoDomainFromStats([])).toEqual(["auto", "auto"])
  })

  it("ignores an empty channel sitting beside a counted one", () => {
    const stats = computeWindowStats(rows({ a: [0, 10], empty: [] }), ["a", "empty"], 0, 1)
    expect(autoDomainFromStats(stats)).toEqual([-0.5, 10.5])
  })
})

describe("resolveManualDomain", () => {
  it("returns the typed bounds when the axis is manual and they are sane", () => {
    expect(resolveManualDomain({ manual: true, min: "-50", max: "1200.5" })).toEqual([-50, 1200.5])
  })

  it("returns null while the axis is on autoscale, whatever the fields hold", () => {
    expect(resolveManualDomain({ manual: false, min: "0", max: "10" })).toBeNull()
    expect(resolveManualDomain(AUTO_AXIS)).toBeNull()
  })

  it("rejects a blank bound instead of reading it as zero", () => {
    // Number("") is 0, so a half-filled form would silently clamp the axis at 0.
    expect(resolveManualDomain({ manual: true, min: "", max: "10" })).toBeNull()
    expect(resolveManualDomain({ manual: true, min: "0", max: "  " })).toBeNull()
  })

  it("rejects text that merely starts with a number", () => {
    // parseFloat("12abc") is 12; Number() is the strict reading and is what a
    // typo in a range field deserves.
    expect(resolveManualDomain({ manual: true, min: "0", max: "12abc" })).toBeNull()
  })

  it("rejects a non-finite bound", () => {
    expect(resolveManualDomain({ manual: true, min: "-Infinity", max: "10" })).toBeNull()
  })

  it("rejects an inverted or empty range", () => {
    expect(resolveManualDomain({ manual: true, min: "10", max: "1" })).toBeNull()
    expect(resolveManualDomain({ manual: true, min: "5", max: "5" })).toBeNull()
  })

  it("accepts a range that excludes the data, since clipping is the point", () => {
    expect(resolveManualDomain({ manual: true, min: "1e6", max: "2e6" })).toEqual([1e6, 2e6])
  })
})

describe("formatStat", () => {
  it("shows a dash for an uncountable figure", () => {
    expect(formatStat(Number.NaN)).toBe("-")
    expect(formatStat(Number.POSITIVE_INFINITY)).toBe("-")
  })

  it("shows an exact zero as a bare 0", () => {
    expect(formatStat(0)).toBe("0")
  })

  it("keeps large force counts readable to one decimal", () => {
    expect(formatStat(1234.56)).toBe("1234.6")
  })

  it("gives mid-range values three decimals", () => {
    expect(formatStat(4.5)).toBe("4.500")
    expect(formatStat(-12.3456)).toBe("-12.346")
  })

  it("gives sub-unit gyro values five decimals", () => {
    expect(formatStat(0.0421)).toBe("0.04210")
    expect(formatStat(0.00123)).toBe("0.00123")
  })

  it("falls back to exponential at both extremes, where fixed notation fails", () => {
    // Above 1e6 fixed notation is an unreadable digit run; below 1e-3 (a gyro
    // variance, which is in squared units) it rounds to a misleading 0.00000.
    expect(formatStat(1.5e7)).toBe("1.50e+7")
    expect(formatStat(4.2e-6)).toBe("4.20e-6")
  })
})
