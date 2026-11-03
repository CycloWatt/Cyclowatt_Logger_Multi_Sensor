import { expect, it } from "vitest"
import { cadenceCue } from "./cadence-guidance"
import { validateSteps } from "./presets"
it("cues only outside the five RPM tolerance", () => {
  expect(cadenceCue(90, 84)).toBe("Pedal faster")
  expect(cadenceCue(90, 85)).toBe("On target")
  expect(cadenceCue(90, 95)).toBe("On target")
  expect(cadenceCue(90, 96)).toBe("Pedal slower")
})
it("does not give pacing instructions without a target or fresh measurement", () => {
  expect(cadenceCue(undefined, 80)).toContain("Set a cadence target")
  expect(cadenceCue(90, null)).toContain("Waiting")
})
it("allows legacy steps and rejects invalid cadence targets", () => {
  const step = { targetWatts: 138, durationSeconds: 60 }
  expect(validateSteps([step])).toBeNull()
  expect(validateSteps([{ ...step, targetCadenceRpm: 90 }])).toBeNull()
  expect(validateSteps([{ ...step, targetCadenceRpm: 0 }])).not.toBeNull()
  expect(validateSteps([{ ...step, targetCadenceRpm: NaN }])).not.toBeNull()
})
