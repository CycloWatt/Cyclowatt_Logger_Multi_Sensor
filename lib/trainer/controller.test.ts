import { describe, expect, it } from "vitest"
import { FtmsControlError, type FtmsCapabilities, type FtmsSessionHandlers } from "../ftms/control"
import { FTMS_OP, FTMS_OPTIONAL_SERVICES, FTMS_RESULT, type FtmsStatus } from "../ftms/protocol"
import type { IndoorBikeData } from "../ftms/indoor-bike-data"
import { CHART_MAX_POINTS } from "./chart-buffer"
import { sessionLogFilename, sessionLogToCsv } from "./session-log"
import type { ProtocolStep } from "./protocol-runner"
import {
  TrainerController,
  type TrainerControllerDeps,
  type TrainerDevice,
  type TrainerSession,
} from "./controller"

/**
 * The trainer these tests drive: a session-shaped object recording every
 * Control Point procedure into ONE ordered array, the same discipline as
 * lib/ftms/control.test.ts's `calls`. The order across ops is the behaviour
 * under test (0x00 before 0x07 before 0x05, and `dispose` before
 * `gatt.disconnect`), not a detail, so there is one log and not one per method -
 * and each entry carries its parameter, because "which target reached the wire"
 * is half of what these tests assert.
 *
 * NO `vi.useFakeTimers()`: the controller takes its clock and its timers as
 * deps, so `harness` hands it a clock it can set and a timer registry it can
 * inspect and fire. That leaves the real `setTimeout` free for `flush()` below,
 * which is what drains the un-awaited ops.
 */
const CAPS: FtmsCapabilities = {
  features: null,
  powerRange: { min: 0, max: 1500, increment: 1 },
  // Tenths, on a 1.0-level grid: the range a trainer that publishes no 0x2AD6
  // falls back to, and the one whose 255-tenth wire ceiling the mapping clips to.
  resistanceRange: { min: 0, max: 1000, increment: 10 },
}

function fakeSession(calls: string[]) {
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

  return { session, failNext: (name: string, error: Error) => failures.set(name, error) }
}

/**
 * A BluetoothDevice-shaped fake. Only `gatt.disconnect` goes into the shared
 * call log (the operator disconnect must dispose the session BEFORE dropping
 * the link); the `gattserverdisconnected` listeners are held separately so a
 * test can both count them and fire them.
 */
function fakeDevice(calls: string[], options: { name?: string | null; id?: string } = {}) {
  const listeners = new Set<() => void>()
  const gatt: NonNullable<TrainerDevice["gatt"]> = {
    connected: true,
    connect: async () => gatt,
    getPrimaryService: async () => {
      throw new Error("the fake openSession never reads a GATT service")
    },
    disconnect: () => {
      gatt.connected = false
      calls.push("gatt.disconnect")
    },
  }

  const device: TrainerDevice = {
    id: options.id ?? "trainer-1",
    name: options.name === undefined ? "Kickr" : options.name,
    gatt,
    addEventListener: (_type, listener) => {
      listeners.add(listener)
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener)
    },
  }

  return {
    device,
    listenerCount: () => listeners.size,
    /** What the browser does when the link goes away on its own. */
    dropLink: () => {
      for (const listener of [...listeners]) listener()
    },
  }
}

const notPermitted = () => new FtmsControlError(FTMS_OP.SET_TARGET_POWER, FTMS_RESULT.CONTROL_NOT_PERMITTED)

/**
 * Drain every pending microtask. The plan interpreter fires the "independent"
 * ops WITHOUT awaiting them (see control-plan.ts), so the rows they write land
 * a few microtasks after the call that triggered them returns; the controller's
 * own timers are injected, so one macrotask boundary drains all of it.
 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const TWO_STEPS: ProtocolStep[] = [
  { targetWatts: 150, durationSeconds: 60 },
  { targetWatts: 200, durationSeconds: 60 },
]

/** Every field null, so a test names only the ones it cares about. */
const NO_BIKE_DATA: IndoorBikeData = {
  speedKmh: null,
  averageSpeedKmh: null,
  cadenceRpm: null,
  averageCadenceRpm: null,
  totalDistanceM: null,
  resistanceLevel: null,
  powerW: null,
  averagePowerW: null,
  heartRateBpm: null,
  elapsedS: null,
  remainingS: null,
}
const bikeData = (fields: Partial<IndoorBikeData>): IndoorBikeData => ({ ...NO_BIKE_DATA, ...fields })

interface PendingTimer {
  ms: number
  fn: () => void
}

function harness(
  options: {
    deviceName?: string | null
    deviceId?: string
    boardDeviceId?: string | null
    bluetoothAvailable?: boolean
    /** Make the first, exclusionFilters-carrying chooser call throw TypeError. */
    exclusionFiltersUnsupported?: boolean
    requestDeviceError?: unknown
  } = {},
) {
  const calls: string[] = []
  const clock = { ms: 10_000 }
  const timers = new Map<number, PendingTimer>()
  let nextTimerId = 0
  const consoleLines: string[] = []
  const capabilityDumps: unknown[] = []

  const fake = fakeSession(calls)
  const dev = fakeDevice(calls, { name: options.deviceName, id: options.deviceId })
  const opened: TrainerDevice[] = []
  const requestedOptions: RequestDeviceOptions[] = []
  let handlers: FtmsSessionHandlers | null = null

  /** One-shot openSession rejection, so a reconnect can fail after a connect succeeded. */
  let openSessionFailure: unknown

  const deps: TrainerControllerDeps = {
    openSession: async (device, sessionHandlers) => {
      if (openSessionFailure !== undefined) {
        const failure = openSessionFailure
        openSessionFailure = undefined
        throw failure
      }
      opened.push(device)
      handlers = sessionHandlers
      return fake.session
    },
    requestDevice: async (requestOptions) => {
      requestedOptions.push(requestOptions)
      if (options.requestDeviceError !== undefined) throw options.requestDeviceError
      if (options.exclusionFiltersUnsupported && "exclusionFilters" in requestOptions) {
        throw new TypeError("exclusionFilters is not a known member of RequestDeviceOptions")
      }
      return dev.device
    },
    bluetoothAvailable: () => options.bluetoothAvailable !== false,
    boardDeviceId: () => options.boardDeviceId ?? null,
    now: () => clock.ms,
    setTimer: (fn, ms) => {
      nextTimerId += 1
      timers.set(nextTimerId, { fn, ms })
      return nextTimerId
    },
    clearTimer: (handle) => {
      timers.delete(handle as number)
    },
    log: {
      log: (...args: unknown[]) => {
        consoleLines.push(String(args[0]))
        capabilityDumps.push(args[1])
      },
      warn: (...args: unknown[]) => {
        consoleLines.push(String(args[0]))
      },
      error: (...args: unknown[]) => {
        consoleLines.push(String(args[0]))
      },
    },
  }

  const controller = new TrainerController(deps)
  const rows = () => (controller.sessionLog?.events ?? []).map((event) => `${event.event}: ${event.detail}`)

  const requireHandlers = (): FtmsSessionHandlers => {
    if (!handlers) throw new Error("no session has been opened yet")
    return handlers
  }

  return {
    controller,
    calls,
    clock,
    rows,
    fake,
    dev,
    opened,
    requestedOptions,
    consoleLines,
    capabilityDumps,
    failOpenSessionOnce: (error: unknown) => {
      openSessionFailure = error
    },
    /** The ms of every armed timer, so the 150 ms debounce and the 250 ms flush are visible. */
    pendingTimers: () => [...timers.values()].map((timer) => timer.ms),
    runTimers: () => {
      const pending = [...timers.values()]
      timers.clear()
      for (const timer of pending) timer.fn()
    },
    /* The three session callbacks, as the session itself would fire them. */
    bike: (data: IndoorBikeData, atMs: number) => requireHandlers().onBikeData(data, atMs),
    status: (status: FtmsStatus) => requireHandlers().onStatus?.(status),
    controlLost: () => requireHandlers().onControlLost?.(),
  }
}

/**
 * A recording, connected controller - where most ops below start.
 *
 * Recording is started FIRST so there is a log for every row that follows: the
 * ordered row stream is what this refactor must preserve, and `logEvent` is a
 * no-op without a log.
 */
async function connected(steps: ProtocolStep[] = TWO_STEPS) {
  const h = harness()
  h.controller.startRecording()
  h.controller.setSteps(steps)
  await h.controller.connect()
  return h
}

/** What `startRecording` + `connect` write, so the assertions below start from a known prefix. */
const START_ROWS = [
  "session-start: recording started, not connected",
  "connected: Kickr",
  "control-result: Request Control -> success",
]

describe("connect", () => {
  it("opens a session, takes control and logs the connection", async () => {
    const h = await connected()
    expect(h.calls).toEqual(["requestControl"])
    expect(h.rows()).toEqual(START_ROWS)
    expect(h.opened).toEqual([h.dev.device])
    expect(h.dev.listenerCount()).toBe(1)
    const snapshot = h.controller.snapshot
    expect(snapshot.connected).toBe(true)
    expect(snapshot.connecting).toBe(false)
    expect(snapshot.hasDevice).toBe(true)
    expect(snapshot.deviceName).toBe("Kickr")
    expect(snapshot.hasControl).toBe(true)
    expect(snapshot.capabilities).toBe(CAPS)
    // One capability dump per connect, for the PR's hardware checklist.
    expect(h.consoleLines.filter((line) => line === "Trainer capabilities")).toHaveLength(1)
    expect(h.capabilityDumps[0]).toMatchObject({ powerRange: CAPS.powerRange, resistanceWireCeilingTenths: 255 })
  })

  it("asks the chooser for FTMS with our own boards excluded", async () => {
    const h = await connected()
    expect(h.requestedOptions).toHaveLength(1)
    const asked = h.requestedOptions[0] as RequestDeviceOptions & {
      filters?: unknown[]
      exclusionFilters?: unknown[]
    }
    expect(asked.filters).toEqual([{ services: ["00001826-0000-1000-8000-00805f9b34fb"] }])
    // Every service the trainer might ever be asked for, declared up front: the
    // grant Chrome makes here is the only one this device will ever have.
    expect(asked.optionalServices).toEqual([...FTMS_OPTIONAL_SERVICES])
    expect(asked.exclusionFilters).toEqual([
      { namePrefix: "Cyclowatt" },
      { namePrefix: "CRaw" },
      { namePrefix: "CycloRaw" },
    ])
  })

  it("falls back to a plain chooser when exclusionFilters is not understood", async () => {
    const h = harness({ exclusionFiltersUnsupported: true })
    h.controller.startRecording()
    await h.controller.connect()
    expect(h.requestedOptions).toHaveLength(2)
    expect("exclusionFilters" in h.requestedOptions[1]).toBe(false)
    expect(h.consoleLines).toContain("exclusionFilters unsupported here; relying on the post-pick check")
    expect(h.controller.snapshot.connected).toBe(true)
  })

  it("rejects a CycloWatt board picked by name, touching nothing", async () => {
    const h = harness({ deviceName: "Cyclowatt L A3F1 v0.6.0" })
    h.controller.startRecording()
    await h.controller.connect()
    expect(h.opened).toEqual([])
    expect(h.calls).toEqual([])
    expect(h.rows()).toEqual(["session-start: recording started, not connected"])
    expect(h.controller.snapshot.hasDevice).toBe(false)
    expect(h.controller.snapshot.connecting).toBe(false)
    expect(h.controller.snapshot.error).toBe(
      "Cyclowatt L A3F1 v0.6.0 is a CycloWatt board, not a trainer. " +
        "Pick the Kickr (or another FTMS trainer) here - a CycloWatt board connects " +
        "with the sensor connection on the Data Streaming tab.",
    )
    expect(h.consoleLines).toContain("Rejected a CycloWatt board picked as the trainer")
  })

  it("rejects the connected board by id, under a name the prefix list does not know", async () => {
    const h = harness({ deviceName: "Bench Rig", deviceId: "board-7", boardDeviceId: "board-7" })
    h.controller.startRecording()
    await h.controller.connect()
    expect(h.opened).toEqual([])
    expect(h.controller.snapshot.error).toBe(
      "Bench Rig is a CycloWatt board, not a trainer. " +
        "Pick the Kickr (or another FTMS trainer) here - a CycloWatt board connects " +
        "with the sensor connection on the Data Streaming tab.",
    )
  })

  it("surfaces a chooser failure and stops claiming to be connecting", async () => {
    const h = harness({ requestDeviceError: new Error("User cancelled the requestDevice() chooser.") })
    h.controller.startRecording()
    await h.controller.connect()
    expect(h.controller.snapshot.error).toBe(
      "Trainer connection failed: User cancelled the requestDevice() chooser.",
    )
    expect(h.controller.snapshot.connecting).toBe(false)
    expect(h.controller.snapshot.hasDevice).toBe(false)
  })

  it('names a device that publishes no name "Trainer"', async () => {
    const h = harness({ deviceName: null })
    h.controller.startRecording()
    await h.controller.connect()
    expect(h.controller.snapshot.deviceName).toBe("Trainer")
    expect(h.rows()).toContain("connected: Trainer")
  })

  it("refuses without Web Bluetooth, without opening a chooser", async () => {
    const h = harness({ bluetoothAvailable: false })
    h.controller.startRecording()
    await h.controller.connect()
    expect(h.requestedOptions).toEqual([])
    expect(h.controller.snapshot.error).toBe("Web Bluetooth API is not supported in this browser.")
    expect(h.controller.snapshot.connecting).toBe(false)
  })
})

describe("reconnect", () => {
  it("re-takes control, re-starts and re-sends a paused protocol's target", async () => {
    const h = await connected()
    await h.controller.startProtocol()
    await flush()
    h.controller.dispatchRunner({ type: "pause" })
    await flush()
    h.dev.dropLink()
    await flush()
    h.calls.length = 0

    await h.controller.reconnect()
    await flush()
    expect(h.calls).toEqual(["requestControl", "start", "setTargetPower:150"])
    // The op's own row first, then the target-set row that says what it was for.
    expect(h.rows().at(-2)).toBe("control-result: Set Target Power 150 W -> success")
    expect(h.rows().at(-1)).toBe("target-set: 150 W (re-sent after reconnect)")
    expect(h.controller.snapshot.connected).toBe(true)
    // Re-opened on the SAME device, with one listener - not a second one stacked.
    expect(h.opened).toEqual([h.dev.device, h.dev.device])
    expect(h.dev.listenerCount()).toBe(1)
  })

  it("re-sends the live manual power target instead, in manual mode", async () => {
    const h = await connected()
    h.controller.changeMode("manual-power")
    await flush()
    h.dev.dropLink()
    await flush()
    h.calls.length = 0

    await h.controller.reconnect()
    await flush()
    expect(h.calls).toEqual(["requestControl", "start", "setTargetPower:100"])
    expect(h.rows().at(-1)).toBe("target-set: 100 W (manual)")
  })

  it("re-sends the live manual resistance target, in manual-resistance mode", async () => {
    const h = await connected()
    h.controller.changeMode("manual-resistance")
    await flush()
    expect(h.controller.snapshot.manualTargetSent).toBe("resistance")
    h.dev.dropLink()
    await flush()
    h.calls.length = 0

    await h.controller.reconnect()
    await flush()
    // 20 %, the default: 51 tenths snapped onto the trainer's 1.0-level grid.
    expect(h.calls).toEqual(["requestControl", "start", "setTargetResistance:50"])
    expect(h.rows().at(-1)).toBe("target-set: 20 % -> 5 resistance level (manual)")
    expect(h.controller.snapshot.manualTargetSent).toBe("resistance")
  })

  it("surfaces a failed re-open and stops claiming to be connecting", async () => {
    const h = await connected()
    h.dev.dropLink()
    await flush()
    h.calls.length = 0

    h.failOpenSessionOnce(new Error("GATT operation failed for unknown reason."))
    await h.controller.reconnect()
    await flush()
    expect(h.controller.snapshot.error).toBe(
      "Trainer reconnect failed: GATT operation failed for unknown reason.",
    )
    expect(h.controller.snapshot.error.startsWith("Trainer reconnect failed: ")).toBe(true)
    expect(h.controller.snapshot.connecting).toBe(false)
    expect(h.controller.snapshot.connected).toBe(false)
    // Kept, so the button can be pressed again.
    expect(h.controller.snapshot.hasDevice).toBe(true)
  })

  it("does nothing without a device to re-open", async () => {
    const h = harness()
    h.controller.startRecording()
    await h.controller.reconnect()
    expect(h.opened).toEqual([])
    expect(h.calls).toEqual([])
    expect(h.controller.snapshot.connecting).toBe(false)
  })
})

describe("link lost", () => {
  it("pauses without sending, disposes the session and keeps the device", async () => {
    const h = await connected()
    await h.controller.startProtocol()
    await flush()
    h.calls.length = 0

    h.dev.dropLink()
    await flush()
    expect(h.calls).toEqual(["dispose"])
    expect(h.rows().slice(-2)).toEqual(["paused: ", "disconnected: link lost"])
    const snapshot = h.controller.snapshot
    expect(snapshot.connected).toBe(false)
    expect(snapshot.hasControl).toBe(false)
    expect(snapshot.runner.status).toBe("paused")
    // Kept, so Reconnect and Export still work.
    expect(snapshot.hasDevice).toBe(true)
    expect(snapshot.deviceName).toBe("Kickr")
    expect(snapshot.capabilities).toBe(CAPS)
    expect(snapshot.hasLog).toBe(true)
  })
})

describe("disconnect", () => {
  it("releases the trainer (Stop, Reset), disposes, then drops the link and writes the rows", async () => {
    const h = await connected()
    await h.controller.startProtocol()
    await flush()
    h.calls.length = 0

    await h.controller.disconnect()
    await flush()
    // The trainer is RELEASED before the teardown: a Kickr left in ERG keeps
    // holding the last target with no controller attached. The runner's pause
    // sends nothing (send:false) and precedes the release, so no tick can queue
    // a fresh target behind the Reset. The dispose is AWAITED before
    // gatt.disconnect, so the unsubscribe lands on a live link.
    expect(h.calls).toEqual(["stop", "reset", "dispose", "gatt.disconnect"])
    expect(h.rows().slice(-4)).toEqual([
      "paused: ",
      "control-result: Stop -> success",
      "control-result: Reset -> success",
      "disconnected: disconnected by the operator",
    ])
    const snapshot = h.controller.snapshot
    expect(snapshot.connected).toBe(false)
    expect(snapshot.hasDevice).toBe(false)
    expect(snapshot.deviceName).toBe("")
    expect(snapshot.capabilities).toBeNull()
    expect(snapshot.trainerReportedTargetW).toBeNull()
    expect(h.dev.listenerCount()).toBe(0)
    // The capture survives the disconnect - only Clear discards it.
    expect(snapshot.hasLog).toBe(true)
  })

  it("writes no paused row when nothing was running", async () => {
    const h = await connected()
    await h.controller.disconnect()
    await flush()
    expect(h.rows().slice(-1)).toEqual(["disconnected: disconnected by the operator"])
  })

  it("does not raise the control-lost alarm for its own disconnect Reset", async () => {
    const h = await connected()
    // A trainer may answer a client Reset with a control-permission-lost status;
    // fired mid-release, that is OUR doing, not "another app took it".
    const originalReset = h.fake.session.reset
    h.fake.session.reset = () => {
      h.controlLost()
      return originalReset()
    }

    await h.controller.disconnect()
    await flush()

    expect(h.controller.snapshot.error).toBe("")
    expect(h.rows().filter((row) => row.startsWith("control-lost"))).toEqual([])
  })
})

describe("bike-data notifications", () => {
  it("records the OUTGOING step's sample before the boundary tick moves the runner", async () => {
    const h = await connected()
    await h.controller.startProtocol()
    await flush()
    h.calls.length = 0

    // One second past the first step's 60 s boundary: the sample belongs to the
    // step that is ending, the tick that follows it starts the next one.
    const atMs = 10_000 + 61_000
    h.clock.ms = atMs
    h.bike(bikeData({ powerW: 210, cadenceRpm: 88, speedKmh: 31, heartRateBpm: 140 }), atMs)
    await flush()

    const log = h.controller.sessionLog
    expect(log?.samples).toHaveLength(1)
    expect(log?.samples[0]).toMatchObject({
      epochMs: atMs,
      mode: "protocol",
      // The EDITOR's name, empty here - not the runner's "Protocol" fallback.
      protocolName: "",
      stepIndex: 0,
      stepTargetW: 150,
      targetResistancePct: null,
      powerW: 210,
      cadenceRpm: 88,
      speedKmh: 31,
      hrBpm: 140,
    })
    // The tick ran after the sample, and only then sent the new step's target.
    expect(h.controller.snapshot.runner.stepIndex).toBe(1)
    expect(h.calls).toEqual(["setTargetPower:200"])
    expect(h.rows().at(-2)).toBe("step-started: step 2 target 200 W")
    expect(h.controller.snapshot.live).toMatchObject({ powerW: 210, cadenceRpm: 88, receivedAtMs: atMs })
    expect(h.controller.snapshot.sampleCount).toBe(1)
  })

  it("trims the chart trace to CHART_MAX_POINTS and publishes a NEW array each flush", async () => {
    const h = await connected()
    for (let index = 0; index <= CHART_MAX_POINTS; index += 1) {
      h.clock.ms += 1000
      h.bike(bikeData({ powerW: index }), h.clock.ms)
    }
    const data = h.controller.snapshot.chartData
    expect(data).toHaveLength(CHART_MAX_POINTS)
    // The 601st point dropped the 1st, not the other way round.
    expect(data[0].power).toBe(1)
    expect(data[CHART_MAX_POINTS - 1].power).toBe(CHART_MAX_POINTS)
    // t is seconds since the FIRST notification of the session.
    expect(data[0].t).toBe(1)
    expect(data[CHART_MAX_POINTS - 1].t).toBe(CHART_MAX_POINTS)
    expect(h.controller.snapshot.sampleCount).toBe(CHART_MAX_POINTS + 1)

    h.clock.ms += 1000
    h.bike(bikeData({ powerW: 42 }), h.clock.ms)
    // A memo'd chart compares identity: the flush must not hand back the buffer.
    expect(h.controller.snapshot.chartData).not.toBe(data)
  })

  it("throttles the display to one flush per 250 ms, keeping the burst's last value", async () => {
    const h = await connected()
    h.clock.ms += 1000
    h.bike(bikeData({ powerW: 100 }), h.clock.ms) // leading flush, published at once
    expect(h.controller.snapshot.live?.powerW).toBe(100)

    h.bike(bikeData({ powerW: 111 }), h.clock.ms)
    h.bike(bikeData({ powerW: 122 }), h.clock.ms)
    // Still the leading value, and exactly ONE deferred flush for the whole burst.
    expect(h.controller.snapshot.live?.powerW).toBe(100)
    expect(h.pendingTimers()).toEqual([250])

    h.runTimers()
    expect(h.controller.snapshot.live?.powerW).toBe(122)
  })

  it("stops appending samples once recording stops, while the display keeps moving", async () => {
    const h = await connected()
    h.clock.ms += 1000
    h.bike(bikeData({ powerW: 100 }), h.clock.ms)
    h.controller.stopRecording()
    expect(h.controller.snapshot.sampleCount).toBe(1)

    h.clock.ms += 1000
    h.bike(bikeData({ powerW: 120 }), h.clock.ms)
    expect(h.controller.sessionLog?.samples).toHaveLength(1)
    expect(h.controller.snapshot.live?.powerW).toBe(120)
  })

  it("records the resistance target only once it has actually been sent", async () => {
    const h = await connected()
    h.controller.setManualResistancePct(40)
    h.controller.changeMode("manual-resistance")
    await flush()
    h.clock.ms += 1000
    h.bike(bikeData({ powerW: 90 }), h.clock.ms)
    expect(h.controller.sessionLog?.samples[0]).toMatchObject({
      mode: "manual-resistance",
      protocolName: "",
      stepIndex: null,
      stepTargetW: null,
      targetResistancePct: 40,
    })
  })
})

describe("status notifications", () => {
  it("logs the raw status and keeps the trainer's own reported target", async () => {
    const h = await connected()
    h.status({ kind: "targetPowerChanged", watts: 200 })
    expect(h.rows().at(-1)).toBe('status: {"kind":"targetPowerChanged","watts":200}')
    expect(h.controller.snapshot.trainerReportedTargetW).toBe(200)

    h.status({ kind: "startedOrResumed" })
    expect(h.rows().at(-1)).toBe('status: {"kind":"startedOrResumed"}')
    // Unchanged: only a targetPowerChanged moves it.
    expect(h.controller.snapshot.trainerReportedTargetW).toBe(200)
  })
})

describe("control lost", () => {
  it("writes status, control-lost and paused in that order and sends nothing", async () => {
    const h = await connected()
    await h.controller.startProtocol()
    await flush()
    h.calls.length = 0
    const before = h.rows().length

    // The session fires onStatus first, then the onControlLost convenience.
    h.status({ kind: "controlPermissionLost" })
    h.controlLost()
    await flush()

    expect(h.calls).toEqual([])
    expect(h.rows().slice(before)).toEqual([
      'status: {"kind":"controlPermissionLost"}',
      "control-lost: the trainer revoked control",
      "paused: ",
    ])
    const snapshot = h.controller.snapshot
    expect(snapshot.hasControl).toBe(false)
    expect(snapshot.manualTargetSent).toBeNull()
    expect(snapshot.runner.status).toBe("paused")
    expect(snapshot.error).toBe(
      "The trainer revoked control (another app took it). Press Take Control to continue.",
    )
  })
})

describe("changeMode", () => {
  it("writes the new sub-mode's target straight away, undebounced", async () => {
    const h = await connected()
    h.calls.length = 0
    h.controller.changeMode("manual-power")
    // The mode is written synchronously, before any send: the next notification
    // must record the mode the operator just chose.
    expect(h.controller.snapshot.mode).toBe("manual-power")
    expect(h.pendingTimers()).toEqual([])
    await flush()
    expect(h.calls).toEqual(["start", "setTargetPower:100"])
    expect(h.rows().at(-1)).toBe("target-set: 100 W (manual)")
    expect(h.controller.snapshot.manualTargetSent).toBe("power")
  })

  it("is a silent no-op for the mode already selected", async () => {
    const h = await connected()
    h.calls.length = 0
    const before = h.rows().length
    h.controller.changeMode("protocol")
    await flush()
    expect(h.calls).toEqual([])
    expect(h.rows().length).toBe(before)
  })

  it("switches while disconnected without sending, and claims no target", async () => {
    const h = harness()
    h.controller.startRecording()
    h.controller.changeMode("manual-power")
    await flush()
    expect(h.calls).toEqual([])
    expect(h.controller.snapshot.mode).toBe("manual-power")
    expect(h.controller.snapshot.manualTargetSent).toBeNull()
  })

  it("drops the pending debounce belonging to the sub-mode being left", async () => {
    const h = await connected()
    h.controller.changeMode("manual-power")
    await flush()
    h.calls.length = 0

    h.controller.setManualTargetW(140)
    expect(h.pendingTimers()).toEqual([150])
    h.controller.changeMode("manual-resistance")
    expect(h.pendingTimers()).toEqual([])
    await flush()
    // 20 %, the default: 51 tenths snapped onto the trainer's 1.0-level grid.
    expect(h.calls).toEqual(["setTargetResistance:50"])
    expect(h.rows().at(-1)).toBe("target-set: 20 % -> 5 resistance level (manual)")
    expect(h.controller.snapshot.manualTargetSent).toBe("resistance")
  })
})

describe("manual targets", () => {
  it("coalesces a burst of manual power edits into one write", async () => {
    const h = await connected()
    h.controller.changeMode("manual-power")
    await flush()
    h.calls.length = 0

    h.controller.setManualTargetW(120)
    h.controller.setManualTargetW(130)
    h.controller.setManualTargetW(140)
    // One shared, re-armed timer - not one per edit.
    expect(h.pendingTimers()).toEqual([150])
    expect(h.calls).toEqual([])

    h.runTimers()
    await flush()
    expect(h.calls).toEqual(["setTargetPower:140"])
    expect(h.rows().at(-1)).toBe("target-set: 140 W (manual)")
    expect(h.controller.snapshot.manualTargetW).toBe(140)
  })

  it("maps a resistance percentage onto the trainer's own grid", async () => {
    const h = await connected()
    h.controller.changeMode("manual-resistance")
    await flush()
    h.calls.length = 0

    h.controller.setManualResistancePct(100)
    h.runTimers()
    await flush()
    // 255, not 250: the published max is 1000 tenths but the wire carries one
    // uint8, so resistanceTenthsFromPct clips the ceiling (task-1-report.md's
    // "Concerns" - the briefs say 250, the preserved panel behaviour is 255).
    expect(h.calls).toEqual(["setTargetResistance:255"])
    expect(h.rows().at(-1)).toBe("target-set: 100 % -> 25.5 resistance level (manual)")
    expect(h.controller.snapshot.manualResistancePct).toBe(100)
  })

  it("holds an edit made in another mode, or while disconnected, without sending", async () => {
    const h = await connected() // protocol mode
    h.calls.length = 0
    h.controller.setManualTargetW(200)
    h.controller.setManualResistancePct(50)
    expect(h.pendingTimers()).toEqual([])
    expect(h.calls).toEqual([])
    expect(h.controller.snapshot.manualTargetW).toBe(200)
    expect(h.controller.snapshot.manualResistancePct).toBe(50)
  })
})

describe("takeControl", () => {
  it("sends Request Control and logs its result", async () => {
    const h = await connected()
    h.calls.length = 0
    await h.controller.takeControl()
    expect(h.calls).toEqual(["requestControl"])
    expect(h.controller.snapshot.hasControl).toBe(true)
    expect(h.rows().slice(START_ROWS.length)).toEqual(["control-result: Request Control -> success"])
  })

  it("is a silent no-op with no session - no write attempted, so no row about one", async () => {
    const h = harness()
    h.controller.startRecording()
    await h.controller.takeControl()
    expect(h.calls).toEqual([])
    expect(h.rows()).toEqual(["session-start: recording started, not connected"])
    expect(h.controller.snapshot.hasControl).toBe(false)
  })

  it("still sends when there is no log to write rows into", async () => {
    const h = await connected()
    h.controller.clearRecording()
    h.calls.length = 0
    await h.controller.takeControl()
    expect(h.calls).toEqual(["requestControl"])
    expect(h.rows()).toEqual([])
  })
})

describe("startProtocol", () => {
  it("starts the trainer and sends the first step target", async () => {
    const h = await connected()
    await h.controller.startProtocol()
    await flush()

    expect(h.calls).toEqual(["requestControl", "start", "setTargetPower:150"])
    expect(h.rows()).toEqual([
      ...START_ROWS,
      "control-result: Start or Resume -> success",
      "step-started: step 1 target 150 W",
      "control-result: Set Target Power 150 W -> success",
    ])
    expect(h.controller.snapshot.runner.status).toBe("running")
    expect(h.controller.snapshot.starting).toBe(false)
    // The runner shares the edited steps array by reference, as createRunner always has.
    expect(h.controller.snapshot.runner.protocol.steps).toBe(h.controller.snapshot.steps)
    expect(h.controller.snapshot.runner.protocol.name).toBe("Protocol")
  })

  it("names the protocol from the trimmed editor name", async () => {
    const h = await connected()
    h.controller.setProtocolName("  Ramp  ")
    await h.controller.startProtocol()
    await flush()
    expect(h.controller.snapshot.runner.protocol.name).toBe("Ramp")
  })

  it("refuses invalid steps with an error and no write", async () => {
    const h = await connected([])
    h.calls.length = 0
    await h.controller.startProtocol()
    await flush()
    expect(h.calls).toEqual([])
    expect(h.rows().slice(START_ROWS.length)).toEqual([])
    expect(h.controller.snapshot.error).toBe("Cannot start the protocol: add at least one step.")
    expect(h.controller.snapshot.runner.status).toBe("idle")
  })

  it("holds the door against a second click while the first is still awaiting", async () => {
    const h = await connected()
    h.calls.length = 0
    const first = h.controller.startProtocol()
    const second = h.controller.startProtocol()
    await Promise.all([first, second])
    await flush()
    // One runner, one 0x07, one target: the synchronous guard saw the second click.
    expect(h.calls).toEqual(["start", "setTargetPower:150"])
  })
})

describe("pause, resume, skip and stop", () => {
  async function running() {
    const h = await connected()
    await h.controller.startProtocol()
    await flush()
    h.calls.length = 0
    return h
  }

  it("pauses with one 0x08 and clears started, so Resume sends 0x07 again", async () => {
    const h = await running()
    h.controller.dispatchRunner({ type: "pause" })
    await flush()
    expect(h.calls).toEqual(["pause"])
    expect(h.rows().at(-2)).toBe("paused: ")
    expect(h.rows().at(-1)).toBe("control-result: Pause -> success")

    h.calls.length = 0
    await h.controller.resumeProtocol()
    await flush()
    expect(h.calls).toEqual(["start", "setTargetPower:150"])
    expect(h.rows().slice(-3)).toEqual([
      "control-result: Start or Resume -> success",
      "resumed: target 150 W",
      "control-result: Set Target Power 150 W -> success",
    ])
  })

  it("skips while paused with a row and NO write - the trainer holds no target to change", async () => {
    const h = await running()
    h.controller.dispatchRunner({ type: "pause" })
    await flush()
    h.calls.length = 0

    h.controller.dispatchRunner({ type: "skip" })
    await flush()
    expect(h.calls).toEqual([])
    expect(h.rows().at(-1)).toBe("step-started: step 2 target 200 W")
  })

  it("finishes a skip past the last step with 0x07 and the 50 W end target, leaving it started", async () => {
    const h = await running()
    h.controller.dispatchRunner({ type: "pause" })
    await flush()
    h.calls.length = 0

    h.controller.dispatchRunner({ type: "skip" }) // onto step 2, no write while paused
    h.controller.dispatchRunner({ type: "skip" }) // past the last step: finished
    await flush()
    // No 0x08: finishing is not stopping, so the 0x07 the pause undid comes back
    // and the protocol-end target lands on a started trainer.
    expect(h.calls).toEqual(["start", "setTargetPower:50"])
    expect(h.controller.snapshot.runner.status).toBe("finished")

    // `started` is private, so it is observed the only way it is ever observable:
    // the next op that would need 0x07 does not send one.
    h.calls.length = 0
    h.controller.changeMode("manual-power")
    await flush()
    expect(h.calls).toEqual(["setTargetPower:100"])
  })

  it("stops from paused with 0x07, the 50 W protocol-end target and then 0x08", async () => {
    const h = await running()
    h.controller.dispatchRunner({ type: "pause" })
    await flush()
    h.calls.length = 0

    h.controller.dispatchRunner({ type: "stop" })
    await flush()
    expect(h.calls).toEqual(["start", "setTargetPower:50", "stop"])
    expect(h.rows().slice(-4)).toEqual([
      "stopped: ",
      "control-result: Start or Resume (for the protocol-end target) -> success",
      "control-result: Set Target Power 50 W (protocol end) -> success",
      "control-result: Stop -> success",
    ])
    expect(h.controller.snapshot.runner.status).toBe("stopped")
  })

  it("ignores an action the runner refuses, without a row or a write", async () => {
    const h = await running()
    const before = h.rows().length
    h.controller.dispatchRunner({ type: "resume" }) // already running
    await flush()
    expect(h.calls).toEqual([])
    expect(h.rows().length).toBe(before)
  })
})

describe("tick", () => {
  it("sends only the LAST step of a late catch-up tick", async () => {
    const h = await connected([
      { targetWatts: 150, durationSeconds: 60 },
      { targetWatts: 200, durationSeconds: 60 },
      { targetWatts: 250, durationSeconds: 60 },
    ])
    await h.controller.startProtocol()
    await flush()
    h.calls.length = 0

    h.controller.tick(10_000 + 130_000)
    await flush()
    expect(h.calls).toEqual(["setTargetPower:250"])
    expect(h.rows().slice(-3)).toEqual([
      "step-started: step 2 target 200 W",
      "step-started: step 3 target 250 W",
      "control-result: Set Target Power 250 W -> success",
    ])
  })

  it("does nothing at all when no boundary has been crossed", async () => {
    const h = await connected()
    await h.controller.startProtocol()
    await flush()
    const before = h.rows().length
    h.calls.length = 0

    h.controller.tick(10_500)
    await flush()
    expect(h.calls).toEqual([])
    expect(h.rows().length).toBe(before)
  })
})

describe("sendControl", () => {
  it("re-takes control and re-starts after CONTROL_NOT_PERMITTED", async () => {
    const h = await connected()
    h.calls.length = 0
    h.fake.failNext("setTargetPower:150", notPermitted())
    await h.controller.startProtocol()
    await flush()

    // The 0x07 is ensureStarted's; the tail is the retry - the refused target, a
    // fresh 0x00, 0x07 again, then the target.
    expect(h.calls).toEqual(["start", "setTargetPower:150", "requestControl", "start", "setTargetPower:150"])
    expect(h.rows().at(-1)).toBe(
      "control-result: Set Target Power 150 W -> success after re-taking control and re-starting",
    )
    expect(h.controller.snapshot.hasControl).toBe(true)
  })

  it("re-takes control WITHOUT re-starting for a Pause", async () => {
    const h = await connected()
    await h.controller.startProtocol()
    await flush()
    h.calls.length = 0

    h.fake.failNext("pause", notPermitted())
    h.controller.dispatchRunner({ type: "pause" })
    await flush()
    expect(h.calls).toEqual(["pause", "requestControl", "pause"])
    expect(h.rows().at(-1)).toBe("control-result: Pause -> success after re-taking control")
  })

  it("swallows an ordinary failure, logging and surfacing it", async () => {
    const h = await connected()
    await h.controller.startProtocol()
    await flush()
    h.calls.length = 0

    h.fake.failNext("pause", new Error("boom"))
    h.controller.dispatchRunner({ type: "pause" })
    await flush()
    expect(h.calls).toEqual(["pause"])
    expect(h.rows().at(-1)).toBe("control-result: Pause -> failed: boom")
    expect(h.controller.snapshot.error).toBe("Pause failed: boom")
    // The runner still moved: a target that did not land must not strand the rider.
    expect(h.controller.snapshot.runner.status).toBe("paused")
  })
})

describe("recording", () => {
  it("opens a log naming the connected trainer", async () => {
    const h = harness()
    await h.controller.connect()
    h.controller.startRecording()
    expect(h.rows()).toEqual(["session-start: recording started, Kickr connected"])
    const snapshot = h.controller.snapshot
    expect(snapshot.recording).toBe(true)
    expect(snapshot.hasLog).toBe(true)
    expect(snapshot.sampleCount).toBe(0)
    expect(snapshot.logStartedAtMs).toBe(10_000)
  })

  it("says so when recording starts with no trainer connected", () => {
    const h = harness()
    h.controller.startRecording()
    expect(h.rows()).toEqual(["session-start: recording started, not connected"])
  })

  it("freezes the count on stop and drops the log on clear", async () => {
    const h = await connected()
    h.clock.ms += 1000
    h.bike(bikeData({ powerW: 100 }), h.clock.ms)

    h.controller.stopRecording()
    expect(h.controller.snapshot.recording).toBe(false)
    expect(h.controller.snapshot.sampleCount).toBe(1)

    h.controller.clearRecording()
    expect(h.controller.snapshot.hasLog).toBe(false)
    expect(h.controller.snapshot.sampleCount).toBe(0)
    expect(h.controller.snapshot.logStartedAtMs).toBeNull()
  })
})

describe("csvForExport", () => {
  it("exports an event-only log, and is null only when no log exists", async () => {
    const h = await connected()
    // A capture with rows but no samples (recording started while disconnected,
    // a run with no notifications) is still an unreproducible capture: it must
    // be exportable, not silently unreachable behind a samples-only gate.
    expect(h.controller.csvForExport()?.csv).toBe(sessionLogToCsv(h.controller.sessionLog!))
    h.controller.clearRecording()
    expect(h.controller.csvForExport()).toBeNull() // no log at all
  })

  it("hands back the whole CSV and a filename stamped with the protocol", async () => {
    const h = await connected()
    h.controller.setProtocolName("Ramp")
    h.clock.ms += 1000
    h.bike(bikeData({ powerW: 100 }), h.clock.ms)

    const exported = h.controller.csvForExport()
    expect(exported?.csv).toBe(sessionLogToCsv(h.controller.sessionLog!))
    expect(exported?.filename).toBe(sessionLogFilename("Ramp", 10_000))
  })

  it("leaves the protocol name off a manual capture", async () => {
    const h = await connected()
    h.controller.setProtocolName("Ramp")
    h.controller.changeMode("manual-power")
    await flush()
    h.clock.ms += 1000
    h.bike(bikeData({ powerW: 100 }), h.clock.ms)
    expect(h.controller.csvForExport()?.filename).toBe(sessionLogFilename("", 10_000))
  })
})

describe("dispose", () => {
  it("detaches the drop listener, disposes the session and cancels both timers", async () => {
    const h = await connected()
    h.controller.changeMode("manual-power")
    await flush()
    h.calls.length = 0

    h.controller.setManualTargetW(175) // arms the 150 ms debounce
    h.clock.ms += 1000
    h.bike(bikeData({ powerW: 100 }), h.clock.ms) // leading flush
    h.bike(bikeData({ powerW: 111 }), h.clock.ms) // arms the 250 ms deferred flush
    expect(h.pendingTimers().sort((a, b) => a - b)).toEqual([150, 250])
    const before = h.rows().length
    const published = h.controller.snapshot.live

    h.controller.dispose()
    await flush()

    expect(h.pendingTimers()).toEqual([])
    expect(h.dev.listenerCount()).toBe(0)
    // The same Stop + Reset release as disconnect(), best-effort and BEFORE the
    // dispose (which would reject anything still queued): an unmounted panel
    // holds no way to ever change the target again.
    expect(h.calls).toEqual(["stop", "reset", "dispose"])
    // Unmount writes no row: the release goes through the session directly, not
    // through sendControl, so no control-result rows land in a kept log.
    expect(h.rows().length).toBe(before)
    expect(h.controller.snapshot.live).toBe(published)
  })
})

describe("snapshot and subscribe", () => {
  it("rebuilds a NEW snapshot object on every change and never mutates the old one", async () => {
    const h = await connected()
    const first = h.controller.snapshot
    await h.controller.startProtocol()
    await flush()
    expect(h.controller.snapshot).not.toBe(first)
    expect(first.runner.status).toBe("idle") // the old object still describes the old state
  })

  it("stops calling a listener once it unsubscribes", async () => {
    const h = await connected()
    let calls = 0
    const unsubscribe = h.controller.subscribe(() => {
      calls += 1
    })
    h.controller.setProtocolName("a")
    const afterFirst = calls
    unsubscribe()
    h.controller.setProtocolName("b")
    expect(afterFirst).toBeGreaterThan(0)
    expect(calls).toBe(afterFirst)
  })
})
