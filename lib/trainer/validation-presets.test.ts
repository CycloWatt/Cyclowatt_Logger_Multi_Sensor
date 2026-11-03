import { expect, it } from "vitest"
import { validationPresets, presetsForFtp, validTestFtp } from "./validation-presets"

it("scales watts and manual guidance while preserving cadence and timing", () => {
  const low = validationPresets(200)
  const high = validationPresets(300)
  expect(low[0].steps.map(s => s.targetWatts)).toEqual([110,80,110,140,170,140,110,80,110])
  expect(high[0].steps.map(s => s.targetWatts)).toEqual([165,120,165,210,255,210,165,120,165])
  expect(high.map(p => p.steps.map(s => [s.durationSeconds,s.targetCadenceRpm])))
    .toEqual(low.map(p => p.steps.map(s => [s.durationSeconds,s.targetCadenceRpm])))
  expect(high[4].manualGuide?.join(" ")).toContain("450–600 W")
  expect(high[5].manualGuide?.join(" ")).toContain("165 W")
})
it("does not mutate previous targets or rescale custom copies", () => {
  const original = validationPresets(250)
  const custom = { ...original[0], builtIn: false, id: "custom", name: "Saved rider" }
  const updated = presetsForFtp([...original, custom],200)
  expect(original[0].steps[0].targetWatts).toBe(138)
  expect(updated[0].steps[0].targetWatts).toBe(110)
  expect(updated.at(-1)).toBe(custom)
})
it("rejects blank-equivalent, negative, fractional and non-finite FTP", () => {
  for(const value of [0,-1,250.5,NaN,Infinity,2001]) {
    expect(validTestFtp(value)).toBe(false)
    expect(() => validationPresets(value)).toThrow()
  }
  expect(validTestFtp(250)).toBe(true)
})
