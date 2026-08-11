import { describe, expect, it } from "vitest"
import { firmwareVersionFromName } from "./device-name"

describe("firmwareVersionFromName", () => {
  it.each([
    ["Cyclowatt L v0.2.2", "0.2.2"],
    ["Cyclowatt R v0.2.2", "0.2.2"],
    ["Cyclowatt v10.20.30", "10.20.30"],
  ])("extracts from %s", (name, version) => expect(firmwareVersionFromName(name)).toBe(version))
  it.each([["CycloRaw"], ["Cyclowatt L"], [""], [null], [undefined], ["v0.2.2suffix"]])(
    "returns null for %s", (name) => expect(firmwareVersionFromName(name as string | null | undefined)).toBeNull(),
  )
})
