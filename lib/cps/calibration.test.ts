import { afterEach, describe, expect, it, vi } from "vitest"
import { CALIBRATION_TIMEOUT_MS, runOffsetCompensation } from "./calibration"
import { CPS_CONTROL_POINT_CHAR_UUID, CPS_FEATURE_CHAR_UUID, CPS_SERVICE_UUID } from "./protocol"

const view = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer)

/** A success indication carrying `offset` Newtons. */
const successFor = (offset: number) => {
  const dv = new DataView(new Uint8Array(5).buffer)
  dv.setUint8(0, 0x20)
  dv.setUint8(1, 0x0c)
  dv.setUint8(2, 0x01)
  dv.setInt16(3, offset, true)
  return dv
}

/** The feature word this firmware advertises, with bit 9 set. */
const FEATURE_SUPPORTED = view(0x09, 0x12, 0x10, 0x00)
/** Same shape, bit 9 clear - an image from before calibration landed. */
const FEATURE_UNSUPPORTED = view(0x09, 0x10, 0x10, 0x00)

interface FakeOptions {
  feature?: DataView
  /** Called when the command is written; use it to answer the way the board would. */
  onWrite?: (fire: (value: DataView) => void) => void
  writeError?: Error
  startError?: Error
}

/**
 * A device whose CPS characteristics are fakes, plus an ordered log of the calls
 * made against the control point - the ORDER is a behaviour under test, not a
 * detail, because a listener attached after the write can miss a fast answer.
 */
function fakeDevice(options: FakeOptions = {}) {
  const calls: string[] = []
  const written: number[][] = []
  const listeners: Array<(event: Event) => void> = []

  const fire = (value: DataView) => {
    // Web Bluetooth delivers the payload as event.target.value.
    const event = { target: { value } } as unknown as Event
    for (const listener of [...listeners]) listener(event)
  }

  const controlPoint = {
    readValue: async () => view(),
    startNotifications: async () => {
      calls.push("startNotifications")
      if (options.startError) throw options.startError
    },
    stopNotifications: async () => {
      calls.push("stopNotifications")
    },
    addEventListener: (_type: string, listener: (event: Event) => void) => {
      calls.push("addEventListener")
      listeners.push(listener)
    },
    removeEventListener: (_type: string, listener: (event: Event) => void) => {
      calls.push("removeEventListener")
      const at = listeners.indexOf(listener)
      if (at >= 0) listeners.splice(at, 1)
    },
    writeValueWithResponse: async (value: BufferSource) => {
      calls.push("write")
      written.push(Array.from(new Uint8Array(value as ArrayBuffer)))
      if (options.writeError) throw options.writeError
      options.onWrite?.(fire)
    },
  }

  const feature = {
    ...controlPoint,
    readValue: async () => options.feature ?? FEATURE_SUPPORTED,
  }

  const requested: string[] = []
  const server = {
    connected: true,
    connect: async () => server,
    getPrimaryService: async (uuid: string) => {
      requested.push(uuid)
      return {
        getCharacteristic: async (charUuid: string) => {
          requested.push(charUuid)
          return charUuid === CPS_FEATURE_CHAR_UUID ? feature : controlPoint
        },
      }
    },
  }

  return { device: { gatt: server }, calls, written, requested, fire, listeners }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("runOffsetCompensation", () => {
  it("resolves the offset the board reports", async () => {
    const { device } = fakeDevice({ onWrite: (fire) => fire(successFor(42)) })
    await expect(runOffsetCompensation(device)).resolves.toBe(42)
  })

  it("resolves a negative offset unchanged", async () => {
    const { device } = fakeDevice({ onWrite: (fire) => fire(successFor(-7)) })
    await expect(runOffsetCompensation(device)).resolves.toBe(-7)
  })

  it("writes exactly the one opcode byte", async () => {
    const { device, written } = fakeDevice({ onWrite: (fire) => fire(successFor(1)) })
    await runOffsetCompensation(device)
    expect(written).toEqual([[0x0c]])
  })

  it("enables indications and attaches the listener BEFORE writing", async () => {
    // The ordering hazard this module exists to get right. The firmware can answer
    // a fast-failing procedure before writeValueWithResponse resolves, so a
    // listener attached afterwards misses the response and hangs until timeout.
    // Indications must also precede the write or the firmware rejects it outright
    // with ATT 0xFD CCC Improperly Configured.
    const { device, calls } = fakeDevice({ onWrite: (fire) => fire(successFor(1)) })
    await runOffsetCompensation(device)
    expect(calls.indexOf("addEventListener")).toBeLessThan(calls.indexOf("write"))
    expect(calls.indexOf("startNotifications")).toBeLessThan(calls.indexOf("write"))
  })

  it("catches a response that arrives during the write itself", async () => {
    // Same hazard from the other side: the fake answers synchronously inside
    // write, which is the worst case for a late listener.
    const { device } = fakeDevice({ onWrite: (fire) => fire(successFor(5)) })
    await expect(runOffsetCompensation(device)).resolves.toBe(5)
  })

  it("asks for the right service and characteristics", async () => {
    const { device, requested } = fakeDevice({ onWrite: (fire) => fire(successFor(1)) })
    await runOffsetCompensation(device)
    expect(requested).toContain(CPS_SERVICE_UUID)
    expect(requested).toContain(CPS_FEATURE_CHAR_UUID)
    expect(requested).toContain(CPS_CONTROL_POINT_CHAR_UUID)
  })

  it("refuses before writing when the board does not declare support", async () => {
    // The board's own declaration is a better error than an opaque write failure.
    const { device, calls } = fakeDevice({ feature: FEATURE_UNSUPPORTED })
    await expect(runOffsetCompensation(device)).rejects.toThrow(/does not support/i)
    expect(calls).not.toContain("write")
  })

  it("rejects with the response code named when the board refuses", async () => {
    const { device } = fakeDevice({ onWrite: (fire) => fire(view(0x20, 0x0c, 0x04)) })
    await expect(runOffsetCompensation(device)).rejects.toThrow(/operation failed/i)
  })

  it("rejects when a success response carries no offset", async () => {
    // Reporting "calibrated" with nothing to show would be worse than an error.
    const { device } = fakeDevice({ onWrite: (fire) => fire(view(0x20, 0x0c, 0x01)) })
    await expect(runOffsetCompensation(device)).rejects.toThrow(/without an offset/i)
  })

  it("ignores another procedure's response and keeps waiting", async () => {
    // Crank-length writes answer on this same characteristic. Resolving on one
    // would report a crank length as an offset.
    vi.useFakeTimers()
    const { device, fire } = fakeDevice({
      onWrite: () => {
        fire(view(0x20, 0x04, 0x01, 0xaa, 0x00)) // crank length, not ours
      },
    })
    const pending = runOffsetCompensation(device, { timeoutMs: 1000 })
    const asserted = expect(pending).rejects.toThrow(/did not answer/i)
    await vi.advanceTimersByTimeAsync(1000)
    await asserted
  })

  it("ignores an unparseable indication and keeps waiting", async () => {
    vi.useFakeTimers()
    const { device, fire } = fakeDevice({
      onWrite: () => {
        fire(view(0x99)) // not a Response Code payload at all
      },
    })
    const pending = runOffsetCompensation(device, { timeoutMs: 1000 })
    const asserted = expect(pending).rejects.toThrow(/did not answer/i)
    await vi.advanceTimersByTimeAsync(1000)
    await asserted
  })

  it("times out when the board never answers", async () => {
    vi.useFakeTimers()
    const { device } = fakeDevice({ onWrite: () => {} })
    const pending = runOffsetCompensation(device, { timeoutMs: 1000 })
    const asserted = expect(pending).rejects.toThrow(/did not answer/i)
    await vi.advanceTimersByTimeAsync(1000)
    await asserted
  })

  it("defaults to a timeout longer than the firmware's own 5 s guard", async () => {
    // So the board's OPERATION_FAILED answer wins the race and the operator sees a
    // real response code instead of a client-side give-up.
    expect(CALIBRATION_TIMEOUT_MS).toBeGreaterThan(5000)
  })

  it("detaches the listener and stops indications after success", async () => {
    const { device, calls, listeners } = fakeDevice({ onWrite: (fire) => fire(successFor(3)) })
    await runOffsetCompensation(device)
    expect(calls).toContain("removeEventListener")
    expect(calls).toContain("stopNotifications")
    expect(listeners).toHaveLength(0)
  })

  it("detaches the listener and stops indications after a rejection too", async () => {
    // A leaked listener would let the NEXT calibration resolve from this one's
    // late answer.
    const { device, calls, listeners } = fakeDevice({
      onWrite: (fire) => fire(view(0x20, 0x0c, 0x04)),
    })
    await expect(runOffsetCompensation(device)).rejects.toThrow()
    expect(calls).toContain("removeEventListener")
    expect(calls).toContain("stopNotifications")
    expect(listeners).toHaveLength(0)
  })

  it("surfaces a write failure, which is how ATT errors arrive", async () => {
    // 0xFD (CCC improperly configured) and 0xFE (procedure already in progress)
    // both reach the page as a rejected write.
    const { device } = fakeDevice({
      writeError: new DOMException("GATT operation failed for unknown reason.", "NetworkError"),
    })
    await expect(runOffsetCompensation(device)).rejects.toThrow(/GATT operation failed/)
  })

  it("cleans up when enabling indications fails", async () => {
    const { device, calls } = fakeDevice({ startError: new Error("notifications unsupported") })
    await expect(runOffsetCompensation(device)).rejects.toThrow(/notifications unsupported/)
    expect(calls).toContain("removeEventListener")
  })

  it("rejects a device with no GATT interface", async () => {
    await expect(runOffsetCompensation({ gatt: null })).rejects.toThrow(/GATT/i)
    await expect(runOffsetCompensation(null)).rejects.toThrow(/GATT/i)
  })

  it("connects first when the link is down", async () => {
    const { device } = fakeDevice({ onWrite: (fire) => fire(successFor(8)) })
    device.gatt.connected = false
    let connected = false
    const originalConnect = device.gatt.connect
    device.gatt.connect = async () => {
      connected = true
      return originalConnect()
    }
    await expect(runOffsetCompensation(device)).resolves.toBe(8)
    expect(connected).toBe(true)
  })
})
