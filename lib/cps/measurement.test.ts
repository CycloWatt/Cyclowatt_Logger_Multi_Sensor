import { describe, expect, it } from "vitest"
import { parseCyclingPowerMeasurement } from "./measurement"

/** A DataView over the given bytes, which is what a characteristic read hands back. */
const view = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer)

describe("parseCyclingPowerMeasurement", () => {
  it("reads instantaneous power as a little-endian sint16 at offset 2", () => {
    expect(parseCyclingPowerMeasurement(view(0x00, 0x00, 0xfa, 0x00))).toBe(250)
  })

  it("preserves a negative power reading", () => {
    // -10 W as sint16 little-endian: 0xfff6.
    expect(parseCyclingPowerMeasurement(view(0x00, 0x00, 0xf6, 0xff))).toBe(-10)
  })

  it("returns null for a view shorter than 4 bytes", () => {
    expect(parseCyclingPowerMeasurement(view(0x00, 0x00, 0xfa))).toBeNull()
  })

  it("still reads offset 2 when the payload carries extra trailing fields", () => {
    // Flags declaring extra fields don't change where power lives - this parser
    // ignores the flags word entirely (see the header comment on the module).
    expect(parseCyclingPowerMeasurement(view(0xff, 0xff, 0xfa, 0x00, 0x01, 0x02, 0x03))).toBe(250)
  })
})
