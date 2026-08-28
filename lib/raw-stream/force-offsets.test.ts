import { describe, expect, it } from "vitest"
import {
  FORCE_OFFSETS_CHAR_UUID,
  FORCE_OFFSETS_WIRE_LEN,
  RAW_STREAM_SERVICE_UUID,
  decodeForceOffsets,
  readForceOffsets,
} from "./force-offsets"

/** A DataView over the given bytes, which is what a characteristic read hands back. */
const view = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer)

/** Little-endian bytes of a signed 16-bit value, the way the firmware packs one. */
const le16 = (value: number) => [value & 0xff, (value >> 8) & 0xff]

/** A full valid packet with the six channels set to the given millivolt values. */
const packet = (calibrated: number, offsets: number[]) => view(calibrated, ...offsets.flatMap(le16))

describe("decodeForceOffsets", () => {
  it("reads the six channels in wire order", () => {
    expect(decodeForceOffsets(packet(1, [10, 20, 30, 40, 50, 60]))).toEqual({
      calibrated: true,
      offsetsMv: [10, 20, 30, 40, 50, 60],
    })
  })

  it("reads offsets SIGNED", () => {
    // A real tare can be negative. An unsigned read would report about 65536 too
    // high - the same trap the Cycling Power decoder already guards against, and
    // the reason both ends of this wire are pinned on it.
    const decoded = decodeForceOffsets(packet(1, [-1, -300, -32768, 32767, 0, 7]))
    expect(decoded?.offsetsMv).toEqual([-1, -300, -32768, 32767, 0, 7])
  })

  it("reports an uncalibrated board as uncalibrated", () => {
    // The whole reason the flag exists: these zeros are the uncalibrated default,
    // not a measured result, and nothing in the values themselves says so.
    expect(decodeForceOffsets(packet(0, [0, 0, 0, 0, 0, 0]))).toEqual({
      calibrated: false,
      offsetsMv: [0, 0, 0, 0, 0, 0],
    })
  })

  it("treats any non-zero flag byte as calibrated", () => {
    // The firmware sends 1, but a decoder that only accepts 1 would silently
    // mis-report a future non-zero encoding as "never calibrated".
    expect(decodeForceOffsets(packet(2, [1, 2, 3, 4, 5, 6]))?.calibrated).toBe(true)
  })

  it("returns null for a short packet rather than reading past the end", () => {
    expect(decodeForceOffsets(view(1, 0, 0))).toBeNull()
  })

  it("pins the packet length as an external contract", () => {
    expect(FORCE_OFFSETS_WIRE_LEN).toBe(13)
  })
})

describe("readForceOffsets", () => {
  /** A device whose characteristic read returns the given packet. */
  const deviceServing = (value: DataView) => ({
    gatt: {
      connected: true,
      connect: async () => {
        throw new Error("should not reconnect an already-connected device")
      },
      getPrimaryService: async (uuid: string) => {
        expect(uuid).toBe(RAW_STREAM_SERVICE_UUID)
        return {
          getCharacteristic: async (charUuid: string) => {
            expect(charUuid).toBe(FORCE_OFFSETS_CHAR_UUID)
            return { readValue: async () => value }
          },
        }
      },
    },
  })

  /** A device whose service lookup fails with the given error. */
  const deviceFailingWith = (err: Error) => ({
    gatt: {
      connected: true,
      connect: async () => {
        throw new Error("should not reconnect an already-connected device")
      },
      getPrimaryService: async () => {
        throw err
      },
    },
  })

  it("resolves the decoded report", async () => {
    const report = await readForceOffsets(deviceServing(packet(1, [1, 2, 3, 4, 5, 6])))
    expect(report).toEqual({ calibrated: true, offsetsMv: [1, 2, 3, 4, 5, 6] })
  })

  it("resolves null when the board has no raw-stream service", async () => {
    // A production image genuinely has no such service. That is the EXPECTED path
    // for a customer board, not an error, so it must not reject.
    const notFound = Object.assign(new Error("No Services matching UUID"), {
      name: "NotFoundError",
    })
    await expect(readForceOffsets(deviceFailingWith(notFound))).resolves.toBeNull()
  })

  it("rejects on a failure that is NOT an absent service", async () => {
    // A GATT error meaning something actually went wrong must stay visible.
    // Swallowing every failure as "must be a production board" would hide real
    // breakage behind a plausible explanation.
    const device = deviceFailingWith(new Error("GATT operation failed for unknown reason"))
    await expect(readForceOffsets(device)).rejects.toThrow(/unknown reason/)
  })

  it("resolves null when there is no device at all", async () => {
    await expect(readForceOffsets(null)).resolves.toBeNull()
  })
})
