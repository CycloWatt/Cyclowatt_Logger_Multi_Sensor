import { describe, expect, it } from "vitest"
import { FtmsControlError, type FtmsCapabilities } from "../ftms/control"
import { FTMS_OP, FTMS_RESULT } from "../ftms/protocol"
import { createSessionLog } from "./session-log"
import type { ProtocolStep } from "./protocol-runner"
import { TrainerController, type TrainerControllerDeps, type TrainerSession } from "./controller"

/**
 * The trainer these tests drive: a session-shaped object recording every
 * Control Point procedure into ONE ordered array, the same discipline as
 * lib/ftms/control.test.ts's `calls`. The order across ops is the behaviour
 * under test (0x00 before 0x07 before 0x05), not a detail, so there is one log
 * and not one per method - and each entry carries its parameter, because
 * "which target reached the wire" is half of what these tests assert.
 */
const CAPS: FtmsCapabilities = {
  features: null,
  powerRange: { min: 0, max: 1500, increment: 1 },
  // Tenths, on a 1.0-level grid: the range a trainer that publishes no 0x2AD6
  // falls back to, and the one whose 255-tenth wire ceiling the mapping clips to.
  resistanceRange: { min: 0, max: 1000, increment: 10 },
}

function fakeSession() {
  const calls: string[] = []
  /** One-shot failures, keyed by the recorded call name, so `setTargetPower:150` can fail once. */
  const failures = new Map<string, Error>()

  const record = async (name: string): Promise<void> => {
    calls.push(name)
    const failure = failures.get(name)
    if (failure) {
      failures.delete(name)
      throw failure
    }
  }

  const session: TrainerSession = {
    capabilities: CAPS,
    requestControl: () => record("requestControl"),
    reset: () => record("reset"),
    start: () => record("start"),
    stop: () => record("stop"),
    pause: () => record("pause"),
    setTargetPower: (watts: number) => record(`setTargetPower:${watts}`),
    setTargetResistance: (tenths: number) => record(`setTargetResistance:${tenths}`),
    dispose: () => record("dispose"),
  }

  return { session, calls, failNext: (name: string, error: Error) => failures.set(name, error) }
}

const notPermitted = () => new FtmsControlError(FTMS_OP.SET_TARGET_POWER, FTMS_RESULT.CONTROL_NOT_PERMITTED)

/**
 * Drain every pending microtask. The plan interpreter fires the "independent"
 * ops WITHOUT awaiting them (see control-plan.ts), so the rows they write land
 * a few microtasks after the call that triggered them returns; nothing in the
 * controller uses a timer, so one macrotask boundary drains all of it.
 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const TWO_STEPS: ProtocolStep[] = [
  { targetWatts: 150, durationSeconds: 60 },
  { targetWatts: 200, durationSeconds: 60 },
]

function makeController(overrides: Partial<TrainerControllerDeps> = {}) {
  const clock = { ms: 10_000 }
  const controller = new TrainerController({
    openSession: (() => {
      throw new Error("openSession belongs to Task 8")
    }) as unknown as TrainerControllerDeps["openSession"],
    requestDevice: () => {
      throw new Error("requestDevice belongs to Task 8")
    },
    boardDeviceId: () => null,
    now: () => clock.ms,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    log: { log: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  })
  const rows = () => (controller._task8Log?.events ?? []).map((event) => `${event.event}: ${event.detail}`)
  return { controller, clock, rows }
}

/** A controller holding a log and an attached session - where every op below starts. */
async function attached(steps: ProtocolStep[] = TWO_STEPS) {
  const harness = makeController()
  const fake = fakeSession()
  harness.controller._task8Log = createSessionLog(0)
  harness.controller.setSteps(steps)
  await harness.controller.attachSession(fake.session, "Kickr")
  return { ...harness, fake }
}

/** What `attachSession` itself writes, so the assertions below start from a known prefix. */
const ATTACH_ROWS = ["connected: Kickr", "control-result: Request Control -> success"]

describe("attachSession", () => {
  it("takes control and logs the connection", async () => {
    const { controller, fake, rows } = await attached()
    expect(fake.calls).toEqual(["requestControl"])
    expect(rows()).toEqual(ATTACH_ROWS)
    expect(controller.snapshot.connected).toBe(true)
    expect(controller.snapshot.deviceName).toBe("Kickr")
    expect(controller.snapshot.hasControl).toBe(true)
    expect(controller.snapshot.capabilities).toBe(CAPS)
  })
})

describe("takeControl", () => {
  it("sends Request Control and logs its result", async () => {
    const { controller, fake, rows } = await attached()
    fake.calls.length = 0
    await controller.takeControl()
    expect(fake.calls).toEqual(["requestControl"])
    expect(controller.snapshot.hasControl).toBe(true)
    expect(rows().slice(ATTACH_ROWS.length)).toEqual(["control-result: Request Control -> success"])
  })

  it("is a silent no-op with no session - no write attempted, so no row about one", async () => {
    const { controller, rows } = makeController()
    controller._task8Log = createSessionLog(0)
    await controller.takeControl()
    expect(rows()).toEqual([])
    expect(controller.snapshot.hasControl).toBe(false)
  })

  it("still sends when there is no log to write rows into", async () => {
    const { controller, fake } = await attached()
    controller._task8Log = null
    fake.calls.length = 0
    await controller.takeControl()
    expect(fake.calls).toEqual(["requestControl"])
  })
})

describe("startProtocol", () => {
  it("starts the trainer and sends the first step target", async () => {
    const { controller, fake, rows } = await attached()
    await controller.startProtocol()
    await flush()

    expect(fake.calls).toEqual(["requestControl", "start", "setTargetPower:150"])
    expect(rows()).toEqual([
      ...ATTACH_ROWS,
      "control-result: Start or Resume -> success",
      "step-started: step 1 target 150 W",
      "control-result: Set Target Power 150 W -> success",
    ])
    expect(controller.snapshot.runner.status).toBe("running")
    expect(controller.snapshot.starting).toBe(false)
    // The runner shares the edited steps array by reference, as createRunner always has.
    expect(controller.snapshot.runner.protocol.steps).toBe(controller.snapshot.steps)
    expect(controller.snapshot.runner.protocol.name).toBe("Protocol")
  })

  it("names the protocol from the trimmed editor name", async () => {
    const { controller } = await attached()
    controller.setProtocolName("  Ramp  ")
    await controller.startProtocol()
    await flush()
    expect(controller.snapshot.runner.protocol.name).toBe("Ramp")
  })

  it("refuses invalid steps with an error and no write", async () => {
    const { controller, fake, rows } = await attached([])
    fake.calls.length = 0
    await controller.startProtocol()
    await flush()
    expect(fake.calls).toEqual([])
    expect(rows().slice(ATTACH_ROWS.length)).toEqual([])
    expect(controller.snapshot.error).toBe("Cannot start the protocol: add at least one step.")
    expect(controller.snapshot.runner.status).toBe("idle")
  })

  it("holds the door against a second click while the first is still awaiting", async () => {
    const { controller, fake } = await attached()
    const first = controller.startProtocol()
    const second = controller.startProtocol()
    await Promise.all([first, second])
    await flush()
    // One runner, one 0x07, one target: the synchronous guard saw the second click.
    expect(fake.calls).toEqual(["requestControl", "start", "setTargetPower:150"])
  })
})

describe("pause, resume, skip and stop", () => {
  async function running() {
    const harness = await attached()
    await harness.controller.startProtocol()
    await flush()
    harness.fake.calls.length = 0
    return harness
  }

  it("pauses with one 0x08 and clears started, so Resume sends 0x07 again", async () => {
    const { controller, fake, rows } = await running()
    controller.dispatchRunner({ type: "pause" })
    await flush()
    expect(fake.calls).toEqual(["pause"])
    expect(rows().at(-2)).toBe("paused: ")
    expect(rows().at(-1)).toBe("control-result: Pause -> success")

    fake.calls.length = 0
    await controller.resumeProtocol()
    await flush()
    expect(fake.calls).toEqual(["start", "setTargetPower:150"])
    expect(rows().slice(-3)).toEqual([
      "control-result: Start or Resume -> success",
      "resumed: target 150 W",
      "control-result: Set Target Power 150 W -> success",
    ])
  })

  it("skips while paused with a row and NO write - the trainer holds no target to change", async () => {
    const { controller, fake, rows } = await running()
    controller.dispatchRunner({ type: "pause" })
    await flush()
    fake.calls.length = 0

    controller.dispatchRunner({ type: "skip" })
    await flush()
    expect(fake.calls).toEqual([])
    expect(rows().at(-1)).toBe("step-started: step 2 target 200 W")
  })

  it("stops from paused with 0x07, the 50 W protocol-end target and then 0x08", async () => {
    const { controller, fake, rows } = await running()
    controller.dispatchRunner({ type: "pause" })
    await flush()
    fake.calls.length = 0

    controller.dispatchRunner({ type: "stop" })
    await flush()
    expect(fake.calls).toEqual(["start", "setTargetPower:50", "stop"])
    expect(rows().slice(-4)).toEqual([
      "stopped: ",
      "control-result: Start or Resume (for the protocol-end target) -> success",
      "control-result: Set Target Power 50 W (protocol end) -> success",
      "control-result: Stop -> success",
    ])
    expect(controller.snapshot.runner.status).toBe("stopped")
  })

  it("ignores an action the runner refuses, without a row or a write", async () => {
    const { controller, fake, rows } = await running()
    const before = rows().length
    controller.dispatchRunner({ type: "resume" }) // already running
    await flush()
    expect(fake.calls).toEqual([])
    expect(rows().length).toBe(before)
  })
})

describe("tick", () => {
  it("sends only the LAST step of a late catch-up tick", async () => {
    const { controller, fake, rows } = await attached([
      { targetWatts: 150, durationSeconds: 60 },
      { targetWatts: 200, durationSeconds: 60 },
      { targetWatts: 250, durationSeconds: 60 },
    ])
    await controller.startProtocol()
    await flush()
    fake.calls.length = 0

    controller.tick(10_000 + 130_000)
    await flush()
    expect(fake.calls).toEqual(["setTargetPower:250"])
    expect(rows().slice(-3)).toEqual([
      "step-started: step 2 target 200 W",
      "step-started: step 3 target 250 W",
      "control-result: Set Target Power 250 W -> success",
    ])
  })

  it("does nothing at all when no boundary has been crossed", async () => {
    const { controller, fake, rows } = await attached()
    await controller.startProtocol()
    await flush()
    const before = rows().length
    fake.calls.length = 0

    controller.tick(10_500)
    await flush()
    expect(fake.calls).toEqual([])
    expect(rows().length).toBe(before)
  })
})

describe("sendControl", () => {
  it("re-takes control and re-starts after CONTROL_NOT_PERMITTED", async () => {
    const { controller, fake, rows } = await attached()
    fake.failNext("setTargetPower:150", notPermitted())
    await controller.startProtocol()
    await flush()

    // The first two are attachSession's 0x00 and ensureStarted's 0x07; the tail
    // is the retry - the refused target, a fresh 0x00, 0x07 again, then the target.
    expect(fake.calls).toEqual([
      "requestControl",
      "start",
      "setTargetPower:150",
      "requestControl",
      "start",
      "setTargetPower:150",
    ])
    expect(rows().at(-1)).toBe(
      "control-result: Set Target Power 150 W -> success after re-taking control and re-starting",
    )
    expect(controller.snapshot.hasControl).toBe(true)
  })

  it("re-takes control WITHOUT re-starting for a Pause", async () => {
    const { controller, fake, rows } = await attached()
    await controller.startProtocol()
    await flush()
    fake.calls.length = 0

    fake.failNext("pause", notPermitted())
    controller.dispatchRunner({ type: "pause" })
    await flush()
    expect(fake.calls).toEqual(["pause", "requestControl", "pause"])
    expect(rows().at(-1)).toBe("control-result: Pause -> success after re-taking control")
  })

  it("swallows an ordinary failure, logging and surfacing it", async () => {
    const { controller, fake, rows } = await attached()
    await controller.startProtocol()
    await flush()
    fake.calls.length = 0

    fake.failNext("pause", new Error("boom"))
    controller.dispatchRunner({ type: "pause" })
    await flush()
    expect(fake.calls).toEqual(["pause"])
    expect(rows().at(-1)).toBe("control-result: Pause -> failed: boom")
    expect(controller.snapshot.error).toBe("Pause failed: boom")
    // The runner still moved: a target that did not land must not strand the rider.
    expect(controller.snapshot.runner.status).toBe("paused")
  })
})

describe("onControlLost", () => {
  it("drops control, pauses the protocol and writes NO Control Point op", async () => {
    const { controller, fake, rows } = await attached()
    await controller.startProtocol()
    await flush()
    fake.calls.length = 0
    const before = rows().length

    controller.onControlLost()
    await flush()
    expect(fake.calls).toEqual([])
    // The `status` row ahead of these two is written by the panel's onStatus
    // handler, which the session fires first (see lib/ftms/control.ts).
    expect(rows().slice(before)).toEqual(["control-lost: the trainer revoked control", "paused: "])
    expect(controller.snapshot.hasControl).toBe(false)
    expect(controller.snapshot.manualTargetSent).toBeNull()
    expect(controller.snapshot.runner.status).toBe("paused")
    expect(controller.snapshot.error).toBe(
      "The trainer revoked control (another app took it). Press Take Control to continue.",
    )
  })
})

describe("manual targets", () => {
  it("sends a manual power target and records that it is the live one", async () => {
    const { controller, fake, rows } = await attached()
    fake.calls.length = 0
    await controller.sendManualPower(180)
    await flush()
    expect(fake.calls).toEqual(["start", "setTargetPower:180"])
    expect(rows().at(-1)).toBe("target-set: 180 W (manual)")
    expect(controller.snapshot.manualTargetSent).toBe("power")
  })

  it("maps a resistance percentage onto the trainer's own grid", async () => {
    const { controller, fake, rows } = await attached()
    fake.calls.length = 0
    await controller.sendManualResistance(100)
    await flush()
    // 255, not 250: the published max is 1000 tenths but the wire carries one
    // uint8, so resistanceTenthsFromPct clips the ceiling (task-1-report.md's
    // "Concerns" - the briefs say 250, the preserved panel behaviour is 255).
    expect(fake.calls).toEqual(["start", "setTargetResistance:255"])
    expect(rows().at(-1)).toBe("target-set: 100 % -> 25.5 resistance level (manual)")
    expect(controller.snapshot.manualTargetSent).toBe("resistance")
  })
})

describe("snapshot and subscribe", () => {
  it("rebuilds a NEW snapshot object on every change and never mutates the old one", async () => {
    const { controller } = await attached()
    const first = controller.snapshot
    await controller.startProtocol()
    await flush()
    expect(controller.snapshot).not.toBe(first)
    expect(first.runner.status).toBe("idle") // the old object still describes the old state
  })

  it("stops calling a listener once it unsubscribes", async () => {
    const { controller } = await attached()
    let calls = 0
    const unsubscribe = controller.subscribe(() => {
      calls += 1
    })
    controller.setProtocolName("a")
    const afterFirst = calls
    unsubscribe()
    controller.setProtocolName("b")
    expect(afterFirst).toBeGreaterThan(0)
    expect(calls).toBe(afterFirst)
  })
})
