import { describe, expect, it } from "vitest"
import { parseIndoorBikeData } from "./indoor-bike-data"

const view = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer)

describe("parseIndoorBikeData", () => {
  it("decodes speed, cadence and power when bit 0 is clear", () => {
    // flags 0x0044: bit 2 (cadence) + bit 6 (power). Bit 0 clear -> speed present.
    const data = parseIndoorBikeData(
      view(0x44, 0x00, 0xc4, 0x09 /* speed 2500 */, 0xb4, 0x00 /* cadence 180 */, 0xfa, 0x00 /* power 250 */),
    )
    expect(data).toEqual({
      speedKmh: 25,
      averageSpeedKmh: null,
      cadenceRpm: 90,
      averageCadenceRpm: null,
      totalDistanceM: null,
      resistanceLevel: null,
      powerW: 250,
      averagePowerW: null,
      heartRateBpm: null,
      elapsedS: null,
      remainingS: null,
    })
  })

  it("omits speed and shifts cadence to offset 2 when bit 0 (More Data) is set", () => {
    // flags 0x0045: bit 0 (more data) + bit 2 (cadence) + bit 6 (power).
    const data = parseIndoorBikeData(
      view(0x45, 0x00, 0xb4, 0x00 /* cadence 180 */, 0xfa, 0x00 /* power 250 */),
    )
    expect(data?.speedKmh).toBeNull()
    expect(data?.cadenceRpm).toBe(90)
    expect(data?.powerW).toBe(250)
  })

  it("reads heart rate right after power when energy is not flagged", () => {
    // flags 0x0245: bit 0 (more data, so speed is skipped) + bit 2 (cadence) + bit 6 (power) + bit 9 (heart rate).
    const data = parseIndoorBikeData(
      view(
        0x45,
        0x02,
        0xb4,
        0x00 /* cadence 180 */,
        0xfa,
        0x00 /* power 250 */,
        0x8c /* heart rate 140 */,
      ),
    )
    expect(data?.cadenceRpm).toBe(90)
    expect(data?.powerW).toBe(250)
    expect(data?.heartRateBpm).toBe(140)
  })

  it("skips the 5 expended-energy bytes before heart rate", () => {
    // flags 0x0345: bit 0 (more data) + bit 2 (cadence) + bit 6 (power) + bit 8 (energy) + bit 9 (heart rate).
    const data = parseIndoorBikeData(
      view(
        0x45,
        0x03,
        0xb4,
        0x00 /* cadence 180 */,
        0xfa,
        0x00 /* power 250 */,
        0xe8,
        0x03 /* total energy kcal - ignored */,
        0x64,
        0x00 /* energy per hour - ignored */,
        0x05 /* energy per minute - ignored */,
        0x8c /* heart rate 140 */,
      ),
    )
    expect(data?.cadenceRpm).toBe(90)
    expect(data?.powerW).toBe(250)
    expect(data?.heartRateBpm).toBe(140)
  })

  it("preserves a negative power reading", () => {
    // flags 0x0041: bit 0 (more data) + bit 6 (power) only.
    const data = parseIndoorBikeData(view(0x41, 0x00, 0xff, 0xff /* power -1 */))
    expect(data?.powerW).toBe(-1)
  })

  it("preserves a negative resistance level", () => {
    // flags 0x0021: bit 0 (more data) + bit 5 (resistance level) only.
    const data = parseIndoorBikeData(view(0x21, 0x00, 0xce, 0xff /* resistance -50 */))
    expect(data?.resistanceLevel).toBe(-50)
  })

  it("reads a uint24 total distance", () => {
    // flags 0x0011: bit 0 (more data) + bit 4 (total distance) only. 0x012345 LE -> 0x45, 0x23, 0x01.
    const data = parseIndoorBikeData(view(0x11, 0x00, 0x45, 0x23, 0x01))
    expect(data?.totalDistanceM).toBe(0x012345)
    expect(data?.totalDistanceM).toBe(74565)
  })

  it("reads elapsed and remaining time", () => {
    // flags 0x1801: bit 0 (more data) + bit 11 (elapsed time) + bit 12 (remaining time).
    const data = parseIndoorBikeData(
      view(0x01, 0x18, 0x2c, 0x01 /* elapsed 300s */, 0x58, 0x02 /* remaining 600s */),
    )
    expect(data?.elapsedS).toBe(300)
    expect(data?.remainingS).toBe(600)
  })

  it("returns null when the payload ends before a flagged field", () => {
    // flags 0x0041 (more data + power) but the buffer is one byte short of the int16.
    expect(parseIndoorBikeData(view(0x41, 0x00, 0xfa))).toBeNull()
  })

  it("returns null-filled fields for a flags-only payload with bit 0 set, without throwing", () => {
    const data = parseIndoorBikeData(view(0x01, 0x00))
    expect(data).toEqual({
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
    })
  })

  it("returns null for a payload shorter than the flags word", () => {
    expect(parseIndoorBikeData(view(0x00))).toBeNull()
  })
})
