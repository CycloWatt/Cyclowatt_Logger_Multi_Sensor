import { describe, expect, it } from "vitest"
import { DEFAULT_POWER_RANGE, type SupportedRange } from "../ftms/protocol"
import { createRunner, reduceRunner, type RunnerEvent, type RunnerState } from "./protocol-runner"
import { planRunnerEffects, type PlanInput } from "./control-plan"

const protocol = {
  name: "Sweet Spot",
  steps: [
    { targetWatts: 150, durationSeconds: 60 },
    { targetWatts: 200, durationSeconds: 60 },
  ],
}

/** The panel's own default when the trainer does not publish 0x2AD8. */
const wideRange = DEFAULT_POWER_RANGE

function plan(overrides: Partial<PlanInput> & { events: RunnerEvent[] }) {
  const input: PlanInput = {
    started: true,
    powerRange: wideRange,
    runnerStatusAfter: "running",
    send: true,
    ...overrides,
  }
  return planRunnerEffects(input)
}

/** The runner drives the events, so the inputs are built the way the panel builds them. */
function running(): RunnerState {
  return reduceRunner(createRunner(protocol), { type: "start" }, 0).state
}

function paused(): RunnerState {
  return reduceRunner(running(), { type: "pause" }, 1_000).state
}

describe("planRunnerEffects rows", () => {
  it("writes one row per event, in event order, with the panel's detail strings", () => {
    const events: RunnerEvent[] = [
      { type: "step-started", stepIndex: 0, targetWatts: 150 },
      { type: "resumed", targetWatts: 150 },
      { type: "paused" },
      { type: "stopped" },
      { type: "finished" },
    ]
    expect(plan({ events }).rows).toEqual([
      { event: "step-started", detail: "step 1 target 150 W" },
      { event: "resumed", detail: "target 150 W" },
      { event: "paused", detail: "" },
      { event: "stopped", detail: "" },
      { event: "finished", detail: "" },
    ])
  })
})

describe("planRunnerEffects runner actions", () => {
  it("start: one step-started row and the step target", () => {
    const { events } = reduceRunner(createRunner(protocol), { type: "start" }, 0)
    const result = plan({ events })
    expect(result.rows).toEqual([{ event: "step-started", detail: "step 1 target 150 W" }])
    expect(result.ops).toEqual([{ kind: "targetPower", label: "Set Target Power 150 W", watts: 150 }])
    expect(result.sequencing).toBe("independent")
    expect(result.startedBeforeOps).toBe(true)
    expect(result.abortChainOnStartFailure).toBe(false)
  })

  it("pause: the paused row and a Pause op, leaving started alone", () => {
    const { events } = reduceRunner(running(), { type: "pause" }, 1_000)
    const result = plan({ events, runnerStatusAfter: "paused" })
    expect(result.rows).toEqual([{ event: "paused", detail: "" }])
    expect(result.ops).toEqual([{ kind: "pause", label: "Pause" }])
    expect(result.sequencing).toBe("independent")
    expect(result.startedBeforeOps).toBe(true)
  })

  it("resume: the resumed row and the current step's target", () => {
    const { events } = reduceRunner(paused(), { type: "resume" }, 5_000)
    const result = plan({ events })
    expect(result.rows).toEqual([{ event: "resumed", detail: "target 150 W" }])
    expect(result.ops).toEqual([{ kind: "targetPower", label: "Set Target Power 150 W", watts: 150 }])
  })

  it("skip from running: the next step's row and its target", () => {
    const { events } = reduceRunner(running(), { type: "skip" }, 10_000)
    const result = plan({ events })
    expect(result.rows).toEqual([{ event: "step-started", detail: "step 2 target 200 W" }])
    expect(result.ops).toEqual([{ kind: "targetPower", label: "Set Target Power 200 W", watts: 200 }])
  })

  it("skip while paused: the row, and NO ops at all", () => {
    const { events } = reduceRunner(paused(), { type: "skip" }, 10_000)
    const result = plan({ events, runnerStatusAfter: "paused" })
    expect(result.rows).toEqual([{ event: "step-started", detail: "step 2 target 200 W" }])
    expect(result.ops).toEqual([])
  })

  it("skip past the last step from running: finished row, then the protocol-end target", () => {
    const last = reduceRunner(running(), { type: "skip" }, 10_000).state
    const { events } = reduceRunner(last, { type: "skip" }, 20_000)
    const result = plan({ events, runnerStatusAfter: "finished" })
    expect(result.rows).toEqual([{ event: "finished", detail: "" }])
    expect(result.ops).toEqual([
      { kind: "targetPower", label: "Set Target Power 50 W (protocol end)", watts: 50 },
    ])
    expect(result.sequencing).toBe("chain")
    expect(result.abortChainOnStartFailure).toBe(true)
    expect(result.startedBeforeOps).toBe(true)
  })

  it("skip past the last step from paused: 0x07 first, marking started, then the target", () => {
    const lastPaused = reduceRunner(paused(), { type: "skip" }, 10_000).state
    const { events } = reduceRunner(lastPaused, { type: "skip" }, 20_000)
    const result = plan({ events, started: false, runnerStatusAfter: "finished" })
    expect(result.ops).toEqual([
      {
        kind: "start",
        label: "Start or Resume (for the protocol-end target)",
        markStartedOnSuccess: true,
      },
      { kind: "targetPower", label: "Set Target Power 50 W (protocol end)", watts: 50 },
    ])
    expect(result.sequencing).toBe("chain")
    expect(result.abortChainOnStartFailure).toBe(true)
    expect(result.startedBeforeOps).toBe(false)
  })

  it("stop from running: stopped row, started cleared before the ops, target then Stop", () => {
    const { events } = reduceRunner(running(), { type: "stop" }, 10_000)
    const result = plan({ events, runnerStatusAfter: "stopped" })
    expect(result.rows).toEqual([{ event: "stopped", detail: "" }])
    expect(result.startedBeforeOps).toBe(false)
    expect(result.ops).toEqual([
      { kind: "targetPower", label: "Set Target Power 50 W (protocol end)", watts: 50 },
      { kind: "stop", label: "Stop" },
    ])
    expect(result.sequencing).toBe("chain")
  })

  it("stop from paused: 0x07 that must NOT mark started, then target, then Stop", () => {
    const { events } = reduceRunner(paused(), { type: "stop" }, 10_000)
    const result = plan({ events, started: false, runnerStatusAfter: "stopped" })
    expect(result.ops).toEqual([
      {
        kind: "start",
        label: "Start or Resume (for the protocol-end target)",
        markStartedOnSuccess: false,
      },
      { kind: "targetPower", label: "Set Target Power 50 W (protocol end)", watts: 50 },
      { kind: "stop", label: "Stop" },
    ])
    expect(result.startedBeforeOps).toBe(false)
    expect(result.abortChainOnStartFailure).toBe(true)
  })
})

describe("planRunnerEffects catch-up and guards", () => {
  it("a tick crossing several boundaries logs every step but sends only the LAST target", () => {
    const ramp = {
      name: "Ramp",
      steps: [
        { targetWatts: 100, durationSeconds: 10 },
        { targetWatts: 110, durationSeconds: 10 },
        { targetWatts: 120, durationSeconds: 10 },
        { targetWatts: 130, durationSeconds: 10 },
      ],
    }
    const started = reduceRunner(createRunner(ramp), { type: "start" }, 0).state
    const { events } = reduceRunner(started, { type: "tick" }, 35_000)
    expect(events).toHaveLength(3)

    const result = plan({ events })
    expect(result.rows).toEqual([
      { event: "step-started", detail: "step 2 target 110 W" },
      { event: "step-started", detail: "step 3 target 120 W" },
      { event: "step-started", detail: "step 4 target 130 W" },
    ])
    expect(result.ops).toEqual([{ kind: "targetPower", label: "Set Target Power 130 W", watts: 130 }])
  })

  it("send:false still writes the rows but plans no ops", () => {
    const { events } = reduceRunner(running(), { type: "pause" }, 1_000)
    const result = plan({ events, send: false, runnerStatusAfter: "paused" })
    expect(result.rows).toEqual([{ event: "paused", detail: "" }])
    expect(result.ops).toEqual([])
    expect(result.startedBeforeOps).toBe(true)
    expect(result.sequencing).toBe("independent")
  })

  it("send:false does not clear started even when stopping", () => {
    const { events } = reduceRunner(running(), { type: "stop" }, 10_000)
    const result = plan({ events, send: false, runnerStatusAfter: "stopped" })
    expect(result.rows).toEqual([{ event: "stopped", detail: "" }])
    expect(result.ops).toEqual([])
    expect(result.startedBeforeOps).toBe(true)
  })

  it("the protocol-end target is snapped into the trainer's own power range", () => {
    const narrow: SupportedRange = { min: 80, max: 400, increment: 5 }
    const { events } = reduceRunner(running(), { type: "stop" }, 10_000)
    const result = plan({ events, powerRange: narrow, runnerStatusAfter: "stopped" })
    expect(result.ops).toEqual([
      { kind: "targetPower", label: "Set Target Power 80 W (protocol end)", watts: 80 },
      { kind: "stop", label: "Stop" },
    ])
  })

  it("step targets are sent raw, exactly as the panel sent them", () => {
    const narrow: SupportedRange = { min: 80, max: 400, increment: 5 }
    const result = plan({
      events: [{ type: "step-started", stepIndex: 0, targetWatts: 152 }],
      powerRange: narrow,
    })
    expect(result.ops).toEqual([{ kind: "targetPower", label: "Set Target Power 152 W", watts: 152 }])
  })

  it("an empty batch plans nothing", () => {
    const result = plan({ events: [] })
    expect(result.rows).toEqual([])
    expect(result.ops).toEqual([])
    expect(result.startedBeforeOps).toBe(true)
  })
})
