import { describe, expect, it } from "vitest"
import { createRunner, reduceRunner } from "./protocol-runner"
import { logProtocolName, logStepIndex } from "./log-context"

const protocol = { name: "Sweet Spot", steps: [{ targetWatts: 150, durationSeconds: 60 }, { targetWatts: 200, durationSeconds: 60 }] }

describe("logProtocolName", () => {
  it("is blank for manual-power and manual-resistance", () => {
    expect(logProtocolName("manual-power", "Sweet Spot")).toBe("")
    expect(logProtocolName("manual-resistance", "Sweet Spot")).toBe("")
  })
  it("is the given name in protocol mode", () => {
    expect(logProtocolName("protocol", "Sweet Spot")).toBe("Sweet Spot")
  })
})

describe("logStepIndex", () => {
  it("is null outside protocol mode, even while the runner is running", () => {
    const { state: running } = reduceRunner(createRunner(protocol), { type: "start" }, 0)
    expect(logStepIndex("manual-power", running)).toBeNull()
    expect(logStepIndex("manual-resistance", running)).toBeNull()
  })
  it("is null for idle, finished, or stopped protocols", () => {
    const idle = createRunner(protocol)
    expect(logStepIndex("protocol", idle)).toBeNull()

    const { state: running } = reduceRunner(idle, { type: "start" }, 0)
    const { state: stopped } = reduceRunner(running, { type: "stop" }, 10)
    expect(logStepIndex("protocol", stopped)).toBeNull()

    const { state: finished } = reduceRunner(running, { type: "tick" }, 200_000)
    expect(logStepIndex("protocol", finished)).toBeNull()
  })
  it("is the runner's stepIndex while running or paused", () => {
    const { state: running } = reduceRunner(createRunner(protocol), { type: "start" }, 0)
    expect(logStepIndex("protocol", running)).toBe(0)

    const { state: paused } = reduceRunner(running, { type: "pause" }, 1000)
    expect(logStepIndex("protocol", paused)).toBe(0)

    const { state: advanced } = reduceRunner(running, { type: "tick" }, 61_000)
    expect(logStepIndex("protocol", advanced)).toBe(1)
  })
})
