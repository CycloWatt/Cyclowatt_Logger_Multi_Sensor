import { describe, expect, it } from "vitest"
import { manualModeFor, subModeFor } from "./mode"

describe("manualModeFor", () => {
  it("maps power to manual-power", () => expect(manualModeFor("power")).toBe("manual-power"))
  it("maps resistance to manual-resistance", () => expect(manualModeFor("resistance")).toBe("manual-resistance"))
})

describe("subModeFor", () => {
  it("maps manual-resistance to resistance", () => expect(subModeFor("manual-resistance")).toBe("resistance"))
  it("maps manual-power to power", () => expect(subModeFor("manual-power")).toBe("power"))
  it("defaults protocol to power, pinning today's ternary default", () => expect(subModeFor("protocol")).toBe("power"))
})
