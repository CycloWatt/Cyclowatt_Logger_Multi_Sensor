import { describe, expect, it } from "vitest"
import { elapsedLabel, isStale, STALE_MS, stepLabel, targetLabel } from "./labels"

describe("isStale", () => {
  it("is false without a reading and within the window", () => {
    expect(isStale(null, 10_000)).toBe(false)
    expect(isStale(7_500, 10_000)).toBe(false)
  })
  it("is true once STALE_MS has passed", () => expect(isStale(10_000 - STALE_MS - 1, 10_000)).toBe(true))
})

describe("targetLabel", () => {
  it("shows resistance percent only after it was sent", () => {
    expect(targetLabel({ mode: "manual-resistance", manualTargetSent: "resistance", manualResistancePct: 35, liveTargetW: null })).toBe("35 %")
    expect(targetLabel({ mode: "manual-resistance", manualTargetSent: null, manualResistancePct: 35, liveTargetW: null })).toBe("–")
  })
  it("shows watts or a dash otherwise", () => {
    expect(targetLabel({ mode: "protocol", manualTargetSent: null, manualResistancePct: 0, liveTargetW: 200 })).toBe("200 W")
    expect(targetLabel({ mode: "manual-power", manualTargetSent: null, manualResistancePct: 0, liveTargetW: null })).toBe("–")
  })
})

describe("stepLabel", () => {
  it("is Manual outside protocol mode, a dash while idle, else Step i / n", () => {
    expect(stepLabel({ mode: "manual-power", runnerStatus: "running", stepIndex: 0, stepCount: 3 })).toBe("Manual")
    expect(stepLabel({ mode: "protocol", runnerStatus: "idle", stepIndex: 0, stepCount: 3 })).toBe("–")
    expect(stepLabel({ mode: "protocol", runnerStatus: "running", stepIndex: 1, stepCount: 3 })).toBe("Step 2 / 3")
  })
})

describe("elapsedLabel", () => {
  const base = { mode: "protocol" as const, runnerStatus: "running" as const, totalElapsedS: 65, protocolDurationS: 600, recording: false, logStartedAtMs: null, nowMs: 100_000 }
  it("shows protocol elapsed / total while the runner is not idle", () => expect(elapsedLabel(base)).toBe("01:05 / 10:00"))
  it("shows recorded time when recording with a log, outside a running protocol", () => {
    expect(elapsedLabel({ ...base, mode: "manual-power", recording: true, logStartedAtMs: 100_000 - 125_000 })).toBe("02:05 recorded")
  })
  it("needs BOTH recording and a log", () => {
    expect(elapsedLabel({ ...base, mode: "manual-power", recording: true, logStartedAtMs: null })).toBe("–")
    expect(elapsedLabel({ ...base, mode: "manual-power", recording: false, logStartedAtMs: 0 })).toBe("–")
  })
})
