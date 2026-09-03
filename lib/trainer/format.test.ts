import { describe, expect, it } from "vitest"
import { mmss } from "./format"

describe("mmss", () => {
  it("formats zero as a padded clock", () => {
    expect(mmss(0)).toBe("00:00")
  })

  it("pads both fields to two digits", () => {
    expect(mmss(65)).toBe("01:05")
    expect(mmss(9)).toBe("00:09")
    expect(mmss(600)).toBe("10:00")
  })

  it("keeps counting minutes past an hour rather than adding an hours field", () => {
    expect(mmss(3600)).toBe("60:00")
    expect(mmss(7265)).toBe("121:05")
  })

  it("floors fractional seconds, as a stopwatch does", () => {
    // 01:05 stays on screen for the whole of the 65th second - rounding would
    // show 01:06 while a countdown still had half a second left on it.
    expect(mmss(65.9)).toBe("01:05")
    expect(mmss(0.999)).toBe("00:00")
    expect(mmss(59.5)).toBe("00:59")
  })

  it("clamps anything negative to zero", () => {
    // A remaining-time readout goes slightly negative between a boundary and the
    // tick that notices it; "-1:-1" is not a thing a bench display may show.
    expect(mmss(-0.5)).toBe("00:00")
    expect(mmss(-90)).toBe("00:00")
  })

  it("survives a non-finite input rather than rendering NaN", () => {
    expect(mmss(Number.NaN)).toBe("00:00")
    expect(mmss(Number.POSITIVE_INFINITY)).toBe("00:00")
  })
})
