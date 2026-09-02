import { describe, expect, it } from "vitest"
import {
  createRunner,
  generateRamp,
  protocolDurationSeconds,
  reduceRunner,
  runnerView,
  type Protocol,
} from "./protocol-runner"

/** One step's duration, in seconds, used by every fixture protocol below. */
const D = 60

/** Four 60 s steps. Long enough to walk several boundaries in one tick. */
const P4: Protocol = {
  name: "p4",
  steps: [
    { targetWatts: 100, durationSeconds: D },
    { targetWatts: 150, durationSeconds: D },
    { targetWatts: 200, durationSeconds: D },
    { targetWatts: 250, durationSeconds: D },
  ],
}

/** Two 60 s steps, for tests that only need a "last step". */
const P2: Protocol = {
  name: "p2",
  steps: [
    { targetWatts: 100, durationSeconds: D },
    { targetWatts: 200, durationSeconds: D },
  ],
}

/** Three 60 s steps, for the runnerView "step 1 of 3" case. */
const P3: Protocol = {
  name: "p3",
  steps: [
    { targetWatts: 100, durationSeconds: D },
    { targetWatts: 150, durationSeconds: D },
    { targetWatts: 200, durationSeconds: D },
  ],
}

const EMPTY: Protocol = { name: "empty", steps: [] }

const T0 = 10_000

describe("createRunner", () => {
  it("starts idle", () => {
    const state = createRunner(P4)
    expect(state.status).toBe("idle")
    expect(state.stepIndex).toBe(0)
  })
})

describe("reduceRunner: start", () => {
  it("emits step-started(0) and moves to running", () => {
    const { state, events } = reduceRunner(createRunner(P4), { type: "start" }, T0)
    expect(state.status).toBe("running")
    expect(state.stepIndex).toBe(0)
    expect(state.stepStartedAtMs).toBe(T0)
    expect(state.protocolStartedAtMs).toBe(T0)
    expect(state.totalPausedMs).toBe(0)
    expect(events).toEqual([{ type: "step-started", stepIndex: 0, targetWatts: 100 }])
  })

  it("is a no-op while running", () => {
    const { state: running } = reduceRunner(createRunner(P4), { type: "start" }, T0)
    const result = reduceRunner(running, { type: "start" }, T0 + 1000)
    expect(result.state).toBe(running)
    expect(result.events).toEqual([])
  })

  it("is a no-op while paused", () => {
    const { state: running } = reduceRunner(createRunner(P4), { type: "start" }, T0)
    const { state: paused } = reduceRunner(running, { type: "pause" }, T0 + 1000)
    const result = reduceRunner(paused, { type: "start" }, T0 + 2000)
    expect(result.state).toBe(paused)
    expect(result.events).toEqual([])
  })

  it("restarts at step 0 from stopped", () => {
    const { state: running } = reduceRunner(createRunner(P2), { type: "start" }, T0)
    const { state: stopped } = reduceRunner(running, { type: "stop" }, T0 + 1000)
    const { state, events } = reduceRunner(stopped, { type: "start" }, T0 + 5000)
    expect(state.status).toBe("running")
    expect(state.stepIndex).toBe(0)
    expect(state.stepStartedAtMs).toBe(T0 + 5000)
    expect(events).toEqual([{ type: "step-started", stepIndex: 0, targetWatts: 100 }])
  })

  it("on an empty protocol goes straight to finished", () => {
    const { state, events } = reduceRunner(createRunner(EMPTY), { type: "start" }, T0)
    expect(state.status).toBe("finished")
    expect(events).toEqual([{ type: "finished" }])
  })
})

describe("reduceRunner: tick", () => {
  it("emits nothing just before the step boundary", () => {
    const { state: running } = reduceRunner(createRunner(P4), { type: "start" }, T0)
    const result = reduceRunner(running, { type: "tick" }, T0 + 0.9 * D * 1000)
    expect(result.events).toEqual([])
    expect(result.state).toBe(running)
  })

  it("emits step-started(1) exactly at the step boundary", () => {
    const { state: running } = reduceRunner(createRunner(P4), { type: "start" }, T0)
    const { state, events } = reduceRunner(running, { type: "tick" }, T0 + D * 1000)
    expect(events).toEqual([{ type: "step-started", stepIndex: 1, targetWatts: 150 }])
    expect(state.stepIndex).toBe(1)
    expect(state.stepStartedAtMs).toBe(T0 + D * 1000)
  })

  it("walks every boundary passed since the last tick, in order, drift-free", () => {
    const { state: running } = reduceRunner(createRunner(P4), { type: "start" }, T0)
    const { state, events } = reduceRunner(running, { type: "tick" }, T0 + 3 * D * 1000)
    expect(events).toEqual([
      { type: "step-started", stepIndex: 1, targetWatts: 150 },
      { type: "step-started", stepIndex: 2, targetWatts: 200 },
      { type: "step-started", stepIndex: 3, targetWatts: 250 },
    ])
    // Boundaries added exactly D*1000 each time, so no drift versus the literal sum.
    expect(state.stepStartedAtMs).toBe(T0 + 3 * D * 1000)
  })

  it("finishes once the last step's duration has passed, then further ticks are no-ops", () => {
    const { state: running } = reduceRunner(createRunner(P2), { type: "start" }, T0)
    const { state: finished, events } = reduceRunner(running, { type: "tick" }, T0 + 2 * D * 1000)
    expect(events).toEqual([{ type: "step-started", stepIndex: 1, targetWatts: 200 }, { type: "finished" }])
    expect(finished.status).toBe("finished")

    const result = reduceRunner(finished, { type: "tick" }, T0 + 10 * D * 1000)
    expect(result.events).toEqual([])
    expect(result.state).toBe(finished)
  })

  it("is a no-op while idle", () => {
    const idle = createRunner(P4)
    const result = reduceRunner(idle, { type: "tick" }, T0)
    expect(result.state).toBe(idle)
    expect(result.events).toEqual([])
  })
})

describe("reduceRunner: pause / resume", () => {
  it("pauses while running, freezes the view, and resume shifts timestamps by the pause duration", () => {
    const { state: running } = reduceRunner(createRunner(P4), { type: "start" }, T0)

    const pauseAt = T0 + 5000
    const { state: paused, events: pauseEvents } = reduceRunner(running, { type: "pause" }, pauseAt)
    expect(paused.status).toBe("paused")
    expect(paused.pausedAtMs).toBe(pauseAt)
    expect(pauseEvents).toEqual([{ type: "paused" }])

    // A late tick while paused must do nothing at all.
    const tickAt = pauseAt + 60_000
    const tickResult = reduceRunner(paused, { type: "tick" }, tickAt)
    expect(tickResult.events).toEqual([])
    expect(tickResult.state).toBe(paused)

    const frozenView = runnerView(paused, tickAt)
    expect(frozenView.stepElapsedS).toBe(5)
    expect(frozenView.stepRemainingS).toBe(D - 5)

    const resumeAt = tickAt
    const { state: resumed, events: resumeEvents } = reduceRunner(paused, { type: "resume" }, resumeAt)
    expect(resumed.status).toBe("running")
    expect(resumed.pausedAtMs).toBeNull()
    expect(resumed.stepStartedAtMs).toBe(T0 + 60_000)
    expect(resumed.protocolStartedAtMs).toBe(T0 + 60_000)
    expect(resumed.totalPausedMs).toBe(60_000)
    expect(resumeEvents).toEqual([{ type: "resumed", targetWatts: 100 }])

    // Elapsed time picks up right where it left off; the pause is invisible to it.
    const resumedView = runnerView(resumed, resumeAt)
    expect(resumedView.stepElapsedS).toBe(5)
    expect(resumedView.totalElapsedS).toBe(5)
  })

  it("is a no-op to pause while idle", () => {
    const idle = createRunner(P4)
    const result = reduceRunner(idle, { type: "pause" }, T0)
    expect(result.state).toBe(idle)
    expect(result.events).toEqual([])
  })

  it("is a no-op to resume while running", () => {
    const { state: running } = reduceRunner(createRunner(P4), { type: "start" }, T0)
    const result = reduceRunner(running, { type: "resume" }, T0 + 1000)
    expect(result.state).toBe(running)
    expect(result.events).toEqual([])
  })
})

describe("reduceRunner: skip", () => {
  it("moves to the next step with stepStartedAtMs = now", () => {
    const { state: running } = reduceRunner(createRunner(P2), { type: "start" }, T0)
    const skipAt = T0 + 20_000
    const { state, events } = reduceRunner(running, { type: "skip" }, skipAt)
    expect(events).toEqual([{ type: "step-started", stepIndex: 1, targetWatts: 200 }])
    expect(state.stepIndex).toBe(1)
    expect(state.stepStartedAtMs).toBe(skipAt)
  })

  it("finishes when skipping past the last step", () => {
    const { state: running } = reduceRunner(createRunner(P2), { type: "start" }, T0)
    const { state: onLast } = reduceRunner(running, { type: "skip" }, T0 + 20_000)
    const { state, events } = reduceRunner(onLast, { type: "skip" }, T0 + 30_000)
    expect(events).toEqual([{ type: "finished" }])
    expect(state.status).toBe("finished")
  })

  it("stays paused, with pausedAtMs = now, when skipping while paused", () => {
    const { state: running } = reduceRunner(createRunner(P2), { type: "start" }, T0)
    const { state: paused } = reduceRunner(running, { type: "pause" }, T0 + 1000)
    const skipAt = T0 + 2000
    const { state, events } = reduceRunner(paused, { type: "skip" }, skipAt)
    expect(state.status).toBe("paused")
    expect(state.pausedAtMs).toBe(skipAt)
    expect(events).toEqual([{ type: "step-started", stepIndex: 1, targetWatts: 200 }])
  })

  it("is a no-op while idle", () => {
    const idle = createRunner(P4)
    const result = reduceRunner(idle, { type: "skip" }, T0)
    expect(result.state).toBe(idle)
    expect(result.events).toEqual([])
  })
})

describe("reduceRunner: stop", () => {
  it("stops from running", () => {
    const { state: running } = reduceRunner(createRunner(P2), { type: "start" }, T0)
    const { state, events } = reduceRunner(running, { type: "stop" }, T0 + 1000)
    expect(state.status).toBe("stopped")
    expect(events).toEqual([{ type: "stopped" }])
  })

  it("stops from paused", () => {
    const { state: running } = reduceRunner(createRunner(P2), { type: "start" }, T0)
    const { state: paused } = reduceRunner(running, { type: "pause" }, T0 + 1000)
    const { state, events } = reduceRunner(paused, { type: "stop" }, T0 + 2000)
    expect(state.status).toBe("stopped")
    expect(events).toEqual([{ type: "stopped" }])
  })

  it("is a no-op while idle", () => {
    const idle = createRunner(P4)
    const result = reduceRunner(idle, { type: "stop" }, T0)
    expect(result.state).toBe(idle)
    expect(result.events).toEqual([])
  })
})

describe("reduceRunner: purity", () => {
  it("never mutates the input state", () => {
    const running = reduceRunner(createRunner(P4), { type: "start" }, T0).state
    const before = JSON.parse(JSON.stringify(running))
    Object.freeze(running)

    // None of these should throw (would, if the reducer wrote to a frozen field)
    // and the snapshot taken before must still match afterwards.
    reduceRunner(running, { type: "tick" }, T0 + D * 1000)
    reduceRunner(running, { type: "pause" }, T0 + 1000)
    reduceRunner(running, { type: "skip" }, T0 + 2000)
    reduceRunner(running, { type: "stop" }, T0 + 3000)

    expect(JSON.parse(JSON.stringify(running))).toEqual(before)
  })
})

describe("runnerView", () => {
  it("is all nulls/zeros (but a real stepCount) while idle", () => {
    const view = runnerView(createRunner(P3), T0)
    expect(view).toEqual({
      currentStep: null,
      nextStep: null,
      stepIndex: 0,
      stepCount: 3,
      stepElapsedS: 0,
      stepRemainingS: 0,
      totalElapsedS: 0,
      totalRemainingS: 0,
      targetWatts: null,
    })
  })

  it("reports the current and next step, and running totals, mid-protocol", () => {
    const { state: running } = reduceRunner(createRunner(P3), { type: "start" }, T0)
    const { state: onStep1 } = reduceRunner(running, { type: "tick" }, T0 + D * 1000)
    const view = runnerView(onStep1, T0 + D * 1000 + 10_000)

    expect(view.currentStep).toEqual({ targetWatts: 150, durationSeconds: D })
    expect(view.nextStep).toEqual({ targetWatts: 200, durationSeconds: D })
    expect(view.stepIndex).toBe(1)
    expect(view.stepCount).toBe(3)
    expect(view.stepElapsedS).toBe(10)
    expect(view.stepRemainingS).toBe(D - 10)
    expect(view.totalElapsedS).toBe(D + 10)
    expect(view.totalRemainingS).toBe(3 * D - (D + 10))
    expect(view.targetWatts).toBe(150)
  })
})

describe("protocolDurationSeconds", () => {
  it("sums every step's duration", () => {
    expect(protocolDurationSeconds(P3)).toBe(3 * D)
    expect(protocolDurationSeconds(EMPTY)).toBe(0)
  })
})

describe("generateRamp", () => {
  it("builds an inclusive ramp from startWatts to endWatts", () => {
    const steps = generateRamp({ startWatts: 100, incrementWatts: 25, stepDurationSeconds: 60, endWatts: 300 })
    expect(steps).toHaveLength(9)
    expect(steps.map((s) => s.targetWatts)).toEqual([100, 125, 150, 175, 200, 225, 250, 275, 300])
    expect(steps.every((s) => s.durationSeconds === 60)).toBe(true)
  })

  it("builds a ramp of a fixed stepCount", () => {
    const steps = generateRamp({ startWatts: 100, incrementWatts: 25, stepDurationSeconds: 60, stepCount: 5 })
    expect(steps.map((s) => s.targetWatts)).toEqual([100, 125, 150, 175, 200])
  })

  it("returns [] for a zero increment", () => {
    expect(generateRamp({ startWatts: 100, incrementWatts: 0, stepDurationSeconds: 60, endWatts: 200 })).toEqual([])
  })

  it("returns [] when neither end condition is given", () => {
    expect(generateRamp({ startWatts: 100, incrementWatts: 25, stepDurationSeconds: 60 })).toEqual([])
  })

  it("returns [] when both end conditions are given", () => {
    expect(
      generateRamp({ startWatts: 100, incrementWatts: 25, stepDurationSeconds: 60, endWatts: 300, stepCount: 5 }),
    ).toEqual([])
  })

  it("returns [] for a non-positive duration", () => {
    expect(generateRamp({ startWatts: 100, incrementWatts: 25, stepDurationSeconds: 0, endWatts: 200 })).toEqual([])
  })

  it("returns [] for a stepCount <= 0", () => {
    expect(generateRamp({ startWatts: 100, incrementWatts: 25, stepDurationSeconds: 60, stepCount: 0 })).toEqual([])
  })

  it("builds a descending ramp with a negative increment", () => {
    const steps = generateRamp({ startWatts: 300, incrementWatts: -25, stepDurationSeconds: 60, endWatts: 100 })
    expect(steps.map((s) => s.targetWatts)).toEqual([300, 275, 250, 225, 200, 175, 150, 125, 100])
  })

  it("caps at 200 steps", () => {
    const steps = generateRamp({ startWatts: 0, incrementWatts: 1, stepDurationSeconds: 1, stepCount: 10_000 })
    expect(steps).toHaveLength(200)
  })
})
