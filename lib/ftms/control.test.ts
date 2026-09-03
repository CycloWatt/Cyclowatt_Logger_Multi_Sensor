import { afterEach, describe, expect, it, vi } from "vitest"
import {
  FTMS_CONTROL_POINT_CHAR_UUID,
  FTMS_FEATURE_CHAR_UUID,
  FTMS_INDOOR_BIKE_DATA_CHAR_UUID,
  FTMS_MACHINE_STATUS_CHAR_UUID,
  FTMS_SERVICE_UUID,
  FTMS_SUPPORTED_POWER_RANGE_CHAR_UUID,
  FTMS_SUPPORTED_RESISTANCE_RANGE_CHAR_UUID,
} from "./protocol"
import {
  FTMS_CONTROL_TIMEOUT_MS,
  FtmsControlError,
  openFtmsSession,
  type FtmsCharacteristic,
  type FtmsServer,
  type FtmsService,
  type FtmsSessionHandlers,
} from "./control"

const view = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer)

/** Feature: cadence (bit 1) + power measurement (bit 14), resistance + power targets (bits 2, 3). */
const FEATURE = view(0x02, 0x40, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x00)
/** Supported Power Range 0..1500 W in 1 W steps. */
const POWER_RANGE = view(0x00, 0x00, 0xdc, 0x05, 0x01, 0x00)

/** An Indoor Bike Data frame with speed 30.00 km/h, cadence 90 rpm, power 250 W. */
const BIKE_FRAME = view(0x44, 0x00, 0xb8, 0x0b, 0xb4, 0x00, 0xfa, 0x00)

/**
 * How the fake control point answers a write. Mutable so a test can change the
 * trainer's behaviour mid-session - the point of several tests below is that the
 * session survives a refusal or a timeout and still drives the NEXT op.
 */
interface CpBehaviour {
  /** Answer every write synchronously with success (the worst case for listener ordering). */
  auto: boolean
  /** When set, writeValueWithResponse rejects with it - how ATT errors reach the page. */
  writeError: Error | null
}

interface FakeCharOptions {
  readValue?: () => Promise<DataView>
  startError?: Error
  stopError?: Error
  onWrite?: (bytes: number[], fire: (value: DataView) => void) => void
}

/**
 * One fake characteristic that logs every call into the shared, ordered `calls`
 * array under its own name. The ORDER across characteristics is a behaviour
 * under test, not a detail, which is why there is one log and not one per fake.
 */
function fakeCharacteristic(name: string, calls: string[], options: FakeCharOptions = {}) {
  const listeners: Array<(event: Event) => void> = []
  const written: number[][] = []

  const fire = (value: DataView) => {
    // Web Bluetooth delivers the payload as event.target.value.
    const event = { target: { value } } as unknown as Event
    for (const listener of [...listeners]) listener(event)
  }

  const characteristic: FtmsCharacteristic = {
    readValue: async () => {
      calls.push(`${name}:readValue`)
      return options.readValue ? options.readValue() : view()
    },
    startNotifications: async () => {
      calls.push(`${name}:startNotifications`)
      if (options.startError) throw options.startError
    },
    stopNotifications: async () => {
      calls.push(`${name}:stopNotifications`)
      if (options.stopError) throw options.stopError
    },
    addEventListener: (_type: string, listener: (event: Event) => void) => {
      calls.push(`${name}:addEventListener`)
      listeners.push(listener)
    },
    removeEventListener: (_type: string, listener: (event: Event) => void) => {
      calls.push(`${name}:removeEventListener`)
      const at = listeners.indexOf(listener)
      if (at >= 0) listeners.splice(at, 1)
    },
    writeValueWithResponse: async (value: BufferSource) => {
      calls.push(`${name}:write`)
      const bytes = Array.from(new Uint8Array(value as ArrayBuffer))
      written.push(bytes)
      options.onWrite?.(bytes, fire)
    },
  }

  return { characteristic, listeners, written, fire }
}

interface FakeDeviceOptions {
  /** Override the Feature read; throw from it to exercise the "unknown features" path. */
  feature?: () => Promise<DataView>
  powerRange?: () => Promise<DataView>
  resistanceRange?: () => Promise<DataView>
  /** Reject getCharacteristic for these UUIDs (a trainer that omits an optional one). */
  missing?: string[]
  auto?: boolean
  statusStopError?: Error
  /** Fail the LAST stream to be enabled, so the session is half-attached. */
  bikeStartError?: Error
}

function fakeDevice(options: FakeDeviceOptions = {}) {
  const calls: string[] = []
  const behaviour: CpBehaviour = { auto: options.auto ?? true, writeError: null }

  const cp = fakeCharacteristic("cp", calls, {
    onWrite: (bytes, fire) => {
      if (behaviour.writeError) throw behaviour.writeError
      if (behaviour.auto) fire(view(0x80, bytes[0], 0x01))
    },
  })
  const status = fakeCharacteristic("status", calls, { stopError: options.statusStopError })
  const bike = fakeCharacteristic("bike", calls, { startError: options.bikeStartError })
  const feature = fakeCharacteristic("feature", calls, {
    readValue: options.feature ?? (async () => FEATURE),
  })
  const powerRange = fakeCharacteristic("powerRange", calls, {
    readValue: options.powerRange ?? (async () => POWER_RANGE),
  })
  const resistanceRange = fakeCharacteristic("resistanceRange", calls, {
    // Rejects by default, so capabilities fall back to DEFAULT_RESISTANCE_RANGE.
    readValue: options.resistanceRange ?? (async () => Promise.reject(new Error("no resistance range"))),
  })

  const byUuid: Record<string, FtmsCharacteristic> = {
    [FTMS_CONTROL_POINT_CHAR_UUID]: cp.characteristic,
    [FTMS_MACHINE_STATUS_CHAR_UUID]: status.characteristic,
    [FTMS_INDOOR_BIKE_DATA_CHAR_UUID]: bike.characteristic,
    [FTMS_FEATURE_CHAR_UUID]: feature.characteristic,
    [FTMS_SUPPORTED_POWER_RANGE_CHAR_UUID]: powerRange.characteristic,
    [FTMS_SUPPORTED_RESISTANCE_RANGE_CHAR_UUID]: resistanceRange.characteristic,
  }

  const requested: string[] = []
  const service: FtmsService = {
    getCharacteristic: async (uuid: string) => {
      requested.push(uuid)
      if (options.missing?.includes(uuid)) throw new Error(`no characteristic ${uuid}`)
      const found = byUuid[uuid]
      if (!found) throw new Error(`unexpected characteristic ${uuid}`)
      return found
    },
  }

  let connects = 0
  const server: FtmsServer = {
    connected: true,
    connect: async () => {
      connects += 1
      return server
    },
    getPrimaryService: async (uuid: string) => {
      requested.push(uuid)
      return service
    },
  }

  return {
    device: { gatt: server },
    server,
    calls,
    requested,
    behaviour,
    cp,
    status,
    bike,
    written: cp.written,
    connectCount: () => connects,
  }
}

function fakeHandlers() {
  const handlers = {
    onBikeData: vi.fn(),
    onStatus: vi.fn(),
    onControlLost: vi.fn(),
  }
  return handlers satisfies FtmsSessionHandlers
}

/** Let the op chain dispatch its next queued run without leaning on a real timer. */
const flush = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("openFtmsSession", () => {
  it("rejects a device with no GATT interface", async () => {
    await expect(openFtmsSession(null, fakeHandlers())).rejects.toThrow(/GATT/i)
    await expect(openFtmsSession({ gatt: null }, fakeHandlers())).rejects.toThrow(/GATT/i)
  })

  it("connects first when the link is down", async () => {
    const fake = fakeDevice()
    fake.server.connected = false
    await openFtmsSession(fake.device, fakeHandlers())
    expect(fake.connectCount()).toBe(1)
  })

  it("asks for the FTMS service and all six characteristics", async () => {
    const fake = fakeDevice()
    await openFtmsSession(fake.device, fakeHandlers())
    expect(fake.requested).toContain(FTMS_SERVICE_UUID)
    expect(fake.requested).toContain(FTMS_FEATURE_CHAR_UUID)
    expect(fake.requested).toContain(FTMS_SUPPORTED_POWER_RANGE_CHAR_UUID)
    expect(fake.requested).toContain(FTMS_SUPPORTED_RESISTANCE_RANGE_CHAR_UUID)
    expect(fake.requested).toContain(FTMS_CONTROL_POINT_CHAR_UUID)
    expect(fake.requested).toContain(FTMS_MACHINE_STATUS_CHAR_UUID)
    expect(fake.requested).toContain(FTMS_INDOOR_BIKE_DATA_CHAR_UUID)
  })

  it("attaches the control-point listener before enabling indications, and both before any write", async () => {
    // The ordering hazard this module exists to get right: the trainer rejects a
    // control-point write with ATT 0xFD unless indications are already on, and a
    // fast answer can arrive before writeValueWithResponse resolves.
    const fake = fakeDevice()
    const session = await openFtmsSession(fake.device, fakeHandlers())
    await session.requestControl()

    const { calls } = fake
    expect(calls.indexOf("cp:addEventListener")).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf("cp:addEventListener")).toBeLessThan(calls.indexOf("cp:startNotifications"))
    expect(calls.indexOf("cp:startNotifications")).toBeLessThan(calls.indexOf("cp:write"))
    expect(calls.indexOf("cp:addEventListener")).toBeLessThan(calls.indexOf("cp:write"))
  })

  it("enables control-point indications before the status and bike-data streams", async () => {
    // Any notification enabled first would delay the one characteristic a write
    // depends on, and the panel writes as soon as the session resolves.
    const fake = fakeDevice()
    await openFtmsSession(fake.device, fakeHandlers())
    const { calls } = fake
    expect(calls.indexOf("cp:startNotifications")).toBeLessThan(calls.indexOf("status:startNotifications"))
    expect(calls.indexOf("cp:startNotifications")).toBeLessThan(calls.indexOf("bike:startNotifications"))
    expect(calls.indexOf("status:addEventListener")).toBeLessThan(calls.indexOf("status:startNotifications"))
    expect(calls.indexOf("bike:addEventListener")).toBeLessThan(calls.indexOf("bike:startNotifications"))
  })

  it("reads the feature and range characteristics before any write", async () => {
    const fake = fakeDevice()
    const session = await openFtmsSession(fake.device, fakeHandlers())
    await session.requestControl()
    expect(fake.calls.indexOf("feature:readValue")).toBeLessThan(fake.calls.indexOf("cp:write"))
    expect(fake.calls.indexOf("powerRange:readValue")).toBeLessThan(fake.calls.indexOf("cp:write"))
  })

  it("parses the declared features and power range into capabilities", async () => {
    const fake = fakeDevice()
    const session = await openFtmsSession(fake.device, fakeHandlers())
    expect(session.capabilities.features).toMatchObject({
      cadenceSupported: true,
      powerMeasurementSupported: true,
      resistanceTargetSupported: true,
      powerTargetSupported: true,
    })
    expect(session.capabilities.powerRange).toEqual({ min: 0, max: 1500, increment: 1 })
  })

  it("opens with unknown features and default ranges when the reads fail", async () => {
    // A trainer that will not report its capabilities is still drivable; refusing
    // to open would strand the bench over an optional read.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const fake = fakeDevice({
      feature: async () => Promise.reject(new Error("feature read failed")),
      missing: [FTMS_SUPPORTED_POWER_RANGE_CHAR_UUID],
    })
    const session = await openFtmsSession(fake.device, fakeHandlers())
    expect(session.capabilities.features).toBeNull()
    expect(session.capabilities.powerRange).toEqual({ min: 0, max: 2000, increment: 1 })
    expect(session.capabilities.resistanceRange).toEqual({ min: 0, max: 1000, increment: 10 })
    expect(warn).toHaveBeenCalled()
  })

  it("opens with unknown features when the Feature payload is too short to parse", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const fake = fakeDevice({ feature: async () => view(0x01, 0x02) })
    const session = await openFtmsSession(fake.device, fakeHandlers())
    expect(session.capabilities.features).toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it("defaults the control-point timeout to something sub-second answers never hit", async () => {
    expect(FTMS_CONTROL_TIMEOUT_MS).toBe(5000)
  })

  it("leaves no listener behind when subscribing fails half-way", async () => {
    // Nobody would hold a reference to the half-open session, so nothing else
    // could ever detach the listeners it already attached.
    const fake = fakeDevice({ bikeStartError: new Error("notifications unsupported") })
    await expect(openFtmsSession(fake.device, fakeHandlers())).rejects.toThrow(/notifications unsupported/)
    expect(fake.cp.listeners).toHaveLength(0)
    expect(fake.status.listeners).toHaveLength(0)
    expect(fake.bike.listeners).toHaveLength(0)
  })

  it("does not attach a second copy of every listener when attach is repeated", async () => {
    const fake = fakeDevice()
    const session = await openFtmsSession(fake.device, fakeHandlers())
    await session.attach()
    expect(fake.cp.listeners).toHaveLength(1)
    expect(fake.status.listeners).toHaveLength(1)
    expect(fake.bike.listeners).toHaveLength(1)
  })
})

describe("FtmsSession control-point ops", () => {
  it("writes the documented bytes for every op", async () => {
    const fake = fakeDevice()
    const session = await openFtmsSession(fake.device, fakeHandlers())

    await session.requestControl()
    await session.reset()
    await session.start()
    await session.stop()
    await session.pause()

    expect(fake.written).toEqual([[0x00], [0x01], [0x07], [0x08, 0x01], [0x08, 0x02]])
  })

  it("writes Set Target Power little-endian and resolves on the matching answer", async () => {
    const fake = fakeDevice({ auto: false })
    const session = await openFtmsSession(fake.device, fakeHandlers())

    const pending = session.setTargetPower(250)
    await flush()
    expect(fake.written).toEqual([[0x05, 0xfa, 0x00]])

    // A stray answer to a DIFFERENT opcode must not settle this op.
    fake.cp.fire(view(0x80, 0x07, 0x01))
    await flush()
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await flush()
    expect(settled).toBe(false)

    fake.cp.fire(view(0x80, 0x05, 0x01))
    await expect(pending).resolves.toBeUndefined()
  })

  it("ignores an unparseable indication and keeps waiting", async () => {
    const fake = fakeDevice({ auto: false })
    const session = await openFtmsSession(fake.device, fakeHandlers())
    const pending = session.start()
    await flush()

    fake.cp.fire(view(0x99)) // not a Response Code payload at all
    await flush()

    fake.cp.fire(view(0x80, 0x07, 0x01))
    await expect(pending).resolves.toBeUndefined()
  })

  it("rejects with the result code named, and exposes the raw codes", async () => {
    const fake = fakeDevice({ auto: false })
    const session = await openFtmsSession(fake.device, fakeHandlers())

    const pending = session.setTargetPower(250)
    await flush()
    fake.cp.fire(view(0x80, 0x05, 0x05))

    const error = await pending.then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(FtmsControlError)
    expect((error as Error).message).toMatch(/control not permitted/i)
    expect((error as FtmsControlError).resultCode).toBe(5)
    expect((error as FtmsControlError).opcode).toBe(5)
  })

  it("times out when nothing answers, and stays usable afterwards", async () => {
    vi.useFakeTimers()
    const fake = fakeDevice({ auto: false })
    const session = await openFtmsSession(fake.device, fakeHandlers(), { timeoutMs: 1000 })

    const pending = session.setTargetPower(200)
    const asserted = expect(pending).rejects.toThrow(/did not answer/i)
    await vi.advanceTimersByTimeAsync(1000)
    await asserted

    // The session is not poisoned: the next op writes and completes.
    fake.behaviour.auto = true
    await expect(session.start()).resolves.toBeUndefined()
    expect(fake.written).toEqual([[0x05, 0xc8, 0x00], [0x07]])
  })

  it("keeps only one op outstanding, and writes the next only once the first is answered", async () => {
    // The trainer answers ATT 0xFE "procedure already in progress" to a second
    // concurrent write, so the queue is what makes back-to-back panel clicks work.
    const fake = fakeDevice({ auto: false })
    const session = await openFtmsSession(fake.device, fakeHandlers())

    const first = session.requestControl()
    const second = session.start()
    await flush()
    expect(fake.written).toEqual([[0x00]])

    fake.cp.fire(view(0x80, 0x00, 0x01))
    await expect(first).resolves.toBeUndefined()
    await flush()
    expect(fake.written).toEqual([[0x00], [0x07]])

    fake.cp.fire(view(0x80, 0x07, 0x01))
    await expect(second).resolves.toBeUndefined()
  })

  it("does not let a refused op block the next one", async () => {
    const fake = fakeDevice({ auto: false })
    const session = await openFtmsSession(fake.device, fakeHandlers())

    const first = session.requestControl()
    const second = session.start()
    await flush()
    fake.cp.fire(view(0x80, 0x00, 0x05))
    await expect(first).rejects.toThrow(/control not permitted/i)
    await flush()
    expect(fake.written).toEqual([[0x00], [0x07]])

    fake.cp.fire(view(0x80, 0x07, 0x01))
    await expect(second).resolves.toBeUndefined()
  })

  it("rejects the op whose write fails, and still runs the next", async () => {
    // 0xFD (CCC improperly configured) and 0xFE (procedure in progress) both
    // reach the page as a rejected write.
    const fake = fakeDevice()
    const session = await openFtmsSession(fake.device, fakeHandlers())

    fake.behaviour.writeError = new DOMException("GATT operation failed for unknown reason.", "NetworkError")
    await expect(session.requestControl()).rejects.toThrow(/GATT operation failed/)

    fake.behaviour.writeError = null
    await expect(session.start()).resolves.toBeUndefined()
    expect(fake.written).toEqual([[0x00], [0x07]])
  })

  it("clamps a target power onto the trainer's published range before encoding", async () => {
    const fake = fakeDevice()
    const session = await openFtmsSession(fake.device, fakeHandlers())
    await session.setTargetPower(5000)
    expect(fake.written).toEqual([[0x05, 0xdc, 0x05]]) // 1500 W, the published max
  })

  it("snaps a target resistance onto the range increment", async () => {
    const fake = fakeDevice({ resistanceRange: async () => view(0x00, 0x00, 0xc8, 0x00, 0x0a, 0x00) })
    const session = await openFtmsSession(fake.device, fakeHandlers())
    await session.setTargetResistance(123)
    expect(fake.written).toEqual([[0x04, 0x78]]) // 120 tenths
  })

  it("rejects a target resistance the uint8 on the wire cannot carry, without writing", async () => {
    // The Supported Resistance Level Range is int16 but Set Target Resistance
    // Level carries one uint8; a silent wrap would set a random resistance.
    const fake = fakeDevice()
    const session = await openFtmsSession(fake.device, fakeHandlers())
    await expect(session.setTargetResistance(3000)).rejects.toThrow(/255/)
    expect(fake.written).toEqual([])
  })
})

describe("FtmsSession notifications", () => {
  it("reports parsed bike data stamped with the injected clock", async () => {
    const fake = fakeDevice()
    const handlers = fakeHandlers()
    await openFtmsSession(fake.device, handlers, { now: () => 1234 })

    fake.bike.fire(BIKE_FRAME)

    expect(handlers.onBikeData).toHaveBeenCalledTimes(1)
    const [data, receivedAtMs] = handlers.onBikeData.mock.calls[0]
    expect(data).toMatchObject({ speedKmh: 30, cadenceRpm: 90, powerW: 250 })
    expect(receivedAtMs).toBe(1234)
  })

  it("skips a truncated bike-data frame instead of tearing down the stream", async () => {
    const fake = fakeDevice()
    const handlers = fakeHandlers()
    await openFtmsSession(fake.device, handlers)

    fake.bike.fire(view(0x44, 0x00, 0xb8)) // flags claim three fields, payload has one byte
    expect(handlers.onBikeData).not.toHaveBeenCalled()

    fake.bike.fire(BIKE_FRAME)
    expect(handlers.onBikeData).toHaveBeenCalledTimes(1)
  })

  it("reports machine status and fires the control-lost convenience handler", async () => {
    const fake = fakeDevice()
    const handlers = fakeHandlers()
    await openFtmsSession(fake.device, handlers)

    fake.status.fire(view(0xff))
    expect(handlers.onStatus).toHaveBeenCalledWith({ kind: "controlPermissionLost" })
    expect(handlers.onControlLost).toHaveBeenCalledTimes(1)

    fake.status.fire(view(0x04))
    expect(handlers.onStatus).toHaveBeenCalledWith({ kind: "startedOrResumed" })
    expect(handlers.onControlLost).toHaveBeenCalledTimes(1)
  })

  it("skips an empty status notification", async () => {
    const fake = fakeDevice()
    const handlers = fakeHandlers()
    await openFtmsSession(fake.device, handlers)
    fake.status.fire(view())
    expect(handlers.onStatus).not.toHaveBeenCalled()
  })

  it("works with only the required handler supplied", async () => {
    const fake = fakeDevice()
    const onBikeData = vi.fn()
    await openFtmsSession(fake.device, { onBikeData })
    fake.status.fire(view(0xff))
    expect(onBikeData).not.toHaveBeenCalled()
  })
})

describe("FtmsSession dispose", () => {
  it("detaches every listener and stops every notification stream", async () => {
    const fake = fakeDevice()
    const session = await openFtmsSession(fake.device, fakeHandlers())
    await session.dispose()

    expect(fake.calls).toContain("cp:removeEventListener")
    expect(fake.calls).toContain("status:removeEventListener")
    expect(fake.calls).toContain("bike:removeEventListener")
    expect(fake.calls).toContain("cp:stopNotifications")
    expect(fake.calls).toContain("status:stopNotifications")
    expect(fake.calls).toContain("bike:stopNotifications")
    expect(fake.cp.listeners).toHaveLength(0)
    expect(fake.status.listeners).toHaveLength(0)
    expect(fake.bike.listeners).toHaveLength(0)
  })

  it("swallows a stopNotifications failure - the link may already be gone", async () => {
    const fake = fakeDevice({ statusStopError: new Error("GATT server disconnected") })
    const session = await openFtmsSession(fake.device, fakeHandlers())
    await expect(session.dispose()).resolves.toBeUndefined()
    expect(fake.calls).toContain("bike:stopNotifications")
  })

  it("rejects the in-flight op", async () => {
    const fake = fakeDevice({ auto: false })
    const session = await openFtmsSession(fake.device, fakeHandlers())
    const pending = session.setTargetPower(100)
    await flush()
    const asserted = expect(pending).rejects.toThrow(/disposed/i)
    await session.dispose()
    await asserted
  })

  it("is idempotent", async () => {
    const fake = fakeDevice()
    const session = await openFtmsSession(fake.device, fakeHandlers())
    await session.dispose()
    const after = fake.calls.length
    await session.dispose()
    expect(fake.calls.length).toBe(after)
  })

  it("refuses further ops once disposed", async () => {
    const fake = fakeDevice()
    const session = await openFtmsSession(fake.device, fakeHandlers())
    await session.dispose()
    await expect(session.start()).rejects.toThrow(/disposed/i)
    expect(fake.written).toEqual([])
  })
})
