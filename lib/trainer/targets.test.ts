import { describe, expect, it } from "vitest"
import { createRunner, reduceRunner } from "./protocol-runner"
import { FINISH_TARGET_W, liveTargetW, protocolTargetW, resistanceTenthsFromPct } from "./targets"

const protocol = { name: "p", steps: [{ targetWatts: 150, durationSeconds: 60 }, { targetWatts: 200, durationSeconds: 60 }] }

describe("protocolTargetW", () => {
  it("is null while idle", () => expect(protocolTargetW(createRunner(protocol), 0)).toBeNull())
  it("is the current step's watts while running and paused", () => {
    const { state: running } = reduceRunner(createRunner(protocol), { type: "start" }, 1000)
    expect(protocolTargetW(running, 1000)).toBe(150)
    const { state: paused } = reduceRunner(running, { type: "pause" }, 2000)
    expect(protocolTargetW(paused, 2000)).toBe(150)
  })
  it("is null once finished or stopped, even though runnerView still reports watts", () => {
    const { state: running } = reduceRunner(createRunner(protocol), { type: "start" }, 0)
    const { state: stopped } = reduceRunner(running, { type: "stop" }, 10)
    expect(protocolTargetW(stopped, 10)).toBeNull()
    const { state: finished } = reduceRunner(running, { type: "tick" }, 200_000)
    expect(protocolTargetW(finished, 200_000)).toBeNull()
  })
})

describe("resistanceTenthsFromPct", () => {
  it("maps 0 and 100 % onto the published range when it fits a uint8", () => {
    const range = { min: 0, max: 200, increment: 10 }
    expect(resistanceTenthsFromPct(0, range)).toBe(0)
    expect(resistanceTenthsFromPct(100, range)).toBe(200)
    expect(resistanceTenthsFromPct(50, range)).toBe(100)
  })
  it("clips the ceiling to 255 tenths, the uint8 the wire carries", () => {
    const range = { min: 0, max: 1000, increment: 10 }
    // NOTE: brief's task-1-brief.md specifies .toBe(250) here; the panel's
    // actual (preserved) behaviour is 255 - see task-1-report.md "Concerns".
    expect(resistanceTenthsFromPct(100, range)).toBe(255)
    expect(resistanceTenthsFromPct(50, range)).toBe(130)
  })
})

describe("liveTargetW", () => {
  const idle = createRunner(protocol)
  it("follows the runner in protocol mode", () => {
    const { state: running } = reduceRunner(idle, { type: "start" }, 0)
    expect(liveTargetW({ mode: "protocol", runner: running, nowMs: 0, manualTargetSent: null, manualTargetW: 999 })).toBe(150)
    expect(liveTargetW({ mode: "protocol", runner: idle, nowMs: 0, manualTargetSent: "power", manualTargetW: 999 })).toBeNull()
  })
  it("shows the manual power target only once it has been sent", () => {
    expect(liveTargetW({ mode: "manual-power", runner: idle, nowMs: 0, manualTargetSent: null, manualTargetW: 120 })).toBeNull()
    expect(liveTargetW({ mode: "manual-power", runner: idle, nowMs: 0, manualTargetSent: "power", manualTargetW: 120 })).toBe(120)
  })
  it("is null in resistance mode", () => {
    expect(liveTargetW({ mode: "manual-resistance", runner: idle, nowMs: 0, manualTargetSent: "resistance", manualTargetW: 120 })).toBeNull()
  })
  it("lands finished protocols at 50 W", () => expect(FINISH_TARGET_W).toBe(50))
})
