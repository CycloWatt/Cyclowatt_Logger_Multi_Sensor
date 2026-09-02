import { describe, expect, it, vi } from "vitest"
import { EXPECTED_PACKET_SIZE, packetTimeLabel, parseDataPacket, type DataPoint } from "./packet"

/**
 * A raw-stream packet built from its 16 little-endian 32-bit slots, which is
 * exactly what the firmware puts on the wire (`raw_stream_wire.c` packs slot i
 * to wire slot i). Slots default to 0 so a test only states what it cares about.
 */
const packet = (slots: Partial<Record<number, number>>, size = EXPECTED_PACKET_SIZE) => {
  const view = new DataView(new ArrayBuffer(size))
  for (const [index, value] of Object.entries(slots)) {
    // setUint32 with the >>> 0 conversion so a test can state either a signed
    // force (-1) or a raw unsigned tick word (0xffffffff) in the same table.
    view.setUint32(Number(index) * 4, (value as number) >>> 0, true)
  }
  return view
}

const ctx = { timestamp: new Date(2026, 0, 1, 0, 5, 7, 300), referencePower: 0, synchronization: 0 }

describe("EXPECTED_PACKET_SIZE", () => {
  it("is 16 x int32", () => {
    expect(EXPECTED_PACKET_SIZE).toBe(64)
  })
})

describe("packetTimeLabel", () => {
  it("formats MM:SS.tenth with both fields zero-padded", () => {
    expect(packetTimeLabel(new Date(2026, 0, 1, 0, 5, 7, 300))).toBe("05:07.3")
  })

  it("truncates the tenth rather than rounding it", () => {
    expect(packetTimeLabel(new Date(2026, 0, 1, 12, 34, 56, 987))).toBe("34:56.9")
    expect(packetTimeLabel(new Date(2026, 0, 1, 12, 34, 56, 50))).toBe("34:56.0")
  })

  it("shows the MINUTE of the hour, not an elapsed time", () => {
    // The hour is deliberately absent from the axis label; only minutes and
    // seconds within the hour are shown.
    expect(packetTimeLabel(new Date(2026, 0, 1, 23, 59, 59, 999))).toBe("59:59.9")
  })
})

describe("parseDataPacket", () => {
  it("reads the six force channels in wire order, signed and unscaled", () => {
    const point = parseDataPacket(packet({ 0: 100, 1: -200, 2: 300, 3: -400, 4: 500, 5: -600 }), ctx)
    expect(point).not.toBeNull()
    expect([
      point!.force0,
      point!.force1,
      point!.force2,
      point!.force3,
      point!.force4,
      point!.force5,
    ]).toEqual([100, -200, 300, -400, 500, -600])
  })

  it("divides accel by 1000 - the wire carries milli-g", () => {
    const point = parseDataPacket(packet({ 6: 1500, 7: -1500, 8: 0 }), ctx)
    expect([point!.accelX, point!.accelY, point!.accelZ]).toEqual([1.5, -1.5, 0])
  })

  it("divides gyro by 1000 - the wire carries milli-rad/s", () => {
    const point = parseDataPacket(packet({ 9: -250, 10: 250, 11: 1 }), ctx)
    expect([point!.gyroX, point!.gyroY, point!.gyroZ]).toEqual([-0.25, 0.25, 0.001])
  })

  it("carries the power slot and the tick through unscaled", () => {
    const point = parseDataPacket(packet({ 12: 42, 13: 123456 }), ctx)
    expect(point!.power).toBe(42)
    expect(point!.tick).toBe(123456)
  })

  it("recomposes ticks_mcu from the low/high uint32 pair", () => {
    expect(parseDataPacket(packet({ 14: 0, 15: 1 }), ctx)!.ticksMcu).toBe(4294967296)
    expect(parseDataPacket(packet({ 14: 5, 15: 2 }), ctx)!.ticksMcu).toBe(8589934597)
  })

  it("reads the ticks_mcu words UNSIGNED", () => {
    // A signed read of the low word would report -1 here instead of 2^32 - 1.
    expect(parseDataPacket(packet({ 14: 0xffffffff, 15: 0 }), ctx)!.ticksMcu).toBe(4294967295)
  })

  it("recomposes ticks_mcu exactly up to the double's safe range", () => {
    // 0x001fffff_ffffffff is 2^53 - 1: the largest tick count Number() still
    // represents exactly, which is why the BigInt shift comes first.
    expect(parseDataPacket(packet({ 14: 0xffffffff, 15: 0x001fffff }), ctx)!.ticksMcu).toBe(9007199254740991)
  })

  it("stamps the timestamp and its pre-formatted chart label", () => {
    const at = new Date(2026, 0, 1, 0, 5, 7, 300)
    const point = parseDataPacket(packet({}), { timestamp: at, referencePower: 0, synchronization: 0 })
    expect(point!.timestamp).toBe(at.getTime())
    expect(point!.timeLabel).toBe("05:07.3")
  })

  it("stamps the caller's reference power and synchronization value", () => {
    // Neither is on the wire: reference power comes from the CPS reference
    // trainer and synchronization from the serial line, and both are stamped
    // per packet so a capture can be aligned afterwards.
    const point = parseDataPacket(packet({}), { timestamp: ctx.timestamp, referencePower: 217, synchronization: 9 })
    expect(point!.referencePower).toBe(217)
    expect(point!.synchronization).toBe(9)
  })

  it("returns null and warns on a wrong-sized packet", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(parseDataPacket(packet({}, 32), ctx)).toBeNull()
      expect(parseDataPacket(packet({}, 68), ctx)).toBeNull()
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it("produces the full DataPoint shape for one fully-populated packet", () => {
    const point = parseDataPacket(
      packet({
        0: 1,
        1: 2,
        2: 3,
        3: 4,
        4: 5,
        5: 6,
        6: 1500,
        7: -1500,
        8: 9810,
        9: -250,
        10: 250,
        11: 0,
        12: 7,
        13: 99,
        14: 0,
        15: 1,
      }),
      { timestamp: new Date(2026, 0, 1, 0, 5, 7, 300), referencePower: 150, synchronization: 3 },
    )
    const expected: DataPoint = {
      timestamp: new Date(2026, 0, 1, 0, 5, 7, 300).getTime(),
      timeLabel: "05:07.3",
      tick: 99,
      ticksMcu: 4294967296,
      force0: 1,
      force1: 2,
      force2: 3,
      force3: 4,
      force4: 5,
      force5: 6,
      accelX: 1.5,
      accelY: -1.5,
      accelZ: 9.81,
      gyroX: -0.25,
      gyroY: 0.25,
      gyroZ: 0,
      power: 7,
      referencePower: 150,
      synchronization: 3,
    }
    expect(point).toEqual(expected)
  })
})
