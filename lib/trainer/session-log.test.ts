import { describe, expect, it } from "vitest"
import {
  appendEvent,
  appendSample,
  createSessionLog,
  formatEpochSeconds,
  SESSION_CSV_COLUMNS,
  sessionLogFilename,
  sessionLogToCsv,
  type EventRow,
  type SampleRow,
} from "./session-log"

/** A sample row with sane defaults; override only what a test is about. */
const sample = (over: Partial<SampleRow> = {}): SampleRow => ({
  epochMs: 1_756_800_000_123,
  elapsedS: 12.345,
  mode: "protocol",
  protocolName: "Sweet Spot",
  stepIndex: 1,
  stepTargetW: 200,
  targetResistancePct: null,
  powerW: 198,
  cadenceRpm: 88,
  speedKmh: 32.1,
  hrBpm: 142,
  ...over,
})

/** An event row with sane defaults; override only what a test is about. */
const event = (over: Partial<EventRow> = {}): EventRow => ({
  epochMs: 1_756_800_000_123,
  elapsedS: 12.345,
  mode: "protocol",
  protocolName: "Sweet Spot",
  stepIndex: 1,
  event: "step-started",
  detail: "step 2 of 5",
  ...over,
})

describe("createSessionLog", () => {
  it("starts with an empty sample and event list", () => {
    const log = createSessionLog(1_000)
    expect(log).toEqual({ startedAtMs: 1_000, samples: [], events: [] })
  })
})

describe("appendSample / appendEvent", () => {
  it("mutate the given log by pushing", () => {
    const log = createSessionLog(1_000)
    appendSample(log, sample())
    appendEvent(log, event())

    expect(log.samples).toHaveLength(1)
    expect(log.samples[0]).toEqual(sample())
    expect(log.events).toHaveLength(1)
    expect(log.events[0]).toEqual(event())
  })
})

describe("formatEpochSeconds", () => {
  it("always shows exactly 3 decimals", () => {
    expect(formatEpochSeconds(1_756_800_000_123)).toBe("1756800000.123")
  })

  it("formats zero as 0.000", () => {
    expect(formatEpochSeconds(0)).toBe("0.000")
  })

  it("hands the rounding of a borderline fraction to toFixed", () => {
    // epochMs / 1000 === 1000.9995 mathematically; floating point puts the
    // actual double a hair above that, so toFixed(3) rounds up rather than to
    // even. Pinning the real behaviour here rather than a hand-picked answer.
    expect(formatEpochSeconds(1_000_999.5)).toBe((1_000_999.5 / 1000).toFixed(3))
    expect(formatEpochSeconds(1_000_999.5)).toBe("1001.000")
  })
})

describe("sessionLogToCsv", () => {
  it("writes the header even for an empty log", () => {
    const csv = sessionLogToCsv(createSessionLog(0))
    expect(csv).toBe(SESSION_CSV_COLUMNS.join(",") + "\n")
  })

  it("ends with exactly one trailing newline", () => {
    const log = createSessionLog(0)
    appendSample(log, sample())
    const csv = sessionLogToCsv(log)
    expect(csv.endsWith("\n")).toBe(true)
    expect(csv.endsWith("\n\n")).toBe(false)
  })

  it("header line matches SESSION_CSV_COLUMNS", () => {
    const csv = sessionLogToCsv(createSessionLog(0))
    expect(csv.split("\n")[0]).toBe(SESSION_CSV_COLUMNS.join(","))
  })

  it("writes a sample row with epoch_s to 3 decimals, iso_time, and blank event columns", () => {
    const log = createSessionLog(0)
    appendSample(log, sample())
    const line = sessionLogToCsv(log).trimEnd().split("\n")[1]

    expect(line).toBe(
      [
        "1756800000.123",
        new Date(1_756_800_000_123).toISOString(),
        "12.345",
        "", // event
        "", // event_detail
        "protocol",
        "Sweet Spot",
        "1",
        "200",
        "", // targetResistancePct is null
        "198",
        "88",
        "32.1",
        "142",
      ].join(","),
    )
  })

  it("blanks every nullable measurement on a sample row", () => {
    const log = createSessionLog(0)
    appendSample(
      log,
      sample({
        stepIndex: null,
        stepTargetW: null,
        targetResistancePct: null,
        powerW: null,
        cadenceRpm: null,
        speedKmh: null,
        hrBpm: null,
      }),
    )
    const cells = sessionLogToCsv(log).trimEnd().split("\n")[1].split(",")
    const idx = (col: (typeof SESSION_CSV_COLUMNS)[number]) => SESSION_CSV_COLUMNS.indexOf(col)

    expect(cells[idx("step_index")]).toBe("")
    expect(cells[idx("step_target_w")]).toBe("")
    expect(cells[idx("target_resistance_pct")]).toBe("")
    expect(cells[idx("power_w")]).toBe("")
    expect(cells[idx("cadence_rpm")]).toBe("")
    expect(cells[idx("speed_kmh")]).toBe("")
    expect(cells[idx("hr_bpm")]).toBe("")
  })

  it("writes an event row with blank measurement columns and present event/detail", () => {
    const log = createSessionLog(0)
    appendEvent(log, event())
    const line = sessionLogToCsv(log).trimEnd().split("\n")[1]

    expect(line).toBe(
      [
        "1756800000.123",
        new Date(1_756_800_000_123).toISOString(),
        "12.345",
        "step-started",
        "step 2 of 5",
        "protocol",
        "Sweet Spot",
        "1",
        "", // step_target_w
        "", // target_resistance_pct
        "", // power_w
        "", // cadence_rpm
        "", // speed_kmh
        "", // hr_bpm
      ].join(","),
    )
  })

  it("quotes an event detail containing a comma", () => {
    const log = createSessionLog(0)
    appendEvent(log, event({ detail: "target set to 200W, up from 180W" }))
    expect(sessionLogToCsv(log)).toContain('"target set to 200W, up from 180W"')
  })

  it("quotes a protocol name containing a comma", () => {
    const log = createSessionLog(0)
    appendSample(log, sample({ protocolName: "Step test, part 2" }))
    expect(sessionLogToCsv(log)).toContain('"Step test, part 2"')
  })

  it("merges samples and events sorted by epochMs ascending", () => {
    const log = createSessionLog(0)
    appendSample(log, sample({ epochMs: 300, elapsedS: 0.3 }))
    appendEvent(log, event({ epochMs: 100, elapsedS: 0.1 }))
    appendSample(log, sample({ epochMs: 200, elapsedS: 0.2 }))

    const epochCol = SESSION_CSV_COLUMNS.indexOf("epoch_s")
    const rows = sessionLogToCsv(log).trimEnd().split("\n").slice(1)
    expect(rows.map((r) => r.split(",")[epochCol])).toEqual(["0.100", "0.200", "0.300"])
  })

  it("puts the sample before the event on a tied epochMs, regardless of append order", () => {
    const log = createSessionLog(0)
    // Event appended first, sample second - the tie-break must not depend on
    // insertion order, only on kind.
    appendEvent(log, event({ epochMs: 500 }))
    appendSample(log, sample({ epochMs: 500 }))

    const eventCol = SESSION_CSV_COLUMNS.indexOf("event")
    const rows = sessionLogToCsv(log).trimEnd().split("\n").slice(1)
    expect(rows.map((r) => r.split(",")[eventCol])).toEqual(["", "step-started"])
  })
})

describe("sessionLogFilename", () => {
  const fixed = new Date(2026, 8, 2, 7, 5, 9) // local: 2026-09-02 07:05:09

  const pad2 = (n: number) => String(n).padStart(2, "0")
  const expectedDate = `${fixed.getFullYear()}-${pad2(fixed.getMonth() + 1)}-${pad2(fixed.getDate())}`
  const expectedTime = `${pad2(fixed.getHours())}${pad2(fixed.getMinutes())}${pad2(fixed.getSeconds())}`

  it("builds kickr_<slug>_<date>_<time>.csv from the protocol name and local time", () => {
    expect(sessionLogFilename("Sweet Spot", fixed.getTime())).toBe(
      `kickr_sweet-spot_${expectedDate}_${expectedTime}.csv`,
    )
  })

  it("slugifies runs of non [a-z0-9] characters into a single dash, trimmed", () => {
    expect(sessionLogFilename("Step test 100→300 W / 3 min", fixed.getTime())).toBe(
      `kickr_step-test-100-300-w-3-min_${expectedDate}_${expectedTime}.csv`,
    )
  })

  it("falls back to 'session' for a name with no [a-z0-9] characters", () => {
    expect(sessionLogFilename("!!!", fixed.getTime())).toBe(`kickr_session_${expectedDate}_${expectedTime}.csv`)
  })

  it("falls back to 'session' for an empty name", () => {
    expect(sessionLogFilename("", fixed.getTime())).toBe(`kickr_session_${expectedDate}_${expectedTime}.csv`)
  })

  it("pads a single-digit month, day, hour, minute and second", () => {
    const early = new Date(2026, 0, 3, 1, 2, 3) // 2026-01-03 01:02:03
    expect(sessionLogFilename("Test", early.getTime())).toBe(`kickr_test_2026-01-03_010203.csv`)
  })
})
